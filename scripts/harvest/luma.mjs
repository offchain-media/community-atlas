/**
 * Luma calendars: those linked from BTC Map communities (any lu.ma or luma.com link) and those listed
 * in the profile (sources.luma). Each calendar's public iCalendar feed gives the venue and coordinates.
 * Only the title, time, place and link are kept; descriptions belong to their organisers.
 */
import { resolve } from "node:path";
import { SOURCES, fetchText, readJSON, sleep, writeJSON } from "../lib/io.mjs";
import { parseICS } from "../lib/ical.mjs";
import { safeURL } from "../../src/shared/util.js";

const LUMA = /^https?:\/\/(www\.)?(lu\.ma|luma\.com)\/([\w-]+)\/?$/;

/** The calendar slug of a Luma calendar page URL, or null for event pages and other links. */
export function lumaSlug(url) {
  const m = LUMA.exec(String(url || "").trim());
  return m ? m[3] : null;
}

/** City from the "Address:" block Luma puts in descriptions ("…\nCity, Region\nCountry"). */
function cityFrom(description) {
  const block = /Address:\n([\s\S]*?)(\n\n|$)/.exec(description || "")?.[1];
  const lines = block?.split("\n").map((l) => l.trim()).filter(Boolean) || [];
  return lines.length >= 3 ? lines[lines.length - 2].split(",")[0].trim() || null : null;
}

export async function harvestLuma(listed = [], { horizonDays = 365 } = {}) {
  const { communities } = await readJSON(resolve(SOURCES, "btcmap-communities.json"), { communities: [] });
  const calendars = new Map();
  for (const c of listed) {
    const slug = lumaSlug(c.url);
    if (slug) calendars.set(slug, { slug, name: c.name, community: null });
  }
  for (const c of communities)
    for (const link of Object.values(c.links)) {
      const slug = lumaSlug(link);
      if (slug && !calendars.has(slug)) calendars.set(slug, { slug, name: c.name, community: c });
    }

  const now = Date.now(),
    horizon = now + horizonDays * 86400000;
  const events = [],
    failures = [];
  for (const cal of calendars.values()) {
    await sleep(1000);
    try {
      const page = await fetchText(`https://luma.com/${cal.slug}`, { timeout: 20000 });
      const id = /"calendar_api_id":"(cal-[A-Za-z0-9]+)"/.exec(page)?.[1];
      if (!id) throw new Error("not a calendar page");
      const ics = await fetchText(`https://api.lu.ma/ics/get?entity=calendar&id=${id}`, { timeout: 20000 });
      for (const e of parseICS(ics)) {
        if (!e.uid || e.status === "CANCELLED" || !e.start || e.start.dateOnly) continue;
        const t = Date.parse(e.start.iso);
        if (t < now - 30 * 86400000 || t > horizon) continue;
        const link = safeURL(/https:\/\/(?:lu\.ma|luma\.com)\/[\w-]+/.exec(e.description || "")?.[0]);
        const c = cal.community;
        const online = !e.geo && /zoom|online|google meet|youtube|virtual/i.test(e.location || "");
        events.push({
          id: "luma:" + e.uid.replace(/@.*$/, ""),
          source: "luma",
          sourceName: "Luma",
          type: "meetup",
          status: "confirmed",
          title: e.summary || cal.name,
          start: e.start.iso,
          end: e.end?.iso || null,
          dateOnly: false,
          timeZone: null,
          city: e.geo ? cityFrom(e.description) : null,
          country: e.geo ? null : c?.country || null,
          lon: e.geo?.[0] ?? c?.lon ?? null,
          lat: e.geo?.[1] ?? c?.lat ?? null,
          precision: e.geo ? "venue" : c ? "city" : null,
          online,
          // Luma replaces hidden addresses with a link: keep only real place names.
          venue: e.geo && !/^https?:/.test(e.location || "") ? (e.location || "").split(",")[0].trim() || null : null,
          url: link || `https://luma.com/${cal.slug}`,
          listing: `https://luma.com/${cal.slug}`,
          organiser: { name: cal.name, url: `https://luma.com/${cal.slug}` },
          community: c?.id || null,
          zone: e.geo ? null : c?.name || null,
          image: c?.image || null,
        });
      }
    } catch (error) {
      failures.push({ calendar: cal.slug, error: String(error.message || error) });
    }
  }
  await writeJSON(resolve(SOURCES, "luma-events.json"), {
    fetchedAt: new Date().toISOString(),
    source: "Luma calendars listed in the profile or linked from BTC Map communities",
    calendars: [...calendars.keys()],
    failures,
    events,
  });
  return { calendars: calendars.size, events: events.length, failures: failures.length };
}
