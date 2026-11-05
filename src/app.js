/* Community Atlas: map and lists of Bitcoin meetups, conferences, communities, places and companies. */
import { groupEvents, startInstant } from "./shared/events.js";

const CFG = JSON.parse(document.getElementById("atlas-config").textContent);
const T = CFG.strings;
const LANG = CFG.lang;
const EMBED = CFG.embed;
const params = new URLSearchParams(location.search);
const VIEWS = ["map", "events", "communities", "ecosystem", "about"];
const PAGE = 100;
let map = null,
  popup = null;

/* ---------- small helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined && c !== false)
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const num = (n) => new Intl.NumberFormat(T.locale).format(n);

function safeURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function extLink(href, text, cls) {
  const url = safeURL(href);
  return url
    ? h("a", { href: url, class: cls, rel: "noopener noreferrer", target: EMBED ? "_blank" : null }, text)
    : h("span", { class: cls }, text);
}

const countryNames = new Intl.DisplayNames([T.locale], { type: "region" });
function countryName(code) {
  try {
    return code ? countryNames.of(code) : "";
  } catch {
    return code || "";
  }
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

const cache = new Map();
function load(name) {
  if (!cache.has(name))
    cache.set(
      name,
      fetch(CFG.data + name + ".json?v=" + CFG.build).then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }),
    );
  return cache.get(name);
}

/* ---------- dates ---------- */

function dateParts(e) {
  const t = startInstant(e);
  if (!t) return null;
  const tz = e.dateOnly ? "UTC" : e.timeZone || undefined;
  const d = new Date(t);
  const opt = (o) => new Intl.DateTimeFormat(T.locale, { timeZone: tz, ...o }).format(d);
  return { day: opt({ day: "numeric" }), month: opt({ month: "short" }), year: opt({ year: "numeric" }) };
}

function dateLabel(e) {
  if (!e.start) return T.planned;
  const opts = { day: "numeric", month: "long", year: "numeric" };
  if (e.dateOnly) {
    const f = new Intl.DateTimeFormat(T.locale, { ...opts, timeZone: "UTC" });
    const a = new Date(startInstant(e));
    const b = e.end ? new Date(Date.parse(e.end.slice(0, 10) + "T00:00:00Z")) : null;
    return b && b.getTime() !== a.getTime() ? f.formatRange(a, b) : f.format(a);
  }
  const f = new Intl.DateTimeFormat(T.locale, {
    ...opts,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: e.timeZone || undefined,
    timeZoneName: "short",
  });
  return f.format(new Date(e.start));
}

/* ---------- theme ---------- */

const media = matchMedia("(prefers-color-scheme: dark)");
function currentTheme() {
  return document.documentElement.dataset.theme || (media.matches ? "dark" : "light");
}
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  restyleMap();
}
applyTheme(params.get("theme") || store("atlas-theme") || null);
media.addEventListener?.("change", () => !document.documentElement.dataset.theme && restyleMap());
document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  store("atlas-theme", next);
  applyTheme(next);
});

/* ---------- views ---------- */

let view = VIEWS.includes(params.get("view")) ? params.get("view") : CFG.defaultView || "map";
const rendered = new Set();

function showView(next, push = true) {
  view = next;
  document.body.dataset.view = view;
  for (const v of VIEWS) {
    const section = document.getElementById("view-" + v);
    if (section) section.hidden = v !== view;
    const tab = document.querySelector(`[data-tab="${v}"]`);
    if (tab) tab.setAttribute("aria-current", v === view ? "page" : "false");
  }
  if (push && !EMBED) {
    const url = new URL(location.href);
    if (view === "map") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    history.pushState({ view }, "", url);
  }
  if (view === "map") initMap();
  else if (!rendered.has(view)) {
    rendered.add(view);
    ({ events: renderEvents, communities: renderCommunities, ecosystem: renderEcosystem, about: renderAbout }[view]?.());
  }
}

