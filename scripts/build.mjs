/**
 * Build a static edition of the Community Atlas from a profile and the harvested sources.
 *
 *   node scripts/build.mjs [--profile profiles/offchain-media] [--out public] [--now ISO-date]
 *
 * The output mirrors the public URL paths, so `public/` can be uploaded as is.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, SOURCES, readJSON } from "./lib/io.mjs";
import { bbox, inBbox, inShape, shape } from "./lib/geo.mjs";
import { fromFeed } from "./harvest/feeds.mjs";
import { dedupe, groupEvents, toICS } from "../src/shared/events.js";
import { esc, fmt, plural, safeURL } from "../src/shared/util.js";
import { countryName, dateLabel, eventHTML, eventPath, eventTitle, whereLabel } from "../src/shared/format.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: process.env.ATLAS_PROFILE || "profiles/offchain-media" },
    out: { type: "string", default: "public" },
    now: { type: "string" },
  },
});
const PKG = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
const PROFILE_DIR = resolve(ROOT, values.profile);
const OUT = resolve(ROOT, values.out);
const NOW = values.now ? Date.parse(values.now) : Date.now();
const profile = await readJSON(join(PROFILE_DIR, "profile.json"));
validateProfile(profile);

const ASSETS = profile.assetsPath || profile.languages[0].path;
const at = (...p) => join(OUT, ASSETS, ...p);
const url = (path) => new URL(path, profile.origin).href;
const S = profile.sources;
const repo = safeURL(profile.repository);

function validateProfile(p) {
  const problems = [];
  const path = /^\/([\w.-]+\/)*$/;
  if (!/^[\w-]+$/.test(p.id || "")) problems.push("id is required (letters, digits, - and _)");
  if (!p.name) problems.push("name is required");
  try {
    const o = new URL(p.origin);
    if (o.protocol !== "https:" || o.pathname !== "/" || o.search) throw 0;
  } catch {
    problems.push("origin must be an https origin without a path, such as https://example.org");
  }
  if (!Array.isArray(p.languages) || !p.languages.length) problems.push("languages needs at least 1 entry");
  for (const l of p.languages || []) {
    if (!/^[a-z]{2}$/.test(l.code || "")) problems.push(`language code "${l.code}" must be 2 lowercase letters`);
    else if (!existsSync(resolve(ROOT, "src/i18n", l.code + ".json"))) problems.push(`no interface strings for "${l.code}" in src/i18n/`);
    if (!path.test(l.path || "")) problems.push(`language path "${l.path}" must start and end with /`);
  }
  if (p.assetsPath && !path.test(p.assetsPath)) problems.push("assetsPath must start and end with /");
  const scope = p.scope?.type;
  if (scope === "countries" && !p.scope.countries?.every((c) => /^[A-Z]{2}$/.test(c)))
    problems.push("scope.countries must be uppercase ISO codes such as LT");
  else if (scope === "bbox" && !(p.scope.bbox?.length === 4 && p.scope.bbox.every(Number.isFinite)))
    problems.push("scope.bbox must be [west, south, east, north]");
  else if (!["world", "countries", "bbox"].includes(scope)) problems.push("scope.type must be world, countries or bbox");
  if (!(p.map?.center?.length === 2 && p.map.center.every(Number.isFinite) && Number.isFinite(p.map.zoom)))
    problems.push("map needs center [lon, lat] and zoom");
  if (!p.sources || typeof p.sources !== "object") problems.push("sources is required");
  for (const f of p.sources?.feeds || []) if (!safeURL(f.url) || !f.name) problems.push(`feed needs name and url: ${JSON.stringify(f)}`);
  if (problems.length) throw new Error("Profile problems:\n- " + problems.join("\n- "));
}

/* ---------- data ---------- */

const src = (name, empty) => readJSON(join(SOURCES, name), empty);
const merchantsSrc = await src("btcmap-merchants.json", { places: [] });
const communitiesSrc = await src("btcmap-communities.json", { communities: [] });
const countriesSrc = await src("btcmap-countries.json", { countries: [] });
const meta = await src("meta.json", {});

// Country of each place: test the last matching country first (places are sorted by id, not by place),
// then every country whose box contains the point.
const countryShapes = countriesSrc.countries.map((c) => {
  const mostDetailed = c.polygons.reduce((a, b) => (b[0].length > a[0].length ? b : a), [[]]);
  return { code: c.code, s: shape({ type: "MultiPolygon", coordinates: c.polygons }), main: bbox({ type: "Polygon", coordinates: mostDetailed }) };
});
let lastCountry = null;
function countryAt(lon, lat) {
  if (lastCountry && inShape(lon, lat, lastCountry.s)) return lastCountry.code;
  const hit = countryShapes.find((c) => inShape(lon, lat, c.s));
  if (hit) lastCountry = hit;
  return hit?.code || "";
}

