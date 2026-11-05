/* Community Atlas in the browser: map, lists and embed code. Pages are pre-rendered by scripts/build.mjs. */
import { groupEvents } from "./shared/events.js";
import { countryName, dateLabel, eventHTML, eventTitle } from "./shared/format.js";
import { esc, plural, safeURL } from "./shared/util.js";

const CFG = JSON.parse(document.getElementById("atlas-config").textContent);
const T = CFG.strings;
const LANG = CFG.lang;
const EMBED = CFG.embed;
const params = new URLSearchParams(location.search);
const PAGE = 100;
const LAYER_IDS = (layer) => ["clusters", "count", "points"].map((p) => `atlas-${layer}-${p}`);

/* Embed filters: ?country=FR, ?community=<BTC Map id>, ?source=feed:example.org */
const FILTER = {
  country: (params.get("country") || "").toUpperCase(),
  community: params.get("community") || "",
  source: params.get("source") || "",
};
const filtered = (list) =>
  list.filter(
    (x) =>
      (!FILTER.country || x.country === FILTER.country) &&
      (!FILTER.community || x.community === FILTER.community || x.id === FILTER.community) &&
      (!FILTER.source || !x.source || x.source === FILTER.source),
  );

let map = null;
let popup = null;

/* ---------- helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function extLink(href, text) {
  const url = safeURL(href);
  return url ? h("a", { href: url, rel: "noopener noreferrer", target: EMBED ? "_blank" : null }, text) : h("span", {}, text);
}

const num = (n) => new Intl.NumberFormat(T.locale).format(n);
const byCountryName = (a, b) => countryName(a, T.locale).localeCompare(countryName(b, T.locale), T.locale);

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
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

/** Render a list of events as HTML (escaped in eventHTML). In embeds, links open a new tab. */
function eventsHTML(list, cls = "events") {
  const html = `<ol class="${cls}">${list.map((e) => eventHTML(e, T, LANG)).join("")}</ol>`;
  return EMBED ? html.replaceAll('rel="noopener noreferrer"', 'rel="noopener noreferrer" target="_blank"') : html;
}

/* ---------- theme ---------- */

const media = matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => document.documentElement.dataset.theme || (media.matches ? "dark" : "light");
function applyTheme(theme) {
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  restyleMap();
}
applyTheme(params.get("theme") || store("atlas-theme"));
media.addEventListener("change", () => !document.documentElement.dataset.theme && restyleMap());
document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  if (!EMBED) store("atlas-theme", next);
  applyTheme(next);
});

/* ---------- views ---------- */

const VIEWS = ["map", "events", "communities", "ecosystem", "about"].filter((v) => document.getElementById("view-" + v));
const requested = params.get("view");
let view = VIEWS.includes(requested) ? requested : "map";
const rendered = new Set();

function showView(next, push = true) {
  view = next;
  document.body.dataset.view = view;
  for (const v of VIEWS) {
    document.getElementById("view-" + v).hidden = v !== view;
    document.querySelector(`[data-tab="${v}"]`)?.setAttribute("aria-current", v === view ? "page" : "false");
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
    ({ events: renderEvents, communities: renderCommunities, ecosystem: renderEcosystem, about: renderAbout })[view]();
  }
}

document.querySelectorAll("[data-tab]").forEach((a) =>
  a.addEventListener("click", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    showView(a.dataset.tab);
    document.getElementById("main").focus({ preventScroll: true });
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
const styleURL = () => CFG.mapStyles[currentTheme()] || CFG.mapStyles.light;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function initMap() {
  if (map) return;
  const lat = parseFloat(params.get("lat")),
    lon = parseFloat(params.get("lon")),
    zoom = parseFloat(params.get("z"));
  const located = Number.isFinite(lat) && Number.isFinite(lon);
  map = new maplibregl.Map({
    container: "map",
    style: styleURL(),
    center: located ? [lon, lat] : CFG.map.center,
    zoom: Number.isFinite(zoom) ? zoom : CFG.map.zoom,
    minZoom: CFG.map.minZoom ?? 1,
    maxZoom: CFG.map.maxZoom ?? 18,
    maxBounds: CFG.map.maxBounds,
    attributionControl: { compact: true, customAttribution: CFG.attribution || undefined },
    cooperativeGestures: EMBED,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
  // Layer handlers are tied to layer ids, so they survive style changes: register them once.
  for (const layer of CFG.layers) {
    const [clusters, , points] = LAYER_IDS(layer);
    for (const id of [clusters, points]) {
      map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
    }
    map.on("click", clusters, async (ev) => {
      const f = ev.features[0];
      const z = await map.getSource("atlas-" + layer).getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z, 16) });
    });
    map.on("click", points, (ev) => openPopup(layer, ev.features[0]));
  }
  map.on("style.load", addLayers);
  if (FILTER.country && !located)
    load("countries")
      .then((d) => {
        const b = d.countries[FILTER.country];
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
  // A full reload fires style.load, which adds the atlas layers again with the new theme's colours.
  map.setStyle(styleURL(), { diff: false });
}

async function features(layer) {
  const point = (coordinates, properties) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates } });
  if (layer === "merchants") {
    const { places } = await load("merchants");
    return places.filter((p) => !FILTER.country || p[4] === FILTER.country).map(([id, lon, lat, name]) => point([lon, lat], { id, name }));
  }
  if (layer === "communities") {
    const { communities } = await load("communities");
    return filtered(communities).map((c) => point([c.lon, c.lat], { id: c.id }));
  }
  const { events } = await load("events");
  return groupEvents(filtered(events))
    .upcoming.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map((e) => point([e.lon, e.lat], { id: e.id }));
}