document.querySelectorAll("[data-tab]").forEach((a) =>
  a.addEventListener("click", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    showView(a.dataset.tab);
    document.getElementById("main")?.focus({ preventScroll: true });
  }),
);
addEventListener("popstate", () => {
  const v = new URLSearchParams(location.search).get("view");
  showView(VIEWS.includes(v) ? v : "map", false);
});

/* ---------- map ---------- */

const layerState = new Set(
  (params.get("layers") || store("atlas-layers") || CFG.layers.join(",")).split(",").filter((l) => CFG.layers.includes(l)),
);
const COLORS = {
  light: { merchants: "#e8860c", communities: "#0f766e", events: "#4338ca", halo: "#ffffff", text: "#ffffff" },
  dark: { merchants: "#f7931a", communities: "#2dd4bf", events: "#a5b4fc", halo: "#1a1a1a", text: "#1a1a1a" },
};
const styleURL = () => CFG.mapStyles[currentTheme()] || CFG.mapStyles.light;

function initMap() {
  if (map || !document.getElementById("map")) return;
  const start = {
    center: [Number(params.get("lon")), Number(params.get("lat"))].every(Number.isFinite) && params.has("lat")
      ? [Number(params.get("lon")), Number(params.get("lat"))]
      : CFG.map.center,
    zoom: params.has("z") ? Number(params.get("z")) : CFG.map.zoom,
  };
  map = new maplibregl.Map({
    container: "map",
    style: styleURL(),
    center: start.center,
    zoom: start.zoom,
    minZoom: CFG.map.minZoom ?? 1,
    maxZoom: CFG.map.maxZoom ?? 18,
    maxBounds: CFG.map.maxBounds || undefined,
    attributionControl: { compact: true, customAttribution: CFG.attribution },
    cooperativeGestures: EMBED,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
  map.on("style.load", addLayers);
  if (params.get("country") && !params.has("lat"))
    load("countries")
      .then((d) => {
        const b = d.countries[params.get("country")];
        if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 30, duration: 0 });
      })
      .catch(() => {});
  map.on("moveend", () => {
    if (EMBED || view !== "map") return;
    const c = map.getCenter();
    const url = new URL(location.href);
    url.searchParams.set("lat", c.lat.toFixed(4));
    url.searchParams.set("lon", c.lng.toFixed(4));
    url.searchParams.set("z", map.getZoom().toFixed(2));
    history.replaceState(history.state, "", url);
  });
  renderLayerControls();
}

function restyleMap() {
  if (!map) return;
  popup?.remove();
  map.setStyle(styleURL());
}

async function sourceData(layer) {
  if (layer === "merchants") {
    const d = await load("merchants");
    const country = params.get("country");
    return {
      type: "FeatureCollection",
      features: d.places.filter((p) => !country || p[5] === country).map(([id, lon, lat, name, icon]) => ({
        type: "Feature",
        properties: { id, name, icon },
        geometry: { type: "Point", coordinates: [lon, lat] },
      })),
    };
  }
  if (layer === "communities") {
    const d = await load("communities");
    return {
      type: "FeatureCollection",
      features: filtered(d.communities).map((c) => ({
        type: "Feature",
        properties: { id: c.id },
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      })),
    };
  }
  const d = await load("events");
  const { upcoming } = groupEvents(filtered(d.events));
  return {
    type: "FeatureCollection",
    features: upcoming
      .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
      .map((e) => ({
        type: "Feature",
        properties: { id: e.id },
        geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      })),
  };
}

/** Optional embed filters: ?country=FR, ?community=<BTC Map id>, ?source=feed:example.org */
function filtered(list) {
  const country = params.get("country");
  const community = params.get("community");
  const source = params.get("source");
  return list.filter(
    (x) =>
      (!country || x.country === country) &&
      (!community || x.community === community || x.id === community) &&
      (!source || !x.source || x.source === source),
  );
}