// Scope: the whole world, a list of countries or a bounding box.
let inScope = () => true;
if (profile.scope.type === "countries") {
  const wanted = new Set(profile.scope.countries);
  if (!countryShapes.some((c) => wanted.has(c.code))) throw new Error("No country shapes for the scope; run npm run harvest first");
  inScope = (lon, lat, country) => (country ? wanted.has(country) : Number.isFinite(lon) && wanted.has(countryAt(lon, lat)));
} else if (profile.scope.type === "bbox") {
  inScope = (lon, lat) => Number.isFinite(lon) && inBbox(lon, lat, profile.scope.bbox);
}

const places = S.merchants
  ? merchantsSrc.places.map(([id, lon, lat, name]) => [id, lon, lat, name, countryAt(lon, lat)]).filter(([, lon, lat, , c]) => inScope(lon, lat, c))
  : [];
const communities = S.communities ? communitiesSrc.communities.filter((c) => inScope(c.lon, c.lat, c.country)) : [];

// The edition's own events use the feed format and win over the same event from another source.
const ownFeed = { url: url(profile.languages[0].path), name: profile.publisher?.name || profile.name, site: url(profile.languages[0].path) };
const curated = (await readJSON(join(PROFILE_DIR, "events.json"), []))
  .map((e) => fromFeed(e, ownFeed))
  .filter(Boolean)
  .map((e) => ({ ...e, id: "curated:" + e.id.split(":").pop(), source: "curated", listing: null }));
const feedHosts = new Set((S.feeds || []).map((f) => "feed:" + new URL(f.url).hostname));
const harvested = [
  ...curated,
  ...(S.feeds?.length ? (await src("feed-events.json", { events: [] })).events.filter((e) => feedHosts.has(e.source)) : []),
  ...(S.planb ? (await src("planb-events.json", { events: [] })).events : []),
  ...(S.meetup ? (await src("meetup-events.json", { events: [] })).events : []),
  ...(S.luma ? (await src("luma-events.json", { events: [] })).events : []),
  ...(S.nostr ? (await src("nostr-events.json", { events: [] })).events : []),
];
// Fill in the country of events that only have coordinates.
for (const e of harvested) if (!e.country && Number.isFinite(e.lat)) e.country = countryAt(e.lon, e.lat) || null;
const keepPastDays = profile.keepPastDays ?? 730;
const events = dedupe(
  harvested.filter(
    (e) =>
      e.title &&
      (e.online ? profile.scope.type === "world" : inScope(e.lon, e.lat, e.country)) &&
      (!e.start || Date.parse(e.end || e.start) > NOW - keepPastDays * 86400000),
  ),
).sort((a, b) => String(a.start || "9999").localeCompare(String(b.start || "9999")));
const ids = new Set();
for (const e of events) {
  if (ids.has(e.id)) throw new Error("Duplicate event id " + e.id);
  ids.add(e.id);
}
const groups = groupEvents(events, NOW);

// Every event gets a page at <language path>events/<slug>/.
const slugs = new Set();
for (const e of events) {
  const words = (v) => String(v).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let slug = words(e.title).slice(0, 70).replace(/-$/, "");
  slug = slug ? slug + (e.start ? "-" + e.start.slice(0, 10) : "") : words(e.id).slice(0, 90) || "event";
  while (slugs.has(slug)) slug += "-2";
  slugs.add(slug);
  e.slug = slug;
}
// An event copied from a community site that has its own page for it points search engines there.
const ownPageElsewhere = (e) => e.source.startsWith("feed:") && !!(S.feeds || []).find((f) => e.source === "feed:" + new URL(f.url).hostname && f.eventPage) && !!e.listing;

// Companies: only entries read at their source or approved by an editor are published.
const ecosystemFile = await readJSON(join(PROFILE_DIR, "ecosystem.json"), { companies: [] });
const companies = ecosystemFile.companies
  .filter((c) => safeURL(c.url) && (c.verification === "read" || c.review === "approved"))
  .map(({ id, name, url, category, country, description, evidence, verifiedAt, review, logo }) => ({
    id, name, url, category, country, description, evidence, verifiedAt, reviewed: review === "approved",
    logo: logo && /^[\w./-]+$/.test(logo) ? join(PROFILE_DIR, logo) : null,
  }));
const layers = [S.merchants && "merchants", S.communities && "communities", "events"].filter(Boolean);

