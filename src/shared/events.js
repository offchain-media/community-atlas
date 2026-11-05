/**
 * Event rules shared by the build scripts and the browser.
 *
 * An event has `start` (ISO instant, or YYYY-MM-DD when `dateOnly`), optional `end`,
 * optional `timeZone` (IANA) and `status` ("confirmed" or "planned").
 * A planned event has no confirmed date and is listed apart.
 */

const DAY = 86400000;

/** Last instant at which the event is still current. */
export function endInstant(event) {
  const last = event.end || event.start;
  if (!last) return null;
  if (event.dateOnly || /^\d{4}-\d{2}-\d{2}$/.test(last)) {
    // A date-only event stays current until that calendar day has ended everywhere (UTC-12).
    const day = Date.parse(last.slice(0, 10) + "T00:00:00Z");
    return Number.isFinite(day) ? day + DAY + 12 * 3600000 - 1 : null;
  }
  const t = Date.parse(last);
  return Number.isFinite(t) ? t : null;
}

export function startInstant(event) {
  if (!event.start) return null;
  const t = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(event.start) ? event.start + "T00:00:00Z" : event.start,
  );
  return Number.isFinite(t) ? t : null;
}

/** Split events into upcoming (soonest first), planned (no date) and past (latest first). */
export function groupEvents(events, now = Date.now()) {
  const planned = [],
    upcoming = [],
    past = [];
  for (const e of events) {
    const end = endInstant(e);
    if (e.status === "planned" || end === null) planned.push(e);
    else if (end >= now) upcoming.push(e);
    else past.push(e);
  }
  upcoming.sort((a, b) => startInstant(a) - startInstant(b));
  past.sort((a, b) => startInstant(b) - startInstant(a));
  planned.sort((a, b) => a.title.localeCompare(b.title));
  return { upcoming, planned, past };
}

const words = (s) =>
  new Set(
    String(s)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\b20\d\d\b/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
const STOP = new Set(["the", "and", "for", "with", "bitcoin", "btc", "meetup", "conference", "edition"]);

/** Likely the same event published by two sources: same first day, close place, similar title. */
export function sameEvent(a, b) {
  if (!a.start || !b.start || a.start.slice(0, 10) !== b.start.slice(0, 10)) {
    const sa = startInstant(a),
      sb = startInstant(b);
    if (!sa || !sb || Math.abs(sa - sb) > DAY) return false;
  }
  if (
    Number.isFinite(a.lat) &&
    Number.isFinite(b.lat) &&
    (Math.abs(a.lat - b.lat) > 1 || Math.abs(a.lon - b.lon) > 1.5)
  )
    return false;
  const wa = words(a.title),
    wb = words(b.title);
  if (!wa.size || !wb.size) return a.title.toLowerCase() === b.title.toLowerCase();
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 0.6;
}

const PRECISION = { venue: 3, city: 2, region: 1 };

/** Merge duplicates, keeping the most precise location and every source link. */
export function dedupe(events) {
  const out = [];
  for (const e of events) {
    const twin = out.find((o) => sameEvent(o, e));
    if (!twin) {
      out.push({ ...e, alsoListedBy: [] });
      continue;
    }
    const better =
      (PRECISION[e.precision] || 0) > (PRECISION[twin.precision] || 0) ||
      (e.source === "curated" && twin.source !== "curated");
    const keep = better ? { ...e, alsoListedBy: twin.alsoListedBy } : twin;
    const other = better ? twin : e;
    keep.alsoListedBy.push({ source: other.source, sourceName: other.sourceName, url: other.url });
    out[out.indexOf(twin)] = keep;
  }
  return out;
}

function icsEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function fold(line) {
  const enc = new TextEncoder();
  let out = "",
    len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > 75) {
      out += "\r\n ";
      len = 1;
    }
    out += ch;
    len += n;
  }
  return out;
}

const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const day = (d) => d.slice(0, 10).replace(/-/g, "");

/** iCalendar text for dated events. */
export function toICS(events, { name, host }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${name}//Community Atlas//EN`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsEscape(name)}`,
  ];
  for (const e of events) {
    if (e.status === "planned" || !e.start) continue;
    lines.push("BEGIN:VEVENT", `UID:${e.id.replace(/[^\w.-]/g, "-")}@${host}`, `DTSTAMP:${stamp(Date.now())}`);
    if (e.dateOnly) {
      const endDay = new Date(Date.parse((e.end || e.start).slice(0, 10) + "T00:00:00Z") + DAY);
      lines.push(
        `DTSTART;VALUE=DATE:${day(e.start)}`,
        `DTEND;VALUE=DATE:${day(endDay.toISOString())}`,
      );
    } else {
      lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end || e.start)}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    const where = [e.venue, e.city, e.country].filter(Boolean).join(", ");
    if (where) lines.push(`LOCATION:${icsEscape(where)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (Number.isFinite(e.lat)) lines.push(`GEO:${e.lat};${e.lon}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.map(fold).join("\r\n");
}