function addLayers() {
  const c = COLORS[currentTheme()] || COLORS.light;
  const order = ["merchants", "communities", "events"];
  for (const layer of order) {
    if (!CFG.layers.includes(layer)) continue;
    const id = "atlas-" + layer;
    map.addSource(id, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterRadius: layer === "merchants" ? 46 : 36,
      clusterMaxZoom: layer === "merchants" ? 14 : 9,
    });
    const visibility = layerState.has(layer) ? "visible" : "none";
    const size = layer === "events" ? 7 : layer === "communities" ? 6 : 4.5;
    map.addLayer({
      id: id + "-clusters",
      type: "circle",
      source: id,
      filter: ["has", "point_count"],
      layout: { visibility },
      paint: {
        "circle-color": c[layer],
        "circle-opacity": layer === "merchants" ? 0.78 : 0.9,
        "circle-radius": ["step", ["get", "point_count"], 13, 10, 16, 100, 21, 1000, 27],
        "circle-stroke-width": 2,
        "circle-stroke-color": c.halo,
      },
    });
    map.addLayer({
      id: id + "-count",
      type: "symbol",
      source: id,
      filter: ["has", "point_count"],
      layout: {
        visibility,
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 12,
        "text-allow-overlap": true,
      },
      paint: { "text-color": c.text },
    });
    map.addLayer({
      id: id + "-points",
      type: "circle",
      source: id,
      filter: ["!", ["has", "point_count"]],
      layout: { visibility },
      paint: {
        "circle-color": c[layer],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, size * 0.8, 14, size * 1.4],
        "circle-stroke-width": layer === "merchants" ? 1 : 2,
        "circle-stroke-color": c.halo,
      },
    });
    for (const part of ["-clusters", "-points"]) {
      map.on("mouseenter", id + part, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id + part, () => (map.getCanvas().style.cursor = ""));
    }
    map.on("click", id + "-clusters", async (ev) => {
      const f = ev.features[0];
      const zoom = await map.getSource(id).getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(zoom, 16) });
    });
    map.on("click", id + "-points", (ev) => openPopup(layer, ev.features[0]));
    if (layerState.has(layer)) fillLayer(layer);
  }
}

const filled = new Set();
async function fillLayer(layer) {
  const status = document.querySelector(`[data-layer-status="${layer}"]`);
  try {
    if (status) status.textContent = T.loading;
    const data = await sourceData(layer);
    map.getSource("atlas-" + layer)?.setData(data);
    filled.add(layer);
    if (status) status.textContent = num(data.features.length);
  } catch {
    if (status) status.textContent = "!";
  }
}

function setLayer(layer, on) {
  on ? layerState.add(layer) : layerState.delete(layer);
  if (!EMBED) store("atlas-layers", [...layerState].join(","));
  for (const part of ["-clusters", "-count", "-points"])
    map?.getLayer("atlas-" + layer + part) &&
      map.setLayoutProperty("atlas-" + layer + part, "visibility", on ? "visible" : "none");
  if (on && map?.getSource("atlas-" + layer)) fillLayer(layer);
}

function renderLayerControls() {
  const panel = document.getElementById("layer-controls");
  if (!panel || panel.childElementCount) return;
  const box = h("div", { class: "panel-body" });
  const details = h("details", { open: innerWidth > 760 && !EMBED }, h("summary", { class: "panel-title" }, T.layersTitle), box);
  panel.append(details);
  for (const layer of CFG.layers) {
    const input = h("input", {
      type: "checkbox",
      checked: layerState.has(layer),
      onchange: (ev) => setLayer(layer, ev.target.checked),
    });
    box.append(
      h(
        "label",
        { class: "layer layer-" + layer },
        input,
        h("span", { class: "swatch", "aria-hidden": "true" }),
        h("span", { class: "layer-name" }, T.layers[layer]),
        h("span", { class: "layer-count", "data-layer-status": layer }, layerState.has(layer) ? T.loading : ""),
      ),
    );
  }
  box.append(
    h("button", { type: "button", class: "reset", onclick: () => map.flyTo({ center: CFG.map.center, zoom: CFG.map.zoom }) }, T.resetView),
  );
}

