/**
 * Event feeds published by community sites in the Atlas/Lithuania BTC format
 * (a JSON array of events with id, title, start, end, lat, lon...).
 * Each site stays the owner of its events; the Atlas links back to it.
 */
import { resolve } from "node:path";
import { SOURCES, fetchJSON, writeJSON } from "../lib/io.mjs";
import { safeURL, safeZone } from "../../src/shared/util.js";
import { saveIndex, storeImage } from "../lib/images.mjs";

const pick = (v, lang = "en") =>
  v && typeof v === "object" ? v[lang] || Object.values(v)[0] || "" : String(v || "");

const TYPES = new Set(["meetup", "conference", "workshop", "walk", "course", "hackathon", "party"]);

/** Convert one feed entry; returns null for copies whose canonical page is on another site. */
export function fromFeed(e, feed) {
  const host = new URL(feed.url).hostname;
  if (e.canonical) {
    try {
      if (new URL(e.canonical).hostname !== host) return null;
    } catch {}
  }
  const dated = !!e.start && e.status !== "planned";
  const dateOnly = !!e.dateOnly || /^\d{4}-\d{2}-\d{2}$/.test(e.start || "");
  const lat = Number(e.lat),
    lon = Number(e.lon);
  const located = Number.isFinite(lat) && Number.isFinite(lon) && !e.addressUncertain;
  const listing = dated && feed.eventPage
    ? new URL(feed.eventPage.replace("{id}", encodeURIComponent(e.id)), feed.url).href
    : feed.site || null;
  return {
    id: `feed:${host}:${e.id}`,
    source: "feed:" + host,
    sourceName: feed.name || host,
    type: TYPES.has(e.type) ? e.type : "other",
    status: dated ? "confirmed" : "planned",
    title: pick(e.title).trim(),
    titles: typeof e.title === "object" ? e.title : undefined,
    start: dated ? (dateOnly ? e.start.slice(0, 10) : e.start) : null,
    end: dated && e.end ? (dateOnly ? e.end.slice(0, 10) : e.end) : null,
    dateOnly,
    timeZone: [e.timeZone, feed.timeZone].find((z) => z && safeZone(z) === z) || null,
    city: e.city || null,
    country: e.country || feed.country || null,
    lat: located ? lat : null,
    lon: located ? lon : null,
    precision: located ? (e.locationPrecision === "city" ? "city" : "venue") : null,
    venue: [e.venue, e.address].filter(Boolean).join(", ") || null,
    url: safeURL(e.url) || listing || safeURL(e.website),
    listing,
    organiser: e.organiser ? { name: e.organiser, url: safeURL(e.website) } : { name: feed.name, url: feed.site },
    attribution: { name: feed.name || host, url: feed.site || `https://${host}/` },
  };
}

/** A feed image path may be relative to the feed file or to the site root: try both. */
async function feedImage(src, feed, id) {
  const name = "events/" + id.replace(/[^\w-]/g, "_");
  for (const base of [feed.url, new URL("/", feed.url).href]) {
    const candidate = safeURL(new URL(src, base).href);
    const stored = candidate && (await storeImage(candidate, name));
    if (stored) return stored;
  }
  return null;
}

export async function harvestFeeds(feeds = []) {
  const events = [],
    failures = [];
  for (const feed of feeds) {
    try {
      const data = await fetchJSON(feed.url, { timeout: 20000 });
      const list = Array.isArray(data) ? data : data.events;
      if (!Array.isArray(list)) throw new Error("not an event list");
      for (const e of list) {
        const ev = e && e.id && e.title ? fromFeed(e, feed) : null;
        if (!ev?.title) continue;
        if (e.image?.src) ev.image = await feedImage(e.image.src, feed, ev.id);
        events.push(ev);
      }
    } catch (error) {
      failures.push({ url: feed.url, error: String(error.message || error) });
    }
  }
  await saveIndex();
  const out = resolve(SOURCES, "feed-events.json");
  await writeJSON(out, { fetchedAt: new Date().toISOString(), feeds: feeds.map((f) => f.url), failures, events });
  return { events: events.length, failures: failures.length };
}
