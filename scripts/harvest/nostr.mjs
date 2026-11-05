/**
 * Calendar events published on Nostr (NIP-52: kind 31922 for whole days, 31923 for timed events),
 * read from public relays and kept when they carry one of the profile's hashtags (default: bitcoin, btc).
 * Anyone can publish there, so data/exclusions.json can drop an event, an author or a title pattern.
 * https://github.com/nostr-protocol/nips/blob/master/52.md
 */
import { resolve } from "node:path";
import { ROOT, SOURCES, fetchJSON, readJSON, sleep, writeJSON } from "../lib/io.mjs";
import { saveIndex, storeImage } from "../lib/images.mjs";
import { safeURL, safeZone } from "../../src/shared/util.js";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.nostr.band"];

/** Collect the events a relay returns for a filter, until EOSE or timeout. */
function query(relay, filter, timeout = 15000) {
  return new Promise((done) => {
    const events = [];
    let ws,
      finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {}
      done(events);
    };
    const timer = setTimeout(finish, timeout);
    try {
      ws = new WebSocket(relay);
    } catch {
      return finish();
    }
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "atlas", filter]));
    ws.onmessage = (m) => {
      try {
        const [type, , event] = JSON.parse(m.data);
        if (type === "EVENT" && event) events.push(event);
        if (type === "EOSE" || type === "CLOSED") finish();
      } catch {}
    };
    ws.onerror = finish;
  });
}

/* geohash (tag "g") → centre point and how precise it is */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export function geohashCenter(hash) {
  let even = true;
  const lat = [-90, 90],
    lon = [-180, 180];
  for (const ch of hash.toLowerCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const range = even ? lon : lat;
      const mid = (range[0] + range[1]) / 2;
      if ((v >> bit) & 1) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }
  return [+((lon[0] + lon[1]) / 2).toFixed(5), +((lat[0] + lat[1]) / 2).toFixed(5)];
}

/* naddr (NIP-19) for a link to the event on njump.me */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i];
  }
  return chk;
}
function bech32(prefix, bytes) {
  const data = [];
  let acc = 0,
    bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) data.push((acc >> (bits -= 5)) & 31);
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const expand = [...prefix].map((c) => c.charCodeAt(0) >> 5).concat(0, [...prefix].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...expand, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return prefix + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}
export function naddr(event, relay) {
  const enc = new TextEncoder();
  const tlv = (type, value) => [type, value.length, ...value];
  const hex = (h) => h.match(/../g).map((x) => parseInt(x, 16));
  const d = event.tags.find((t) => t[0] === "d")?.[1] || "";
  const kind = [(event.kind >> 24) & 255, (event.kind >> 16) & 255, (event.kind >> 8) & 255, event.kind & 255];
  return bech32("naddr", [...tlv(0, [...enc.encode(d)]), ...(relay ? tlv(1, [...enc.encode(relay)]) : []), ...tlv(2, hex(event.pubkey)), ...tlv(3, kind)]);
}
export const npub = (pubkey) => bech32("npub", pubkey.match(/../g).map((x) => parseInt(x, 16)));

const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1];