async function openPopup(layer, feature) {
  popup?.remove();
  const body = h("div", { class: "popup" });
  popup = new maplibregl.Popup({ maxWidth: "320px", focusAfterOpen: true })
    .setLngLat(feature.geometry.coordinates)
    .setDOMContent(body)
    .addTo(map);
  const id = feature.properties.id;
  if (layer === "merchants") return merchantPopup(body, feature.properties);
  if (layer === "communities") {
    const { communities } = await load("communities");
    const c = communities.find((x) => x.id === id);
    if (c) body.append(...(await communityCard(c, true)).childNodes);
    return;
  }
  const { events } = await load("events");
  const e = events.find((x) => x.id === id);
  if (e) body.append(eventCard(e, "div"));
}

async function merchantPopup(body, p) {
  const btcmap = `https://btcmap.org/merchant/${encodeURIComponent(p.id)}`;
  body.append(h("h3", {}, p.name || "BTC Map #" + p.id));
  const details = h("dl", { class: "details" }, h("dd", { class: "muted" }, T.loading));
  body.append(details, h("p", {}, extLink(btcmap, T.viewOnBtcmap + " ↗", "more")));
  try {
    const r = await fetch(
      `https://api.btcmap.org/v4/places/${encodeURIComponent(p.id)}?fields=name,address,website,opening_hours,verified_at`,
      { signal: AbortSignal.timeout(8000) },
    );
    const d = await r.json();
    details.replaceChildren();
    if (d.address) details.append(h("dt", {}, T.address), h("dd", {}, d.address));
    if (d.opening_hours) details.append(h("dt", {}, T.openingHours), h("dd", {}, d.opening_hours));
    if (safeURL(d.website)) details.append(h("dt", {}, T.website), h("dd", {}, extLink(d.website, new URL(d.website).hostname)));
    if (!details.childElementCount) details.remove();
  } catch {
    details.remove();
  }
}

/* ---------- events ---------- */

function sourceLabel(e) {
  return e.sourceName || e.source;
}

function eventCard(e, tag = "li") {
  const p = dateParts(e);
  const where = e.online ? T.online : [e.city, countryName(e.country)].filter(Boolean).join(", ");
  return h(
    tag,
    { class: "event", "data-type": e.type },
    h(
      "div",
      { class: "date", "aria-hidden": "true" },
      p ? [h("span", { class: "d" }, p.day), h("span", { class: "m" }, p.month), h("span", { class: "y" }, p.year)] : h("span", { class: "m" }, "?"),
    ),
    h(
      "div",
      { class: "body" },
      h("h3", {}, extLink(e.url, e.title)),
      h("p", { class: "when" }, dateLabel(e)),
      h(
        "p",
        { class: "meta" },
        h("span", { class: "type" }, T.types[e.type] || T.types.other),
        where ? [" · ", h("span", {}, where)] : null,
        e.precision === "city" ? h("span", { class: "muted", title: T.cityLevel }, " ◌") : null,
      ),
      h(
        "p",
        { class: "source" },
        T.listedBy + " ",
        e.listing && e.listing !== e.url ? extLink(e.listing, sourceLabel(e)) : sourceLabel(e),
        e.alsoListedBy?.length
          ? [`, ${T.alsoListedBy} `, ...e.alsoListedBy.flatMap((o, i) => [i ? ", " : "", extLink(o.url, o.sourceName || o.source)])]
          : null,
      ),
    ),
  );
}