function addLayers() {
  const halo = cssVar("--bg");
  for (const layer of CFG.layers) {
    const color = cssVar("--" + layer);
    const [clusters, count, points] = LAYER_IDS(layer);
    const source = "atlas-" + layer;
    const visibility = layerState.has(layer) ? "visible" : "none";
    const size = { events: 7, communities: 6, merchants: 4.5 }[layer];
    map.addSource(source, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterRadius: layer === "merchants" ? 46 : 36,
      clusterMaxZoom: layer === "merchants" ? 14 : 9,
    });
    map.addLayer({
      id: clusters,
      type: "circle",
      source,
      filter: ["has", "point_count"],
      layout: { visibility },
      paint: {
        "circle-color": color,
        "circle-opacity": layer === "merchants" ? 0.78 : 0.9,
        "circle-radius": ["step", ["get", "point_count"], 13, 10, 16, 100, 21, 1000, 27],
        "circle-stroke-width": 2,
        "circle-stroke-color": halo,
      },
    });
    map.addLayer({
      id: count,
      type: "symbol",
      source,
      filter: ["has", "point_count"],
      layout: { visibility, "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
      paint: { "text-color": halo },
    });
    map.addLayer({
      id: points,
      type: "circle",
      source,
      filter: ["!", ["has", "point_count"]],
      layout: { visibility },
      paint: {
        "circle-color": color,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, size * 0.8, 14, size * 1.4],
        "circle-stroke-width": layer === "merchants" ? 1 : 2,
        "circle-stroke-color": halo,
      },
    });
    if (layerState.has(layer)) fillLayer(layer);
  }
}

async function fillLayer(layer) {
  const status = document.querySelector(`[data-layer-status="${layer}"]`);
  try {
    if (status) status.textContent = T.loading;
    const list = await features(layer);
    map.getSource("atlas-" + layer)?.setData({ type: "FeatureCollection", features: list });
    if (status) status.textContent = num(list.length);
  } catch {
    if (status) status.textContent = "!";
  }
}

function setLayer(layer, on) {
  on ? layerState.add(layer) : layerState.delete(layer);
  if (!EMBED) store("atlas-layers", [...layerState].join(","));
  for (const id of LAYER_IDS(layer)) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  if (on && map.getSource("atlas-" + layer)) fillLayer(layer);
}

function renderLayerControls() {
  const panel = document.getElementById("layer-controls");
  const box = h("div", { class: "panel-body" });
  panel.append(h("details", { open: innerWidth > 760 && !EMBED }, h("summary", { class: "panel-title" }, T.layersTitle), box));
  for (const layer of CFG.layers)
    box.append(
      h(
        "label",
        { class: "layer layer-" + layer },
        h("input", { type: "checkbox", checked: layerState.has(layer), onchange: (ev) => setLayer(layer, ev.target.checked) }),
        h("span", { class: "swatch", "aria-hidden": "true" }),
        h("span", {}, T.layers[layer]),
        h("span", { class: "layer-count", "data-layer-status": layer }),
      ),
    );
  box.append(h("button", { type: "button", class: "reset", onclick: () => map.flyTo({ center: CFG.map.center, zoom: CFG.map.zoom }) }, T.resetView));
}

async function openPopup(layer, feature) {
  popup?.remove();
  const body = h("div", { class: "popup" });
  popup = new maplibregl.Popup({ maxWidth: "320px", focusAfterOpen: true }).setLngLat(feature.geometry.coordinates).setDOMContent(body).addTo(map);
  const id = feature.properties.id;
  if (layer === "merchants") return merchantPopup(body, feature.properties);
  if (layer === "communities") {
    const c = (await load("communities")).communities.find((x) => x.id === id);
    if (c) body.append(...(await communityCard(c, true)).lastChild.childNodes);
    return;
  }
  const e = (await load("events")).events.find((x) => x.id === id);
  if (e) body.innerHTML = eventsHTML([e]);
}

