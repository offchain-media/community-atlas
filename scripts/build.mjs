/**
 * Build a static edition of the Community Atlas from a profile and the harvested sources.
 *
 *   node scripts/build.mjs [--profile profiles/offchain-media] [--out public]
 *
 * Output mirrors the public URL paths, so `public/` can be uploaded as is
 * (Cloudflare Workers static assets, GitHub Pages, any static host).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, SOURCES, readJSON } from "./lib/io.mjs";
import { bbox, inBbox, inShape, shape } from "./lib/geo.mjs";
import { dedupe, groupEvents, toICS } from "../src/shared/events.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: process.env.ATLAS_PROFILE || "profiles/offchain-media" },
    out: { type: "string", default: "public" },
    now: { type: "string" },
  },
});
const PROFILE_DIR = resolve(ROOT, values.profile);
const OUT = resolve(ROOT, values.out);
const NOW = values.now ? Date.parse(values.now) : Date.now();
const profile = await readJSON(join(PROFILE_DIR, "profile.json"));
validateProfile(profile);

const ASSETS = profile.assetsPath || profile.languages[0].path;
const at = (...p) => join(OUT, ASSETS, ...p);
const url = (path) => new URL(path, profile.origin).href;

/* ---------- helpers ---------- */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
function safeURL(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function validateProfile(p) {
  const problems = [];
  if (!p.name) problems.push("name is required");
  if (!safeURL(p.origin) || new URL(p.origin).pathname !== "/") problems.push("origin must be an https origin without a path");
  if (!Array.isArray(p.languages) || !p.languages.length) problems.push("languages needs at least 1 entry");
  for (const l of p.languages || []) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(l.code || "")) problems.push(`language code ${l.code} is invalid`);
    if (!/^\/([\w.-]+\/)*$/.test(l.path || "")) problems.push(`language path ${l.path} must start and end with /`);
    if (!existsSync(resolve(ROOT, "src/i18n", l.code + ".json"))) problems.push(`no interface strings for ${l.code} in src/i18n/`);
  }
  if (p.assetsPath && !/^\/([\w.-]+\/)*$/.test(p.assetsPath)) problems.push("assetsPath must start and end with /");
  const scope = p.scope?.type;
  if (!["world", "countries", "bbox"].includes(scope)) problems.push("scope.type must be world, countries or bbox");
  if (problems.length) throw new Error("Profile problems:\n- " + problems.join("\n- "));
}

/* ---------- data ---------- */

const src = async (name, empty) => readJSON(join(SOURCES, name), empty);
const merchantsSrc = await src("btcmap-merchants.json", { places: [] });
const communitiesSrc = await src("btcmap-communities.json", { communities: [] });
const countriesSrc = await src("btcmap-countries.json", { countries: [] });
const meta = await src("meta.json", {});
const S = profile.sources || {};

// Scope: the whole world, a list of countries (BTC Map shapes) or a bounding box.
let inScope = () => true;
if (profile.scope.type === "countries") {
  const wanted = new Set(profile.scope.countries.map((c) => c.toUpperCase()));
  const shapes = countriesSrc.countries
    .filter((c) => wanted.has(c.code))
    .map((c) => shape({ type: "MultiPolygon", coordinates: c.polygons }));
  if (!shapes.length) throw new Error("No country shapes found for scope; run npm run harvest first");
  inScope = (lon, lat, country) =>
    country ? wanted.has(country) : Number.isFinite(lon) && shapes.some((s) => inShape(lon, lat, s));
} else if (profile.scope.type === "bbox") {
  inScope = (lon, lat) => Number.isFinite(lon) && inBbox(lon, lat, profile.scope.bbox);
}
const scoped = (x) => inScope(x.lon, x.lat, x.country);

// Country of each place, for country filters and embeds (largest-polygon box first, then exact test).
const countryShapes = countriesSrc.countries.map((c) => {
  const largest = c.polygons.reduce((a, b) => (b[0].length > a[0].length ? b : a), [[]]);
  return {
    code: c.code,
    s: shape({ type: "MultiPolygon", coordinates: c.polygons }),
    main: bbox({ type: "Polygon", coordinates: largest }),
  };
});
let lastCountry = null;
function countryAt(lon, lat) {
  if (lastCountry && inShape(lon, lat, lastCountry.s)) return lastCountry.code;
  const hit = countryShapes.find((c) => inShape(lon, lat, c.s));
  lastCountry = hit || lastCountry;
  return hit?.code || "";
}
const places = S.merchants
  ? merchantsSrc.places.filter(([, lon, lat]) => inScope(lon, lat)).map((p) => [...p.slice(0, 5), countryAt(p[1], p[2])])
  : [];