async function renderEvents() {
  const list = document.getElementById("events-list");
  const controls = document.getElementById("events-controls");
  let data;
  try {
    data = await load("events");
  } catch {
    list.replaceChildren(h("p", { class: "empty" }, T.loadFailed));
    return;
  }
  const all = filtered(data.events);
  const countries = [...new Set(all.map((e) => e.country).filter(Boolean))].sort((a, b) => countryName(a).localeCompare(countryName(b), T.locale));
  const types = [...new Set(all.map((e) => e.type))];
  const state = { when: params.get("when") === "past" ? "past" : "upcoming", country: params.get("country") || "", type: "", q: "", limit: PAGE };

  const whenTabs = h(
    "div",
    { class: "segmented", role: "group" },
    ["upcoming", "past"].map((w) =>
      h("button", { type: "button", "data-when": w, "aria-pressed": String(state.when === w), onclick: () => { state.when = w; state.limit = PAGE; draw(); } }, T[w]),
    ),
  );
  const select = (label, options, key) =>
    h(
      "select",
      { "aria-label": label, onchange: (ev) => { state[key] = ev.target.value; state.limit = PAGE; draw(); } },
      h("option", { value: "" }, label),
      options.map(([v, text]) => h("option", { value: v, selected: state[key] === v }, text)),
    );
  const search = h("input", { type: "search", placeholder: T.searchEvents, "aria-label": T.searchEvents, oninput: (ev) => { state.q = ev.target.value.trim().toLowerCase(); state.limit = PAGE; draw(); } });
  if (!EMBED)
    controls.replaceChildren(
      whenTabs,
      search,
      params.get("country") ? null : select(T.allCountries, countries.map((c) => [c, countryName(c)]), "country"),
      select(T.allTypes, types.map((t) => [t, T.types[t] || t]), "type"),
    );
  else controls.replaceChildren(whenTabs);

  function draw() {
    whenTabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.when === state.when)));
    const items = all.filter(
      (e) =>
        (!state.country || e.country === state.country) &&
        (!state.type || e.type === state.type) &&
        (!state.q || [e.title, e.city, e.organiser?.name, e.sourceName, countryName(e.country)].join(" ").toLowerCase().includes(state.q)),
    );
    const g = groupEvents(items);
    const shown = state.when === "past" ? g.past : g.upcoming;
    const ul = h("ol", { class: "events" }, shown.slice(0, state.limit).map((e) => eventCard(e)));
    const parts = [shown.length ? ul : h("p", { class: "empty" }, T.noResults)];
    if (shown.length > state.limit)
      parts.push(h("button", { type: "button", class: "more", onclick: () => { state.limit += PAGE; draw(); } }, T.showMore));
    if (state.when === "upcoming" && g.planned.length)
      parts.push(h("h2", { class: "sub" }, T.planned), h("ol", { class: "events planned" }, g.planned.map((e) => eventCard(e))));
    list.replaceChildren(...parts);
  }
  draw();
}

/* ---------- communities ---------- */

async function communityCard(c, compact = false) {
  const { events } = await load("events").catch(() => ({ events: [] }));
  const upcoming = groupEvents(events.filter((e) => e.community === c.id)).upcoming;
  return h(
    "article",
    { class: "community" },
    h("h3", {}, extLink(c.links.website || c.btcmap, c.name)),
    h("p", { class: "meta" }, countryName(c.country) || c.continent || ""),
    upcoming.length ? h("p", { class: "next" }, fmt(T.communityEvents, { n: upcoming.length }), ": ", extLink(upcoming[0].url, upcoming[0].title), " · ", dateLabel(upcoming[0])) : null,
    h(
      "p",
      { class: "links" },
      [
        ...Object.entries(c.links)
          .filter(([k]) => k !== "website" || !compact)
          .slice(0, compact ? 4 : 8)
          .map(([k, url]) => extLink(url, T.links[k] || k)),
        extLink(c.btcmap, "BTC Map"),
      ].flatMap((a, i) => (i ? [" · ", a] : [a])),
    ),
  );
}