async function merchantPopup(body, p) {
  body.append(h("h3", {}, p.name || "BTC Map #" + p.id));
  const details = h("dl", { class: "details" }, h("dd", { class: "muted" }, T.loading));
  body.append(details, h("p", {}, extLink(`https://btcmap.org/merchant/${encodeURIComponent(p.id)}`, T.viewOnBtcmap + " ↗")));
  // Details come live from BTC Map, so corrections made there show at once.
  try {
    const r = await fetch(`https://api.btcmap.org/v4/places/${encodeURIComponent(p.id)}?fields=address,website,opening_hours`, {
      signal: AbortSignal.timeout(8000),
    });
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

async function renderEvents() {
  const list = document.getElementById("events-list");
  const controls = document.getElementById("events-controls");
  let all;
  try {
    all = filtered((await load("events")).events);
  } catch {
    list.replaceChildren(h("p", { class: "empty" }, T.loadFailed));
    return;
  }
  const state = { when: params.get("when") === "past" ? "past" : "upcoming", country: "", type: "", q: "", limit: PAGE };
  const reset = (k, v) => {
    state[k] = v;
    state.limit = PAGE;
    draw();
  };
  const whenTabs = h(
    "div",
    { class: "segmented", role: "group" },
    ["upcoming", "past"].map((w) => h("button", { type: "button", "data-when": w, onclick: () => reset("when", w) }, T[w])),
  );
  const select = (label, options, key) =>
    h("select", { "aria-label": label, onchange: (ev) => reset(key, ev.target.value) }, h("option", { value: "" }, label), options.map(([v, text]) => h("option", { value: v }, text)));
  const countries = [...new Set(all.map((e) => e.country).filter(Boolean))].sort(byCountryName);
  const types = [...new Set(all.map((e) => e.type))];
  controls.replaceChildren(
    whenTabs,
    ...(EMBED
      ? []
      : [
          h("input", { type: "search", placeholder: T.searchEvents, "aria-label": T.searchEvents, oninput: (ev) => reset("q", ev.target.value.trim().toLowerCase()) }),
          FILTER.country ? null : select(T.allCountries, countries.map((c) => [c, countryName(c, T.locale)]), "country"),
          select(T.allTypes, types.map((t) => [t, T.types[t] || t]), "type"),
        ]),
  );

  function draw() {
    whenTabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.when === state.when)));
    const items = all.filter(
      (e) =>
        (!state.country || e.country === state.country) &&
        (!state.type || e.type === state.type) &&
        (!state.q || [eventTitle(e, LANG), e.city, e.organiser?.name, e.sourceName, countryName(e.country, T.locale)].join(" ").toLowerCase().includes(state.q)),
    );
    const g = groupEvents(items);
    const shown = state.when === "past" ? g.past : g.upcoming;
    let html = shown.length ? eventsHTML(shown.slice(0, state.limit)) : `<p class="empty">${esc(T.noResults)}</p>`;
    if (state.when === "upcoming" && g.planned.length)
      html += `<div class="section-head"><h2 class="sub">${esc(T.planned)}</h2></div>` + eventsHTML(g.planned, "events planned");
    list.innerHTML = html;
    if (shown.length > state.limit)
      list.querySelector("ol").after(h("button", { type: "button", class: "more", onclick: () => { state.limit += PAGE; draw(); } }, T.showMore));
  }
  draw();
}

/* ---------- communities ---------- */

async function communityCard(c, compact = false) {
  const { events } = await load("events").catch(() => ({ events: [] }));
  const upcoming = groupEvents(events.filter((e) => e.community === c.id)).upcoming;
  const links = Object.entries(c.links)
    .filter(([k]) => k !== "website" || !compact)
    .slice(0, compact ? 4 : 8)
    .map(([k, url]) => extLink(url, T.links[k] || k));
  links.push(extLink(c.btcmap, "BTC Map"));
  const logo = c.image
    ? h("img", { class: "logo-img", src: c.image, alt: "", loading: "lazy", decoding: "async", width: 56, height: 56 })
    : h("span", { class: "mono", "aria-hidden": "true" }, [...c.name.replace(/^[^\p{L}\p{N}]+/u, "")][0] || "·");
  return h(
    "article",
    { class: "community" },
    logo,
    h(
      "div",
      {},
      h("p", { class: "kicker" }, h("span", { class: "cat" }, countryName(c.country, T.locale) || c.continent || "")),
      h("h3", {}, extLink(c.links.website || c.btcmap, c.name)),
      upcoming.length
        ? h("p", { class: "next" }, plural(T.eventsCount, upcoming.length, T.locale), ": ", extLink(upcoming[0].url, eventTitle(upcoming[0], LANG)), " · ", dateLabel(upcoming[0], T))
        : null,
      h("p", { class: "links" }, links.flatMap((a, i) => (i ? [" · ", a] : [a]))),
    ),
  );
}