const communities = S.communities !== false ? communitiesSrc.communities.filter(scoped) : [];

const curated = (await readJSON(join(PROFILE_DIR, "events.json"), [])).map((e) => ({
  source: "curated",
  sourceName: profile.publisher?.name || profile.name,
  status: e.start ? "confirmed" : "planned",
  ...e,
  id: "curated:" + e.id,
}));
const harvested = [
  ...curated,
  ...(S.feeds?.length
    ? (await src("feed-events.json", { events: [] })).events.filter((e) =>
        S.feeds.some((f) => e.source === "feed:" + new URL(f.url).hostname),
      )
    : []),
  ...(S.planb ? (await src("planb-events.json", { events: [] })).events : []),
  ...(S.meetup ? (await src("meetup-events.json", { events: [] })).events : []),
];
const keepPastDays = profile.keepPastDays ?? 730;
const events = dedupe(
  harvested.filter(
    (e) =>
      e.title &&
      (e.online ? !profile.scope.countries && profile.scope.type === "world" : scoped(e)) &&
      (!e.start || Date.parse(e.end || e.start) > NOW - keepPastDays * 86400000),
  ),
).sort((a, b) => String(a.start || "9999").localeCompare(String(b.start || "9999")));
const seen = new Set();
for (const e of events) {
  if (seen.has(e.id)) throw new Error("Duplicate event id " + e.id);
  seen.add(e.id);
}
const groups = groupEvents(events, NOW);

const ecosystemFile = await readJSON(join(PROFILE_DIR, "ecosystem.json"), { companies: [] });
const companies = ecosystemFile.companies.filter((c) => safeURL(c.url));
const layers = [S.merchants && "merchants", communities.length && "communities", "events"].filter(Boolean);

/* ---------- output ---------- */

await rm(OUT, { recursive: true, force: true });
await mkdir(at("data"), { recursive: true });

const sourcesMeta = {
  merchants: S.merchants && { count: places.length, fetchedAt: merchantsSrc.fetchedAt, license: merchantsSrc.license, url: "https://btcmap.org/" },
  communities: communities.length && { count: communities.length, fetchedAt: communitiesSrc.fetchedAt, license: communitiesSrc.license, url: "https://btcmap.org/communities" },
  meetup: S.meetup && { count: harvested.filter((e) => e.source === "meetup").length, fetchedAt: meta.meetup?.at, url: "https://www.meetup.com/" },
  planb: S.planb && { count: harvested.filter((e) => e.source === "planb").length, fetchedAt: meta.planb?.at, license: "CC BY-SA 4.0", url: "https://planb.academy/" },
  feeds: S.feeds?.length && { count: harvested.filter((e) => e.source.startsWith("feed:")).length, fetchedAt: meta.feeds?.at, sites: S.feeds.map((f) => ({ name: f.name, url: f.site || f.url })) },
  ecosystem: companies.length && { count: companies.length, verifiedAt: ecosystemFile.verifiedAt },
};
for (const k of Object.keys(sourcesMeta)) if (!sourcesMeta[k]) delete sourcesMeta[k];

const files = {
  "merchants.json": { fetchedAt: merchantsSrc.fetchedAt, license: merchantsSrc.license, fields: ["id", "lon", "lat", "name", "icon", "country"], places },
  "countries.json": { note: "Bounding box [west, south, east, north] of each country's main territory, from BTC Map.", countries: Object.fromEntries(countryShapes.filter((c) => c.main).map((c) => [c.code, c.main.map((v) => +v.toFixed(2))])) },
  "communities.json": { fetchedAt: communitiesSrc.fetchedAt, license: communitiesSrc.license, communities },
  "events.json": { generatedAt: new Date(NOW).toISOString(), events },
  "ecosystem.json": { rule: ecosystemFile.rule, verifiedAt: ecosystemFile.verifiedAt, companies },
};
const hash = createHash("sha256");
for (const [name, value] of Object.entries(files)) {
  const text = JSON.stringify(value);
  hash.update(text);
  await writeFile(at("data", name), text);
}
for (const f of ["src/app.js", "src/app.css", "src/shared/events.js"]) hash.update(await readFile(resolve(ROOT, f)));
const BUILD = hash.digest("hex").slice(0, 10);
await writeFile(
  at("data", "meta.json"),
  JSON.stringify({ name: profile.name, build: BUILD, generatedAt: new Date(NOW).toISOString(), scope: profile.scope, sources: sourcesMeta }, null, 1),
);
const host = new URL(profile.origin).hostname;
const calendarEvents = [...groups.upcoming, ...groups.past.filter((e) => Date.parse(e.start) > NOW - 30 * 86400000)];
await writeFile(at("events.ics"), toICS(calendarEvents, { name: profile.name, host }));