async function renderCommunities() {
  const list = document.getElementById("communities-list");
  const controls = document.getElementById("communities-controls");
  let data;
  try {
    data = await load("communities");
  } catch {
    list.replaceChildren(h("p", { class: "empty" }, T.loadFailed));
    return;
  }
  const all = filtered(data.communities);
  const countries = [...new Set(all.map((c) => c.country).filter(Boolean))].sort((a, b) => countryName(a).localeCompare(countryName(b), T.locale));
  const state = { q: "", country: "", limit: PAGE };
  controls.replaceChildren(
    h("input", { type: "search", placeholder: T.searchCommunities, "aria-label": T.searchCommunities, oninput: (ev) => { state.q = ev.target.value.trim().toLowerCase(); state.limit = PAGE; draw(); } }),
    h(
      "select",
      { "aria-label": T.allCountries, onchange: (ev) => { state.country = ev.target.value; state.limit = PAGE; draw(); } },
      h("option", { value: "" }, T.allCountries),
      countries.map((c) => h("option", { value: c }, countryName(c))),
    ),
  );
  async function draw() {
    const items = all.filter(
      (c) => (!state.country || c.country === state.country) && (!state.q || (c.name + " " + countryName(c.country)).toLowerCase().includes(state.q)),
    );
    const cards = await Promise.all(items.slice(0, state.limit).map((c) => communityCard(c)));
    const parts = [items.length ? h("div", { class: "grid" }, cards) : h("p", { class: "empty" }, T.noResults)];
    if (items.length > state.limit) parts.push(h("button", { type: "button", class: "more", onclick: () => { state.limit += PAGE; draw(); } }, T.showMore));
    list.replaceChildren(...parts);
  }
  draw();
}

/* ---------- ecosystem ---------- */

async function renderEcosystem() {
  const root = document.getElementById("ecosystem-list");
  const chips = document.getElementById("ecosystem-controls");
  if (!root || !chips) return;
  const cards = [...root.querySelectorAll("[data-category]")];
  const cats = [...new Set(cards.map((c) => c.dataset.category))];
  let active = "";
  const buttons = ["", ...cats].map((cat) =>
    h("button", { type: "button", "aria-pressed": String(cat === active), onclick: () => { active = cat; draw(); } }, cat ? T.categories[cat] || cat : T.all),
  );
  chips.replaceChildren(...buttons);
  function draw() {
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String((i ? cats[i - 1] : "") === active)));
    for (const card of cards) card.hidden = !!active && card.dataset.category !== active;
    root.querySelectorAll("[data-group]").forEach((g) => (g.hidden = !!active && g.dataset.group !== active));
  }
}

/* ---------- about: embed code generator ---------- */

function renderAbout() {
  const box = document.getElementById("embed-builder");
  if (!box) return;
  const out = h("textarea", { readonly: true, rows: 4, "aria-label": "HTML" });
  const viewSel = h("select", { "aria-label": T.embedView, onchange: update }, ["map", "events"].map((v) => h("option", { value: v }, T.views[v])));
  const countrySel = h("select", { "aria-label": T.embedCountry, onchange: update }, h("option", { value: "" }, T.allCountries));
  load("events").then((d) => {
    const codes = [...new Set(d.events.map((e) => e.country).filter(Boolean))].sort((a, b) => countryName(a).localeCompare(countryName(b), T.locale));
    countrySel.append(...codes.map((c) => h("option", { value: c }, countryName(c))));
  }).catch(() => {});
  const copy = h("button", { type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(out.value); copy.textContent = T.embedCopied; setTimeout(() => (copy.textContent = T.embedCopy), 1500); } catch { out.select(); }
  } }, T.embedCopy);
  function update() {
    const u = new URL(CFG.embedURL);
    u.searchParams.set("view", viewSel.value);
    if (countrySel.value) u.searchParams.set("country", countrySel.value);
    const height = viewSel.value === "map" ? 520 : 640;
    out.value = `<iframe src="${u.href}" title="${CFG.name}" width="100%" height="${height}" style="border:0;border-radius:8px" loading="lazy" allow="geolocation"></iframe>`;
  }
  box.append(h("div", { class: "row" }, h("label", {}, T.embedView, " ", viewSel), h("label", {}, T.embedCountry, " ", countrySel)), out, copy);
  update();
}

/* ---------- start ---------- */

showView(view, false);