/** City of a geohash cell, from OpenStreetMap Nominatim (1 request per second), cached by 5-character cell. */
const GEOCODE_CACHE = resolve(ROOT, "data/geocode-cache.json");
async function cityOf(hash, cache) {
  const key = "geohash:" + hash.slice(0, 5);
  if (key in cache) return cache[key];
  const [lon, lat] = geohashCenter(hash.slice(0, 5));
  await sleep(1100);
  try {
    const r = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lon}`, { timeout: 20000 });
    cache[key] = r.address ? { city: r.address.city || r.address.town || r.address.village || r.address.municipality || r.address.county || null, country: r.address.country_code?.toUpperCase() || null } : null;
  } catch {
    return null;
  }
  return cache[key];
}

export async function harvestNostr(options = {}) {
  const relays = options.relays?.length ? options.relays : DEFAULT_RELAYS;
  const hashtags = options.tags?.length ? options.tags : ["bitcoin", "btc"];
  const exclusions = await readJSON(resolve(ROOT, "data/exclusions.json"), {});
  const now = Math.floor(Date.now() / 1000);

  // 1. Calendar events, from every relay; addressable events keep their latest version.
  const seen = new Map();
  const results = await Promise.all(relays.map((r) => query(r, { kinds: [31922, 31923], "#t": hashtags, since: now - 400 * 86400, limit: 3000 }).then((l) => l.map((e) => [e, r]))));
  for (const [e, relay] of results.flat()) {
    const key = `${e.kind}:${e.pubkey}:${tag(e, "d")}`;
    if (!seen.has(key) || seen.get(key)[0].created_at < e.created_at) seen.set(key, [e, relay]);
  }

  // 2. Author names (kind 0), for the organiser line.
  const authors = [...new Set([...seen.values()].map(([e]) => e.pubkey))];
  const names = new Map();
  for (let i = 0; i < authors.length; i += 200) {
    const profiles = (await Promise.all(relays.slice(0, 2).map((r) => query(r, { kinds: [0], authors: authors.slice(i, i + 200) })))).flat();
    for (const p of profiles)
      try {
        const m = JSON.parse(p.content);
        if (!names.has(p.pubkey)) names.set(p.pubkey, String(m.display_name || m.name || "").slice(0, 80));
      } catch {}
  }

  const excluded = (e, title) =>
    (exclusions.events || []).includes(e.id) ||
    (exclusions.authors || []).includes(e.pubkey) ||
    (exclusions.titles || []).some((p) => new RegExp(p, "i").test(title));
  const geocache = await readJSON(GEOCODE_CACHE, {});
  const events = [];
  for (const [e, relay] of seen.values()) {
    const title = (tag(e, "title") || tag(e, "name") || "").trim();
    if (!title || excluded(e, title)) continue;
    let start, end, dateOnly, timeZone;
    if (e.kind === 31922) {
      start = tag(e, "start");
      end = tag(e, "end") || null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "")) continue;
      dateOnly = true;
    } else {
      const s = Number(tag(e, "start")),
        en = Number(tag(e, "end"));
      if (!Number.isFinite(s) || s <= 0) continue;
      start = new Date(s * 1000).toISOString();
      end = Number.isFinite(en) && en > s ? new Date(en * 1000).toISOString() : null;
      dateOnly = false;
      const z = tag(e, "start_tzid");
      timeZone = z && safeZone(z) === z ? z : null;
    }
    const t = Date.parse(start);
    if (!(t > Date.now() - 30 * 86400000 && t < Date.now() + 366 * 86400000)) continue;
    const geohashes = e.tags.filter((x) => x[0] === "g").map((x) => x[1]).sort((a, b) => b.length - a.length);
    const point = geohashes[0] && geohashCenter(geohashes[0]);
    const location = (tag(e, "location") || "").trim();
    const online = !point && (/^https?:/.test(location) || /online|virtual|livestream/i.test(location));
    if (!point && !online) continue; // no place to show
    const address = naddr(e, relay);
    const place = point ? await cityOf(geohashes[0], geocache) : null;
    const link = e.tags.filter((x) => x[0] === "r").map((x) => safeURL(x[1])).find(Boolean);
    const image = safeURL(tag(e, "image"));
    events.push({
      id: "nostr:" + e.id.slice(0, 16),
      source: "nostr",
      sourceName: "Nostr",
      type: /conference|konferenz|summit/i.test(title) ? "conference" : "meetup",
      status: "confirmed",
      title: title.slice(0, 160),
      start,
      end,
      dateOnly,
      timeZone,
      city: place?.city || null,
      country: place?.country || null,
      lon: point?.[0] ?? null,
      lat: point?.[1] ?? null,
      precision: point ? (geohashes[0].length >= 6 ? "venue" : "city") : null,
      online,
      venue: location && !/^https?:/.test(location) ? location.split(",")[0].trim().slice(0, 100) : null,
      url: link || `https://njump.me/${address}`,
      listing: `https://njump.me/${address}`,
      organiser: { name: names.get(e.pubkey) || npub(e.pubkey).slice(0, 16) + "…", url: `https://njump.me/${npub(e.pubkey)}` },
      image: image ? await storeImage(image, "events/nostr-" + e.id.slice(0, 16)) : null,
    });
  }
  await saveIndex();
  await writeJSON(GEOCODE_CACHE, Object.fromEntries(Object.entries(geocache).sort()));
  await writeJSON(resolve(SOURCES, "nostr-events.json"), {
    fetchedAt: new Date().toISOString(),
    source: `NIP-52 calendar events tagged ${hashtags.map((h) => "#" + h).join(", ")} on ${relays.join(", ")}`,
    events,
  });
  return { found: seen.size, events: events.length };
}