// Pictures: harvested ones live in data/images/ (see scripts/lib/images.mjs), company logos in the profile.
// Only those of published items are copied; a missing file simply leaves the item without a picture.
const IMG = ASSETS + "assets/img/";
const copies = [];
function picture(from, to) {
  if (!from || !existsSync(from)) return null;
  copies.push([from, at("assets/img", to)]);
  return IMG + to;
}
for (const e of events) {
  const p = picture(e.image && resolve(ROOT, "data/images", e.image), e.image);
  // A community logo standing in for an event picture is shown whole, not cropped to 16:9.
  if (p) Object.assign(e, { image: p }, e.image.startsWith("communities/") ? { imageFit: "contain" } : {});
  else delete e.image;
}
for (const c of communities) {
  const p = picture(c.image && resolve(ROOT, "data/images", c.image), c.image);
  if (p) c.image = p;
  else delete c.image;
}

for (const c of companies) c.logo = picture(c.logo, "logos/" + basename(c.logo || ""));

/* ---------- credits, shared by the map, footer, About page and llms.txt ---------- */

const usesOSM = S.merchants || S.communities;
const mapAttribution = usesOSM ? '<a href="https://btcmap.org" target="_blank" rel="noopener">BTC Map</a>' : "";
function credits(T) {
  return [
    usesOSM && '<a href="https://www.openstreetmap.org/copyright" rel="noopener">© OpenStreetMap</a>, <a href="https://btcmap.org" rel="noopener">BTC Map</a> (ODbL)',
    S.planb && '<a href="https://planb.academy/" rel="noopener">Plan ₿ Network</a> (CC BY-SA 4.0)',
  ].filter(Boolean);
}

/* ---------- output ---------- */

await rm(OUT, { recursive: true, force: true });
await mkdir(at("data"), { recursive: true });

const bySource = (test) => events.filter((e) => test(e.source)).length;
const sourcesMeta = Object.fromEntries(
  Object.entries({
    merchants: S.merchants && { count: places.length, fetchedAt: merchantsSrc.fetchedAt, license: "ODbL-1.0", url: "https://btcmap.org/" },
    communities: S.communities && { count: communities.length, fetchedAt: communitiesSrc.fetchedAt, license: "ODbL-1.0", url: "https://btcmap.org/communities" },
    meetup: S.meetup && { count: bySource((s) => s === "meetup"), fetchedAt: meta.meetup?.at, url: "https://www.meetup.com/" },
    luma: S.luma && { count: bySource((s) => s === "luma"), fetchedAt: meta.luma?.at, url: "https://luma.com/" },
    nostr: S.nostr && { count: bySource((s) => s === "nostr"), fetchedAt: meta.nostr?.at, url: "https://github.com/nostr-protocol/nips/blob/master/52.md" },
    planb: S.planb && { count: bySource((s) => s === "planb"), fetchedAt: meta.planb?.at, license: "CC BY-SA 4.0", url: "https://planb.academy/" },
    feeds: S.feeds?.length && { count: bySource((s) => s.startsWith("feed:")), fetchedAt: meta.feeds?.at, sites: S.feeds.map((f) => ({ name: f.name, url: f.site || f.url })) },
    curated: curated.length && { count: bySource((s) => s === "curated") },
    ecosystem: companies.length && { count: companies.length, verifiedAt: ecosystemFile.verifiedAt },
  }).filter(([, v]) => v),
);

const files = {
  "merchants.json": { fetchedAt: merchantsSrc.fetchedAt, license: "ODbL-1.0 (OpenStreetMap contributors, BTC Map)", fields: ["id", "lon", "lat", "name", "country"], places },
  "communities.json": { fetchedAt: communitiesSrc.fetchedAt, license: "ODbL-1.0 (BTC Map)", communities },
  "events.json": { generatedAt: new Date(NOW).toISOString(), events },
  "ecosystem.json": { rule: ecosystemFile.rule, verifiedAt: ecosystemFile.verifiedAt, companies },
  "countries.json": {
    note: "Bounding box [west, south, east, north] of each country's most detailed polygon, from BTC Map.",
    countries: Object.fromEntries(countryShapes.filter((c) => c.main).map((c) => [c.code, c.main.map((v) => +v.toFixed(2))])),
  },
};
// One small outline file per community, loaded only when a community or one of its events is opened.
const areas = (await src("btcmap-community-areas.json", { areas: {} })).areas;
await mkdir(at("data/areas"), { recursive: true });
for (const c of communities)
  if (areas[c.id]) await writeFile(at("data/areas", c.id.replace(/[^\w-]/g, "_") + ".json"), JSON.stringify({ type: "MultiPolygon", coordinates: areas[c.id] }));