async function renderCommunities() {
  const list = document.getElementById("communities-list");
  const controls = document.getElementById("communities-controls");
  let all;
  try {
    all = filtered((await load("communities")).communities);
  } catch {
    list.replaceChildren(h("p", { class: "empty" }, T.loadFailed));
    return;
  }
  const state = { q: "", country: "", limit: PAGE };
  const reset = (k, v) => {
    state[k] = v;
    state.limit = PAGE;
    draw();
  };
  const countries = [...new Set(all.map((c) => c.country).filter(Boolean))].sort(byCountryName);
  controls.replaceChildren(
    h("input", { type: "search", placeholder: T.searchCommunities, "aria-label": T.searchCommunities, oninput: (ev) => reset("q", ev.target.value.trim().toLowerCase()) }),
    h(
      "select",
      { "aria-label": T.allCountries, onchange: (ev) => reset("country", ev.target.value) },
      h("option", { value: "" }, T.allCountries),
      countries.map((c) => h("option", { value: c }, countryName(c, T.locale))),
    ),
  );
  async function draw() {
    const items = all.filter(
      (c) => (!state.country || c.country === state.country) && (!state.q || (c.name + " " + countryName(c.country, T.locale)).toLowerCase().includes(state.q)),
    );
    const cards = await Promise.all(items.slice(0, state.limit).map((c) => communityCard(c)));
    const parts = [items.length ? h("div", { class: "grid" }, cards) : h("p", { class: "empty" }, T.noResults)];
    if (items.length > state.limit) parts.push(h("button", { type: "button", class: "more", onclick: () => { state.limit += PAGE; draw(); } }, T.showMore));
    list.replaceChildren(...parts);
  }
  draw();
}

/* ---------- ecosystem: category filter over the pre-rendered cards ---------- */

function renderEcosystem() {
  const root = document.getElementById("ecosystem-list");
  const groups = [...root.querySelectorAll("[data-group]")];
  const cats = groups.map((g) => g.dataset.group);
  const buttons = ["", ...cats].map((cat) => h("button", { type: "button", onclick: () => draw(cat) }, cat ? T.categories[cat] || cat : T.all));
  document.getElementById("ecosystem-controls").replaceChildren(...buttons);
  function draw(active) {
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String((i ? cats[i - 1] : "") === active)));
    for (const g of groups) g.hidden = !!active && g.dataset.group !== active;
  }
  draw("");
}

/* ---------- about: embed code generator ---------- */

function renderAbout() {
  const box = document.getElementById("embed-builder");
  const out = h("textarea", { readonly: true, rows: 4, "aria-label": "HTML" });
  const viewSel = h("select", { "aria-label": T.embedView, onchange: update }, ["map", "events"].map((v) => h("option", { value: v }, T.views[v])));
  const countrySel = h("select", { "aria-label": T.embedCountry, onchange: update }, h("option", { value: "" }, T.allCountries));
  load("events")
    .then((d) => countrySel.append(...[...new Set(d.events.map((e) => e.country).filter(Boolean))].sort(byCountryName).map((c) => h("option", { value: c }, countryName(c, T.locale)))))
    .catch(() => {});
  const copy = h(
    "button",
    {
      type: "button",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(out.value);
          copy.textContent = T.embedCopied;
          setTimeout(() => (copy.textContent = T.embedCopy), 1500);
        } catch {
          out.select();
        }
      },
    },
    T.embedCopy,
  );
  copy.className = "btn";
  function update() {
    const u = new URL(CFG.embedURL);
    u.searchParams.set("view", viewSel.value);
    if (countrySel.value) u.searchParams.set("country", countrySel.value);
    const height = viewSel.value === "map" ? 520 : 640;
    out.value = `<iframe src="${esc(u.href)}" title="${esc(CFG.name)}" width="100%" height="${height}" style="border:0;border-radius:8px" loading="lazy" allow="geolocation"></iframe>`;
  }
  box.append(h("div", { class: "row" }, h("label", {}, T.embedView, " ", viewSel), h("label", {}, T.embedCountry, " ", countrySel)), out, copy);
  update();
}

showView(view, false);