// Code, styles, map library and fonts.
await mkdir(at("assets/shared"), { recursive: true });
await cp(resolve(ROOT, "src/app.js"), at("assets/app.js"));
await cp(resolve(ROOT, "src/app.css"), at("assets/app.css"));
await cp(resolve(ROOT, "src/shared/events.js"), at("assets/shared/events.js"));
for (const f of ["maplibre-gl.js", "maplibre-gl.css", "maplibre-LICENSE.txt"]) await cp(resolve(ROOT, "vendor", f), at("assets", f));
const FONT_WEIGHTS = { heading: ["500", "600"], body: ["400", "600"] };
let fontCSS = "";
const fontFamilies = {};
for (const role of ["heading", "body"]) {
  const id = profile.theme?.fonts?.[role];
  if (!id) continue;
  const pkg = resolve(ROOT, "node_modules/@fontsource", id);
  if (!existsSync(pkg)) throw new Error(`Font ${id} is not installed: npm install @fontsource/${id}`);
  const family = JSON.parse(await readFile(join(pkg, "package.json"), "utf8")).description?.match(/^Self-host the (.+?) font/)?.[1] || id;
  fontFamilies[role] = family;
  await cp(join(pkg, "LICENSE"), at("assets/fonts", id + "-LICENSE.txt"));
  for (const w of FONT_WEIGHTS[role]) {
    const file = `${id}-latin-${w}-normal.woff2`;
    if (!existsSync(join(pkg, "files", file))) continue;
    await cp(join(pkg, "files", file), at("assets/fonts", file));
    fontCSS += `@font-face{font-family:"${family}";font-style:normal;font-weight:${w};font-display:swap;src:url("${ASSETS}assets/fonts/${file}") format("woff2")}\n`;
  }
}
await writeFile(at("assets/fonts.css"), fontCSS);

let logoSVG = "";
if (profile.publisher?.logo) {
  logoSVG = (await readFile(join(PROFILE_DIR, profile.publisher.logo), "utf8"))
    .replace(/<\?xml[^>]*>/, "")
    .replace(/<svg\b/, `<svg fill="currentColor" role="img" aria-label="${esc(profile.publisher.name)}"`);
  if (/<script|on\w+=/i.test(logoSVG)) throw new Error("Logo SVG must not contain scripts or event handlers");
}

/* ---------- pages ---------- */