const hash = createHash("sha256");
for (const [name, value] of Object.entries(files)) {
  const text = JSON.stringify(value);
  hash.update(text);
  await writeFile(at("data", name), text);
}
const CODE = ["src/app.js", "src/page.js", "src/app.css", "src/shared/events.js", "src/shared/format.js", "src/shared/util.js"];
for (const f of CODE) hash.update(await readFile(resolve(ROOT, f)));
const BUILD = hash.digest("hex").slice(0, 10);
await writeFile(
  at("data", "meta.json"),
  JSON.stringify({ name: profile.name, build: BUILD, generatedAt: new Date(NOW).toISOString(), scope: profile.scope, sources: sourcesMeta }, null, 1),
);
const host = new URL(profile.origin).hostname;
const calendarEvents = [...groups.upcoming, ...groups.past.filter((e) => Date.parse(e.start) > NOW - 30 * 86400000)];
await writeFile(at("events.ics"), toICS(calendarEvents, { name: profile.name, host, now: NOW }));
await mkdir(at("events"), { recursive: true });
for (const e of events)
  if (e.start && e.status !== "planned") await writeFile(at("events", e.slug + ".ics"), toICS([e], { name: profile.name, host, now: NOW }));

for (const [from, to] of copies) {
  await mkdir(join(to, ".."), { recursive: true });
  await cp(from, to);
}

// Code, styles, map library, fonts and images.
await mkdir(at("assets/shared"), { recursive: true });
await cp(resolve(ROOT, "src/app.js"), at("assets/app.js"));
await cp(resolve(ROOT, "src/app.css"), at("assets/app.css"));
for (const f of ["events.js", "format.js", "util.js"]) await cp(resolve(ROOT, "src/shared", f), at("assets/shared", f));
await cp(resolve(ROOT, "src/page.js"), at("assets/page.js"));
for (const f of ["maplibre-gl.js", "maplibre-gl.css", "maplibre-LICENSE.txt"]) await cp(resolve(ROOT, "vendor", f), at("assets", f));
if (profile.shareImage) await cp(join(PROFILE_DIR, profile.shareImage), at("assets", basename(profile.shareImage)));

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
  if (/<script|\son\w+=/i.test(logoSVG)) throw new Error("The logo SVG must not contain scripts or event handlers");
}

/* ---------- pages ---------- */

