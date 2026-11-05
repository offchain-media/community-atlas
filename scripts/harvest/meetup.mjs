/**
 * Meetup.com group calendars of the communities listed on BTC Map.
 * Only the title, time and link of each event are kept; descriptions belong to their organisers.
 * Events are placed at the community's location (city precision), since the feed has no coordinates.
 */
import { resolve } from "node:path";
import { SOURCES, fetchText, pool, readJSON, sleep, writeJSON } from "../lib/io.mjs";
import { parseICS } from "../lib/ical.mjs";

export function meetupGroup(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)meetup\.com$/.test(u.hostname)) return null;
    const group = u.pathname.split("/").filter(Boolean)[0];
    return group && /^[\w-]+$/.test(group) && !["e", "events", "find"].includes(group)
      ? group
      : null;
  } catch {
    return null;
  }
}

export async function harvestMeetup({ horizonDays = 365 } = {}) {
  const { communities } = await readJSON(resolve(SOURCES, "btcmap-communities.json"));
  const groups = new Map();
  for (const c of communities) {
    const g = c.links.meetup && meetupGroup(c.links.meetup);
    if (g && !groups.has(g.toLowerCase())) groups.set(g.toLowerCase(), { group: g, community: c });
  }
  const now = Date.now(),
    horizon = now + horizonDays * 86400000;
  const failures = [];
  const results = await pool([...groups.values()], 3, async ({ group, community }) => {
    await sleep(300);
    try {
      const ics = await fetchText(`https://www.meetup.com/${group}/events/ical/`, { timeout: 20000 });
      return parseICS(ics)
        .filter((e) => e.status !== "CANCELLED" && e.start && !e.start.dateOnly)
        .filter((e) => {
          const t = Date.parse(e.start.iso);
          return t > now - 30 * 86400000 && t < horizon;
        })
        .map((e) => ({
          id: "meetup:" + (e.uid || "").replace(/@.*$/, "").replace(/^event_/, ""),
          source: "meetup",
          sourceName: "Meetup",
          type: "meetup",
          status: "confirmed",
          title: e.summary || community.name,
          start: e.start.iso,
          end: e.end?.iso || null,
          dateOnly: false,
          timeZone: e.start.timeZone,
          city: null,
          country: community.country,
          lon: e.geo?.[0] ?? community.lon,
          lat: e.geo?.[1] ?? community.lat,
          precision: e.geo ? "venue" : "city",
          venue: null,
          url: e.url || `https://www.meetup.com/${group}/events/`,
          organiser: { name: community.name, url: `https://www.meetup.com/${group}/` },
          community: community.id,
        }));
    } catch (error) {
      failures.push({ group, error: String(error.message || error) });
      return [];
    }
  });
  const events = results.flat();
  await writeJSON(resolve(SOURCES, "meetup-events.json"), {
    fetchedAt: new Date().toISOString(),
    source: "Meetup.com group calendars linked from BTC Map communities",
    groups: groups.size,
    failures,
    events,
  });
  return { groups: groups.size, events: events.length, failures: failures.length };
}