const T0 = Object.fromEntries(
  await Promise.all(profile.languages.map(async (l) => [l.code, JSON.parse(await readFile(resolve(ROOT, "src/i18n", l.code + ".json"), "utf8"))])),
);
const mapStyles = profile.map?.styles || { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const attribution = [
  S.merchants || communities.length ? '<a href="https://btcmap.org" target="_blank" rel="noopener">BTC Map</a>' : "",
].filter(Boolean).join(" · ");

function themeVars() {
  const t = profile.theme || {};
  const v = {
    "--p-accent": t.accent,
    "--p-accent-text-light": t.accentText?.light,
    "--p-accent-text-dark": t.accentText?.dark,
    "--p-bg-light": t.background?.light,
    "--p-bg-dark": t.background?.dark,
    "--p-text-light": t.text?.light,
    "--p-text-dark": t.text?.dark,
    "--p-font-heading": fontFamilies.heading && `"${fontFamilies.heading}", system-ui, sans-serif`,
    "--p-font-body": fontFamilies.body && `"${fontFamilies.body}", Georgia, serif`,
  };
  for (const [k, val] of Object.entries(v)) if (val && !/^[#\w\s",.()-]+$/.test(val)) throw new Error(`Unsafe theme value for ${k}`);
  return Object.entries(v).filter(([, val]) => val).map(([k, val]) => `${k}:${val}`).join(";");
}

function dateText(e, T) {
  if (!e.start) return T.planned;
  const opts = { day: "numeric", month: "long", year: "numeric", timeZone: e.dateOnly ? "UTC" : e.timeZone || "UTC" };
  if (!e.dateOnly) Object.assign(opts, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  return new Intl.DateTimeFormat(T.locale, opts).format(new Date(e.dateOnly ? e.start.slice(0, 10) + "T00:00:00Z" : e.start));
}

function eventItem(e, T) {
  const d = e.start ? new Date(e.dateOnly ? e.start.slice(0, 10) + "T00:00:00Z" : e.start) : null;
  const tz = e.dateOnly ? "UTC" : e.timeZone || "UTC";
  const part = (o) => (d ? new Intl.DateTimeFormat(T.locale, { timeZone: tz, ...o }).format(d) : "");
  let where = "";
  try {
    where = e.online ? T.online : [e.city, e.country && new Intl.DisplayNames([T.locale], { type: "region" }).of(e.country)].filter(Boolean).join(", ");
  } catch {
    where = e.city || "";
  }
  const link = safeURL(e.url);
  return `<li class="event" data-type="${esc(e.type)}"><div class="date" aria-hidden="true">${
    d ? `<span class="d">${esc(part({ day: "numeric" }))}</span><span class="m">${esc(part({ month: "short" }))}</span><span class="y">${esc(part({ year: "numeric" }))}</span>` : '<span class="m">?</span>'
  }</div><div class="body"><h3>${link ? `<a href="${esc(link)}" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title)}</h3><p class="when">${esc(dateText(e, T))}</p><p class="meta"><span class="type">${esc(T.types[e.type] || T.types.other)}</span>${where ? " · " + esc(where) : ""}</p><p class="source">${esc(T.listedBy)} ${esc(e.sourceName || e.source)}</p></div></li>`;
}

function companyCard(c, lang, T) {
  const desc = c.description?.[lang] || c.description?.en || "";
  return `<article class="company" data-category="${esc(c.category)}"><h3><a href="${esc(c.url)}" rel="noopener noreferrer">${esc(c.name)}</a></h3><p class="meta">${esc(T.categories[c.category] || c.category)}${c.country ? " · " + esc(c.country) : ""}</p><p>${esc(desc)}</p>${
    safeURL(c.evidence) ? `<p class="why"><a href="${esc(c.evidence)}" rel="noopener noreferrer">${esc(T.whyBitcoinOnly)} ↗</a></p>` : ""
  }</article>`;
}

function ecosystemHTML(lang, T) {
  const order = Object.keys(T.categories);
  const byCat = order.map((cat) => [cat, companies.filter((c) => c.category === cat)]).filter(([, l]) => l.length);
  return byCat
    .map(([cat, list]) => `<section data-group="${esc(cat)}"><h2 class="group-title">${esc(T.categories[cat])}</h2><div class="grid">${list.map((c) => companyCard(c, lang, T)).join("")}</div></section>`)
    .join("");
}

function aboutHTML(lang, T) {
  const A = T.about;
  const n = (k) => (sourcesMeta[k] ? ` <span class="stat">(${new Intl.NumberFormat(T.locale).format(sourcesMeta[k].count)})</span>` : "");
  const items = ["merchants", "communities", "meetup", "planb", "feeds", "ecosystem"].filter((k) => sourcesMeta[k]).map((k) => {
    let extra = "";
    if (k === "feeds") extra = ": " + S.feeds.map((f) => `<a href="${esc(f.site || f.url)}" rel="noopener">${esc(f.name)}</a>`).join(", ");
    return `<li>${esc(A.sources[k])}${extra}${n(k)}</li>`;
  });
  const repo = safeURL(profile.repository);
  return `<div class="prose"><p>${esc(A.lead)}</p>
<h2>${esc(A.sourcesTitle)}</h2><ul>${items.join("")}</ul>
<p class="stat">${esc(fmt(T.updated, { date: new Intl.DateTimeFormat(T.locale, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(new Date(NOW)) + " UTC" }))}</p>
<h2>${esc(T.embedTitle)}</h2><p>${esc(T.embedIntro)}</p><div id="embed-builder"></div>
<h2>${esc(A.contributeTitle)}</h2><ul>${A.contribute.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
<h2>${esc(A.forkTitle)}</h2><p>${esc(A.fork)}${repo ? ` <a href="${esc(repo)}" rel="noopener">GitHub ↗</a>` : ""}</p>
<h2>${esc(A.licencesTitle)}</h2><p>${esc(A.licences)}</p></div>`;
}

const head = (lang, T, { title, description, canonical, embed }) => `<!doctype html>
<html lang="${esc(lang.code)}" class="${profile.theme?.uppercaseHeadings ? "upper" : ""}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https://tiles.openfreemap.org https://api.btcmap.org; worker-src blob:; child-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="generator" content="Community Atlas ${esc(PKG.version)}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${embed ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(canonical)}">
${profile.languages.map((l) => `<link rel="alternate" hreflang="${esc(l.code)}" href="${esc(url(l.path))}">`).join("\n")}
<link rel="alternate" hreflang="x-default" href="${esc(url(profile.languages[0].path))}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">${
  profile.shareImage ? `<meta property="og:image" content="${esc(url(ASSETS + "assets/" + profile.shareImage))}"><meta name="twitter:card" content="summary_large_image">` : ""
}`}
<link rel="alternate" type="text/calendar" title="${esc(profile.name)}" href="${ASSETS}events.ics">
<link rel="stylesheet" href="${ASSETS}assets/fonts.css?v=${BUILD}">
<link rel="stylesheet" href="${ASSETS}assets/maplibre-gl.css">
<link rel="stylesheet" href="${ASSETS}assets/app.css?v=${BUILD}">
<style>:root{${themeVars()}}</style>
<script src="${ASSETS}assets/maplibre-gl.js" defer></script>
<script type="module" src="${ASSETS}assets/app.js?v=${BUILD}"></script>`;

const PKG = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));

function config(lang, T, embed) {
  return JSON.stringify({
    lang: lang.code,
    name: profile.name,
    strings: T,
    data: ASSETS + "data/",
    build: BUILD,
    embed,
    embedURL: url(lang.path + "embed/"),
    layers,
    defaultView: "map",
    map: profile.map,
    mapStyles,
    attribution,
  }).replace(/</g, "\\u003c");
}

function tabs(lang, T) {
  return ["map", "events", "communities", "ecosystem", "about"]
    .filter((v) => v !== "ecosystem" || companies.length)
    .filter((v) => v !== "communities" || communities.length)
    .map((v) => `<a href="${esc(lang.path)}${v === "map" ? "" : "?view=" + v}" data-tab="${v}">${esc(T.views[v])}</a>`)
    .join("");
}

function brand(lang) {
  const pub = profile.publisher;
  const logo = logoSVG && safeURL(pub?.url) ? `<a class="logo" href="${esc(pub.url)}">${logoSVG}</a><span class="sep" aria-hidden="true"></span>` : "";
  return `<div class="brand">${logo}<a class="name" href="${esc(lang.path)}">${esc(profile.name)}</a></div>`;
}

const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

async function writePage(path, html) {
  await mkdir(join(OUT, path), { recursive: true });
  await writeFile(join(OUT, path, "index.html"), html);
}

for (const lang of profile.languages) {
  const T = T0[lang.code];
  const title = `${profile.name}${profile.publisher?.name ? " | " + profile.publisher.name : ""}`;
  const description = profile.tagline?.[lang.code] || profile.tagline?.en || "";
  const others = profile.languages.filter((l) => l !== lang);
  const upcomingHTML = groups.upcoming.slice(0, 60).map((e) => eventItem(e, T)).join("");
  const repo = safeURL(profile.repository);

  await writePage(
    lang.path,
    `${head(lang, T, { title, description, canonical: url(lang.path) })}
</head>
<body data-view="map">
<a class="skip" href="#main">${esc(T.skip)}</a>
<header class="top">${brand(lang)}<nav class="tabs" aria-label="${esc(profile.name)}">${tabs(lang, T)}</nav>
<div class="tools">${others.map((l) => `<a href="${esc(l.path)}" hreflang="${esc(l.code)}" lang="${esc(l.code)}">${esc(l.code.toUpperCase())}</a>`).join("")}<button class="icon-btn" type="button" data-theme-toggle aria-label="${esc(T.theme.toggle)}">${SUN}</button></div></header>
<main id="main" tabindex="-1">
<section id="view-map" aria-label="${esc(T.views.map)}"><div id="map"></div><div class="map-panel" id="layer-controls"></div></section>
<section id="view-events" class="page" hidden><header><h1>${esc(T.views.events)}</h1><p>${esc(fmt(T.eventsCount, { n: groups.upcoming.length }))} · <a href="${ASSETS}events.ics">${esc(T.subscribe)}</a>${repo ? ` · <a href="${esc(repo)}#add-your-events" rel="noopener">${esc(T.addEvents)}</a>` : ""}</p></header>
<div class="controls" id="events-controls"></div><div id="events-list"><ol class="events">${upcomingHTML}</ol></div></section>
${communities.length ? `<section id="view-communities" class="page" hidden><header><h1>${esc(T.views.communities)}</h1><p>${esc(fmt(T.communitiesCount, { n: communities.length }))}</p></header><div class="controls" id="communities-controls"></div><div id="communities-list"></div></section>` : ""}
${companies.length ? `<section id="view-ecosystem" class="page" hidden><header><h1>${esc(T.views.ecosystem)}</h1><p>${esc(T.ecosystemIntro)}</p></header>${
      companies.some((c) => c.review === "pending") ? `<p class="notice">${esc(T.ecosystemReview)}${repo ? ` <a href="${esc(repo)}/issues/new" rel="noopener">${esc(T.suggest)} ↗</a>` : ""}</p>` : ""
    }<div class="controls chips" id="ecosystem-controls"></div><div id="ecosystem-list">${ecosystemHTML(lang.code, T)}</div></section>` : ""}
<section id="view-about" class="page" hidden><header><h1>${esc(T.about.title)}</h1></header>${aboutHTML(lang.code, T)}</section>
</main>
<footer class="foot">${esc(profile.name)}${profile.publisher ? ` · <a href="${esc(profile.publisher.url)}">${esc(profile.publisher.name)}</a>` : ""} · ${attribution} · Plan ₿ Network (CC BY-SA 4.0)${repo ? ` · <a href="${esc(repo)}" rel="noopener">GitHub</a>` : ""}</footer>
<script type="application/json" id="atlas-config">${config(lang, T, false)}</script>
</body>
</html>
`,
  );

  // Embeddable view: same app, minimal header that links back to the full atlas.
  await writePage(
    lang.path + "embed/",
    `${head(lang, T, { title, description, embed: true })}
</head>
<body class="embed with-header" data-view="map">
<header class="top"><div class="brand"><a class="name" href="${esc(url(lang.path))}" target="_blank" rel="noopener">${esc(profile.name)} ↗</a></div><div class="tools"><button class="icon-btn" type="button" data-theme-toggle aria-label="${esc(T.theme.toggle)}">${SUN}</button></div></header>
<main id="main" tabindex="-1">
<section id="view-map" aria-label="${esc(T.views.map)}"><div id="map"></div><div class="map-panel" id="layer-controls"></div></section>
<section id="view-events" class="page" hidden><div class="controls" id="events-controls"></div><div id="events-list"></div></section>
</main>
<script type="application/json" id="atlas-config">${config(lang, T, true)}</script>
</body>
</html>
`,
  );
}

/* ---------- discovery files ---------- */

const pages = profile.languages.map((l) => url(l.path));
await writeFile(
  at("sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${pages
    .map(
      (p) =>
        `<url><loc>${esc(p)}</loc><lastmod>${new Date(NOW).toISOString().slice(0, 10)}</lastmod>${profile.languages
          .map((l) => `<xhtml:link rel="alternate" hreflang="${esc(l.code)}" href="${esc(url(l.path))}"/>`)
          .join("")}</url>`,
    )
    .join("\n")}\n</urlset>\n`,
);
const next = groups.upcoming.slice(0, 40);
await writeFile(
  at("llms.txt"),
  `# ${profile.name}

> ${profile.tagline?.en || ""}

Open data, refreshed automatically. Places and communities: BTC Map / OpenStreetMap (ODbL). Plan ₿ Network events: CC BY-SA 4.0. Meetup events: title, time and link only.

## Data

- [Events (JSON)](${url(ASSETS + "data/events.json")}): ${events.length} events, ${groups.upcoming.length} upcoming.
- [Calendar (iCalendar)](${url(ASSETS + "events.ics")})
- [Communities (JSON)](${url(ASSETS + "data/communities.json")}): ${communities.length} communities.
- [Places accepting bitcoin (JSON)](${url(ASSETS + "data/merchants.json")}): ${places.length} places.
- [Bitcoin-only companies (JSON)](${url(ASSETS + "data/ecosystem.json")}): ${companies.length} entries.
- [Sources and update times](${url(ASSETS + "data/meta.json")})

## Next events

${next.map((e) => `- ${e.start ? e.start.slice(0, 10) : "TBA"}: ${e.title}${e.city ? ", " + e.city : ""}${e.country ? " (" + e.country + ")" : ""}${safeURL(e.url) ? " <" + e.url + ">" : ""}`).join("\n")}
`,
);

console.log(
  `Built ${profile.name} → ${values.out}${ASSETS} · ${places.length} places · ${communities.length} communities · ${events.length} events (${groups.upcoming.length} upcoming) · ${companies.length} companies · build ${BUILD}`,
);