const STRINGS = Object.fromEntries(
  await Promise.all(profile.languages.map(async (l) => [l.code, JSON.parse(await readFile(resolve(ROOT, "src/i18n", l.code + ".json"), "utf8"))])),
);
const mapStyles = profile.map.styles || { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const connectSrc = [
  ...new Set(
    [
      ...Object.values(mapStyles).map((u) => new URL(u).origin),
      "https://tiles.openfreemap.org",
      ...(profile.map.connectSrc || []),
      S.merchants && "https://api.btcmap.org",
      profile.map.search !== false && "https://nominatim.openstreetmap.org",
    ].filter(Boolean),
  ),
].join(" ");

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
    "--p-font-body": fontFamilies.body && `"${fontFamilies.body}", system-ui, sans-serif`,
  };
  for (const [k, val] of Object.entries(v)) if (val && !/^[#\w\s",.()-]+$/.test(val)) throw new Error(`Unsafe theme value for ${k}`);
  return Object.entries(v).filter(([, val]) => val).map(([k, val]) => `${k}:${val}`).join(";");
}

function companyCard(c, lang, T) {
  const desc = c.description?.[lang] || c.description?.en || "";
  const logo = c.logo
    ? `<img class="logo-img" src="${esc(c.logo)}" alt="" loading="lazy" decoding="async" width="56" height="56">`
    : `<span class="mono" aria-hidden="true">${esc([...c.name][0])}</span>`;
  const country = c.country ? countryName(c.country, T.locale) : "";
  return `<article class="company" data-category="${esc(c.category)}">${logo}<div>${country ? `<p class="kicker"><span class="cat">${esc(country)}</span></p>` : ""}<h3><a href="${esc(c.url)}" rel="noopener noreferrer">${esc(c.name)}</a></h3><p class="desc">${esc(desc)}</p>${
    safeURL(c.evidence) ? `<p class="links"><a href="${esc(c.evidence)}" rel="noopener noreferrer">${esc(T.whyBitcoinOnly)} ↗</a></p>` : ""
  }</div></article>`;
}

function ecosystemHTML(lang, T) {
  return Object.keys(T.categories)
    .map((cat) => [cat, companies.filter((c) => c.category === cat)])
    .filter(([, list]) => list.length)
    .map(([cat, list]) => `<section data-group="${esc(cat)}"><div class="section-head"><h2 class="group-title">${esc(T.categories[cat])}</h2></div><div class="grid">${list.map((c) => companyCard(c, lang, T)).join("")}</div></section>`)
    .join("");
}

function aboutHTML(T) {
  const A = T.about;
  const count = (k) => ` <span class="stat">(${new Intl.NumberFormat(T.locale).format(sourcesMeta[k].count)})</span>`;
  const sources = Object.keys(sourcesMeta).map((k) => {
    const sites = k === "feeds" ? ": " + S.feeds.map((f) => `<a href="${esc(f.site || f.url)}" rel="noopener">${esc(f.name)}</a>`).join(", ") + "." : "";
    return `<li>${esc(A.sources[k])}${sites}${count(k)}</li>`;
  });
  const channels = ["meetup", "luma", "nostr", "planb", "feeds"].filter((k) => (k === "feeds" ? S.feeds?.length : S[k])).map((k) => A.channels[k]);
  const list = (items) => new Intl.ListFormat(T.locale, { type: "disjunction" }).format(items);
  const contribute = [
    S.merchants && A.contribute.merchants,
    S.communities && A.contribute.communities,
    channels.length && fmt(A.contribute.events, { channels: list(channels) }) + (S.feeds?.length && repo ? " " + A.contribute.eventsFeed : ""),
    companies.length && repo && A.contribute.ecosystem,
  ].filter(Boolean);
  const licences = [A.licences.code, usesOSM && A.licences.osm, S.planb && A.licences.planb, S.meetup && A.licences.meetup, S.luma && A.licences.luma, S.nostr && A.licences.nostr, A.licences.basemap, A.licences.brands].filter(Boolean);
  const updated = new Intl.DateTimeFormat(T.locale, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(new Date(NOW)) + " UTC";
  return `<div class="prose"><p>${esc(A.lead)}</p>
<h2>${esc(A.sourcesTitle)}</h2><ul>${sources.join("")}</ul>
<p class="stat">${esc(fmt(T.updated, { date: updated }))}</p>
<h2>${esc(T.embedTitle)}</h2><p>${esc(T.embedIntro)}</p><div id="embed-builder"></div>
${contribute.length ? `<h2>${esc(A.contributeTitle)}</h2><ul>${contribute.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
<h2>${esc(A.forkTitle)}</h2><p>${esc(A.fork)}${repo ? ` <a href="${esc(repo)}" rel="noopener">GitHub ↗</a>` : ""}</p>
<h2>${esc(A.licencesTitle)}</h2><p>${esc(licences.join(" "))}</p></div>`;
}

function head(lang, { title, description, canonical, embed, paths, image, ogType = "website", app = true, noindex = false }) {
  const share = image || (profile.shareImage ? url(ASSETS + "assets/" + basename(profile.shareImage)) : null);
  const alt = paths || Object.fromEntries(profile.languages.map((l) => [l.code, l.path]));
  return `<!doctype html>
<html lang="${esc(lang.code)}"${profile.theme?.uppercaseHeadings ? ' class="upper"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' ${esc(connectSrc)}; worker-src blob:; child-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="generator" content="Community Atlas ${esc(PKG.version)}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${
  embed
    ? '<meta name="robots" content="noindex">'
    : `<link rel="canonical" href="${esc(canonical)}">${noindex ? '\n<meta name="robots" content="noindex, follow">' : ""}
${profile.languages.map((l) => `<link rel="alternate" hreflang="${esc(l.code)}" href="${esc(url(alt[l.code]))}">`).join("\n")}
<link rel="alternate" hreflang="x-default" href="${esc(url(alt[profile.languages[0].code]))}">
<meta property="og:type" content="${ogType}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">${
        share ? `<meta property="og:image" content="${esc(share)}"><meta name="twitter:card" content="summary_large_image">` : ""
      }`
}
<link rel="alternate" type="text/calendar" title="${esc(profile.name)}" href="${ASSETS}events.ics">
<link rel="stylesheet" href="${ASSETS}assets/fonts.css?v=${BUILD}">
${app ? `<link rel="stylesheet" href="${ASSETS}assets/maplibre-gl.css">\n` : ""}<link rel="stylesheet" href="${ASSETS}assets/app.css?v=${BUILD}">
<style>:root{${themeVars()}}</style>
${
  app
    ? `<script src="${ASSETS}assets/maplibre-gl.js" defer></script>\n<script type="module" src="${ASSETS}assets/app.js?v=${BUILD}"></script>`
    : `<script type="module" src="${ASSETS}assets/page.js?v=${BUILD}"></script>`
}`;
}

function config(lang, T, embed) {
  return JSON.stringify({
    lang: lang.code,
    name: profile.name,
    strings: T,
    data: ASSETS + "data/",
    build: BUILD,
    embed,
    embedURL: url(lang.path + "embed/"),
    eventsBase: lang.path + "events/",
    layers,
    map: profile.map,
    search: profile.map.search !== false,
    mapStyles,
    attribution: mapAttribution,
  }).replace(/</g, "\\u003c");
}

function tabs(lang, T, current) {
  return ["map", "events", "communities", "ecosystem", "about"]
    .filter((v) => (v === "ecosystem" ? companies.length : v === "communities" ? communities.length : true))
    .map((v) => `<a href="${esc(lang.path)}${v === "map" ? "" : "?view=" + v}" data-tab="${v}"${v === current ? ' aria-current="page"' : ""}>${esc(T.views[v])}</a>`)
    .join("");
}

function brand(lang) {
  const pub = profile.publisher;
  const logo = logoSVG && safeURL(pub?.url) ? `<a class="logo" href="${esc(pub.url)}">${logoSVG}</a><span class="sep" aria-hidden="true"></span>` : "";
  return `<div class="brand">${logo}<a class="name" href="${esc(lang.path)}">${esc(profile.name)}</a></div>`;
}

const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const themeButton = (T) => `<button class="icon-btn" type="button" data-theme-toggle aria-label="${esc(T.theme.toggle)}">${SUN}</button>`;

async function writePage(path, html) {
  await mkdir(join(OUT, path), { recursive: true });
  await writeFile(join(OUT, path, "index.html"), html);
}

for (const lang of profile.languages) {
  const T = STRINGS[lang.code];
  const title = `${profile.name}${profile.publisher?.name ? " | " + profile.publisher.name : ""}`;
  const description = profile.tagline?.[lang.code] || profile.tagline?.en || "";
  const switcher = profile.languages
    .filter((l) => l !== lang)
    .map((l) => `<a href="${esc(l.path)}" hreflang="${esc(l.code)}" lang="${esc(l.code)}">${esc(l.name || l.code.toUpperCase())}</a>`)
    .join("");
  const pending = companies.some((c) => !c.reviewed);
  const footer = [esc(profile.name), profile.publisher && `<a href="${esc(profile.publisher.url)}">${esc(profile.publisher.name)}</a>`, ...credits(T), repo && `<a href="${esc(repo)}" rel="noopener">GitHub</a>`]
    .filter(Boolean)
    .join(" · ");

  await writePage(
    lang.path,
    `${head(lang, { title, description, canonical: url(lang.path) })}
</head>
<body data-view="map">
<a class="skip" href="#main">${esc(T.skip)}</a>
<header class="top">${brand(lang)}<nav class="tabs" aria-label="${esc(profile.name)}">${tabs(lang, T)}</nav>
<div class="tools">${switcher}${themeButton(T)}</div></header>
<main id="main" tabindex="-1">
<section id="view-map" aria-label="${esc(T.views.map)}"><div id="map"></div><div class="map-search" id="map-search"></div><div class="map-legend" id="layer-controls"></div></section>
<section id="view-events" class="page" hidden><header><h1>${esc(T.views.events)}</h1><p>${esc(plural(T.eventsCount, groups.upcoming.length, T.locale))} · <a href="${ASSETS}events.ics">${esc(T.subscribe)}</a>${
      repo ? ` · <a href="${esc(repo)}#add-your-events" rel="noopener">${esc(T.addEvents)}</a>` : ""
    }</p></header>
<div class="controls" id="events-controls"></div><div id="events-list"><ol class="events">${groups.upcoming.slice(0, 60).map((e) => eventHTML(e, T, lang.code, lang.path + "events/")).join("")}</ol></div></section>
${
  communities.length
    ? `<section id="view-communities" class="page" hidden><header><h1>${esc(T.views.communities)}</h1><p>${esc(plural(T.communitiesCount, communities.length, T.locale))}</p></header><div class="controls" id="communities-controls"></div><div id="communities-list"></div></section>`
    : ""
}
${
  companies.length
    ? `<section id="view-ecosystem" class="page" hidden><header><h1>${esc(T.views.ecosystem)}</h1><p>${esc(T.ecosystemIntro)}</p></header>${
        pending ? `<p class="notice">${esc(T.ecosystemReview)}${repo ? ` <a href="${esc(repo)}/issues/new/choose" rel="noopener">${esc(T.suggest)} ↗</a>` : ""}</p>` : ""
      }<div class="controls chips" id="ecosystem-controls"></div><div id="ecosystem-list">${ecosystemHTML(lang.code, T)}</div></section>`
    : ""
}
<section id="view-about" class="page" hidden><header><h1>${esc(T.about.title)}</h1></header>${aboutHTML(T)}</section>
</main>
<footer class="foot">${footer}</footer>
<script type="application/json" id="atlas-config">${config(lang, T, false)}</script>
</body>
</html>
`,
  );

  // One page per event, readable without JavaScript, with Event structured data for search engines.
  for (const e of events) await writePage(lang.path + "events/" + e.slug + "/", eventPage(e, lang, T, switcher, footer));

  // Embeddable view: the same app with a minimal header that links back to the full atlas.
  await writePage(
    lang.path + "embed/",
    `${head(lang, { title, description, embed: true })}
</head>
<body class="embed" data-view="map">
<header class="top"><div class="brand"><a class="name" href="${esc(url(lang.path))}" target="_blank" rel="noopener">${esc(profile.name)} ↗</a></div><div class="tools">${themeButton(T)}</div></header>
<main id="main" tabindex="-1">
<section id="view-map" aria-label="${esc(T.views.map)}"><div id="map"></div><div class="map-search" id="map-search"></div><div class="map-legend" id="layer-controls"></div></section>
<section id="view-events" class="page" hidden><div class="controls" id="events-controls"></div><div id="events-list"></div></section>
</main>
<script type="application/json" id="atlas-config">${config(lang, T, true)}</script>
</body>
</html>
`,
  );
}

function eventJSONLD(e, page) {
  if (!e.start || e.status === "planned") return null;
  const place = e.online
    ? { "@type": "VirtualLocation", url: e.url }
    : {
        "@type": "Place",
        name: e.venue || e.city || e.zone || countryName(e.country, "en") || undefined,
        address: { "@type": "PostalAddress", addressLocality: e.city || undefined, addressCountry: e.country || undefined },
        geo: e.precision === "venue" ? { "@type": "GeoCoordinates", latitude: e.lat, longitude: e.lon } : undefined,
      };
  const data = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.title,
    startDate: e.start,
    endDate: e.end || undefined,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: `https://schema.org/${e.online ? "Online" : "Offline"}EventAttendanceMode`,
    location: place,
    image: e.image ? [url(e.image)] : undefined,
    organizer: e.organiser?.name ? { "@type": "Organization", name: e.organiser.name, url: safeURL(e.organiser.url) || undefined } : undefined,
    url: page,
    sameAs: safeURL(e.url) || undefined,
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function eventPage(e, lang, T, switcher, footer) {
  const base = lang.path + "events/";
  const own = url(eventPath(e, base));
  const elsewhere = ownPageElsewhere(e);
  const canonical = elsewhere ? e.listing : own;
  const title = eventTitle(e, lang.code);
  const when = dateLabel(e, T);
  const where = whereLabel(e, T, true);
  const type = T.types[e.type] || T.types.other;
  const description = [type, when, where].filter(Boolean).join(" · ") + ". " + T.listedBy + " " + e.sourceName + ".";
  const paths = Object.fromEntries(profile.languages.map((l) => [l.code, eventPath(e, l.path + "events/")]));
  const ld = elsewhere ? null : eventJSONLD(e, own);
  const link = (href, text) => (safeURL(href) ? `<a href="${esc(safeURL(href))}" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));
  const sources = [link(e.listing || e.url, e.sourceName), ...(e.alsoListedBy || []).map((o) => link(o.url, o.sourceName))].join(", ");
  const facts = [
    [T.facts.when, esc(when)],
    where && [T.facts.where, esc(where) + (e.precision === "city" ? ` <span class="muted">(${esc(e.zone && !e.city ? T.zoneHint : T.cityLevel)})</span>` : "")],
    e.organiser?.name && [T.facts.organiser, link(e.organiser.url, e.organiser.name)],
    [T.facts.source, sources],
  ].filter(Boolean);
  const mapLink = Number.isFinite(e.lat)
    ? `${lang.path}?lat=${e.lat}&lon=${e.lon}&z=${e.precision === "venue" ? 14 : 10}&focus=${encodeURIComponent(e.id)}`
    : null;
  const picture = e.image ? `<figure class="event-picture${e.imageFit === "contain" ? " logo" : ""}"><img src="${esc(e.image)}" alt="" width="480" height="270"></figure>` : "";
  return `${head(lang, { title: `${title} | ${profile.name}`, description, canonical, paths, image: e.image ? url(e.image) : null, ogType: "article", app: false, noindex: elsewhere })}
${ld ? `<script type="application/ld+json">${ld}</script>\n` : ""}</head>
<body data-view="event">
<a class="skip" href="#main">${esc(T.skip)}</a>
<header class="top">${brand(lang)}<nav class="tabs" aria-label="${esc(profile.name)}">${tabs(lang, T, "events")}</nav>
<div class="tools">${switcher.replace(/href="([^"]+)" hreflang="(\w+)"/g, (m, h, code) => `href="${esc(paths[code])}" hreflang="${code}"`)}${themeButton(T)}</div></header>
<main id="main" class="page event-page">
<p class="crumbs kicker"><a href="${esc(lang.path)}?view=events">${esc(T.views.events)}</a></p>
<article>
<p class="kicker"><span class="cat">${esc(type)}</span><span>${esc(when)}</span>${where ? `<span>${esc(whereLabel(e, T))}</span>` : ""}</p>
<h1>${esc(title)}</h1>
${picture}
<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
<p class="actions">${safeURL(e.url) ? `<a class="btn primary" href="${esc(e.url)}" rel="noopener noreferrer">${esc(T.eventWebsite)} ↗</a>` : ""}${
    e.start && e.status !== "planned" ? `<a class="btn" href="${ASSETS}events/${esc(e.slug)}.ics">${esc(T.addToCalendar)}</a>` : ""
  }${mapLink ? `<a class="btn" href="${esc(mapLink)}">${esc(T.showOnMap)}</a>` : ""}<a class="btn" href="${esc(lang.path)}?view=events">${esc(T.allEvents)}</a></p>
</article>
</main>
<footer class="foot">${footer}</footer>
</body>
</html>
`;
}

// Local preview: when no language is served at the root, the root points to the first one.
// The offchain.media Worker only routes the atlas paths, so this file is not served there.
if (!profile.languages.some((l) => l.path === "/"))
  await writeFile(
    join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(profile.languages[0].path)}"><title>${esc(profile.name)}</title><a href="${esc(profile.languages[0].path)}">${esc(profile.name)}</a>\n`,
  );

/* ---------- discovery files ---------- */

const day = new Date(NOW).toISOString().slice(0, 10);
const alternates = profile.languages.map((l) => `<xhtml:link rel="alternate" hreflang="${esc(l.code)}" href="${esc(url(l.path))}"/>`).join("");
await writeFile(
  at("sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${profile.languages.map((l) => `<url><loc>${esc(url(l.path))}</loc><lastmod>${day}</lastmod>${alternates}</url>`).join("\n")}
${events
  .filter((e) => !ownPageElsewhere(e))
  .flatMap((e) =>
    profile.languages.map(
      (l) =>
        `<url><loc>${esc(url(eventPath(e, l.path + "events/")))}</loc>${profile.languages
          .map((x) => `<xhtml:link rel="alternate" hreflang="${esc(x.code)}" href="${esc(url(eventPath(e, x.path + "events/")))}"/>`)
          .join("")}</url>`,
    ),
  )
  .join("\n")}
</urlset>
`,
);
const plain = (html) => html.replace(/<[^>]+>/g, "");
await writeFile(
  at("llms.txt"),
  `# ${profile.name}

> ${profile.tagline?.en || ""}

Open data, refreshed automatically. ${credits(STRINGS[profile.languages[0].code]).map(plain).join("; ")}.${S.meetup || S.luma ? " Meetup and Luma events: title, time, place and link only." : ""}${S.nostr ? " Nostr events: NIP-52 calendar events tagged #bitcoin." : ""}

## Data

- [Events (JSON)](${url(ASSETS + "data/events.json")}): ${events.length} events, ${groups.upcoming.length} upcoming.
- [Calendar (iCalendar)](${url(ASSETS + "events.ics")})
${communities.length ? `- [Communities (JSON)](${url(ASSETS + "data/communities.json")}): ${communities.length} communities.\n` : ""}${
    places.length ? `- [Places accepting bitcoin (JSON)](${url(ASSETS + "data/merchants.json")}): ${places.length} places.\n` : ""
  }${companies.length ? `- [Bitcoin-only companies (JSON)](${url(ASSETS + "data/ecosystem.json")}): ${companies.length} entries.\n` : ""}- [Sources and update times](${url(ASSETS + "data/meta.json")})

## Next events

${groups.upcoming
  .slice(0, 40)
  .map((e) => `- ${e.start.slice(0, 10)}: ${e.title}${e.city ? ", " + e.city : ""}${e.country ? " (" + e.country + ")" : ""}${safeURL(e.url) ? " <" + e.url + ">" : ""}`)
  .join("\n")}
`,
);

console.log(
  `Built ${profile.id} (${profile.name}) → ${values.out}${ASSETS} · ${places.length} places · ${communities.length} communities · ${events.length} events (${groups.upcoming.length} upcoming) · ${companies.length} companies · build ${BUILD}`,
);
