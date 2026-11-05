/**
 * BTC Map: places that accept Bitcoin, communities and country shapes.
 * Data: OpenStreetMap contributors and BTC Map, ODbL 1.0.
 */
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { SOURCES, fetchJSON, writeJSON } from "../lib/io.mjs";
import { representativePoint, simplify, shape, inShape } from "../lib/geo.mjs";
import { safeURL } from "../../src/shared/util.js";

const API = "https://api.btcmap.org";
// Public channels only. Personal contact fields (email, phone, WhatsApp, Signal) are never republished.
const PUBLIC_LINKS = [
  "website",
  "meetup",
  "telegram",
  "twitter",
  "nostr",
  "instagram",
  "youtube",
  "facebook",
  "discord",
  "github",
  "linkedin",
  "matrix",
  "simplex",
  "eventbrite",
  "rss",
  "geyser",
];

export async function harvestMerchants() {
  const url = `${API}/v4/places?fields=id,lat,lon,name,deleted_at`;
  const all = await fetchJSON(url, { timeout: 180000 });
  if (!Array.isArray(all)) throw new Error("Unexpected BTC Map places response");
  const places = all
    .filter((p) => !p.deleted_at && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => [
      p.id,
      +p.lon.toFixed(5),
      +p.lat.toFixed(5),
      (p.name || "").slice(0, 80),
    ])
    .sort((a, b) => a[0] - b[0]);
  if (places.length < 1000) throw new Error(`Only ${places.length} places; keeping previous file`);
  // One place per line keeps Git diffs small when the file is committed after each refresh.
  const head = JSON.stringify({
    fetchedAt: new Date().toISOString(),
    source: url,
    license: "ODbL-1.0 (OpenStreetMap contributors, BTC Map)",
    fields: ["id", "lon", "lat", "name"],
  }).slice(0, -1);
  await writeFile(
    resolve(SOURCES, "btcmap-merchants.json"),
    `${head},"places":[\n${places.map((p) => JSON.stringify(p)).join(",\n")}\n]}\n`,
  );
  return places.length;
}

export async function harvestAreas() {
  const url = `${API}/v3/areas?updated_since=2000-01-01T00:00:00Z&limit=100000`;
  const areas = (await fetchJSON(url, { timeout: 180000 })).filter(
    (a) => a.tags && !a.deleted_at,
  );
  const countries = areas
    .filter((a) => a.tags.type === "country" && a.tags.iso_a2 && a.tags.geo_json)
    .map((a) => ({
      code: String(a.tags.iso_a2).toUpperCase(),
      name: a.tags.name,
      continent: a.tags.continent || null,
      polygons: simplify(a.tags.geo_json, 3),
    }))
    .filter((c) => /^[A-Z]{2}$/.test(c.code))
    .sort((a, b) => a.code.localeCompare(b.code));
  if (countries.length < 100) throw new Error("Too few countries; keeping previous files");
  const shapes = countries.map((c) => ({
    code: c.code,
    s: shape({ type: "MultiPolygon", coordinates: c.polygons }),
  }));
  const countryAt = (lon, lat) => shapes.find((c) => inShape(lon, lat, c.s))?.code || null;

  const communities = areas
    .filter((a) => a.tags.type === "community" && a.tags.geo_json && a.tags.url_alias)
    .map((a) => {
      const point = representativePoint(a.tags.geo_json);
      if (!point) return null;
      const links = {};
      for (const k of PUBLIC_LINKS) {
        const v = safeURL(a.tags["contact:" + k]);
        if (v) links[k] = v;
      }
      return {
        id: a.tags.url_alias,
        name: a.tags.name,
        lon: point[0],
        lat: point[1],
        country: countryAt(point[0], point[1]),
        continent: a.tags.continent || null,
        links,
        btcmap: `https://btcmap.org/community/${encodeURIComponent(a.tags.url_alias)}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const fetchedAt = new Date().toISOString();
  const license = "ODbL-1.0 (BTC Map)";
  await writeJSON(resolve(SOURCES, "btcmap-countries.json"), { fetchedAt, source: url, license, countries }, false);
  await writeJSON(resolve(SOURCES, "btcmap-communities.json"), { fetchedAt, source: url, license, communities });
  return { countries: countries.length, communities: communities.length };
}
