/** Minimal iCalendar (RFC 5545) reader for public event feeds, such as Meetup group calendars. */

/** Convert a wall-clock time in an IANA time zone to a UTC Date. */
export function zonedToUtc(y, mo, d, h, mi, s, timeZone) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes settle the offset, including across daylight-saving changes.
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    const shown = Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
      +parts.second,
    );
    guess += Date.UTC(y, mo - 1, d, h, mi, s) - shown;
  }
  return new Date(guess);
}

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescape(value) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .trim();
}

/** Parse a DTSTART/DTEND property into { iso, dateOnly, timeZone }. */
function parseDate(params, value, fallbackZone) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.VALUE === "DATE")
    return { iso: `${y}-${mo}-${d}`, dateOnly: true, timeZone: null };
  if (z) {
    const date = new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +(s || 0)));
    return { iso: date.toISOString(), dateOnly: false, timeZone: "UTC" };
  }
  const zone = params.TZID || fallbackZone;
  if (!zone) return null;
  try {
    const date = zonedToUtc(+y, +mo, +d, +h, +mi, +(s || 0), zone);
    return { iso: date.toISOString(), dateOnly: false, timeZone: zone };
  } catch {
    return null;
  }
}

/** Return the VEVENT entries of a calendar as plain objects. */
export function parseICS(text) {
  const lines = unfold(String(text)).split("\n");
  const events = [];
  let calZone = null,
    current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.start) events.push(current);
      current = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const [name, ...rawParams] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1);
    const params = Object.fromEntries(
      rawParams.map((p) => {
        const [k, v = ""] = p.split("=");
        return [k.toUpperCase(), v.replace(/^"|"$/g, "")];
      }),
    );
    const key = name.toUpperCase();
    if (!current) {
      if (key === "X-WR-TIMEZONE") calZone = value.trim();
      continue;
    }
    if (key === "UID") current.uid = value.trim();
    else if (key === "SUMMARY") current.summary = unescape(value);
    else if (key === "URL") current.url = value.trim();
    else if (key === "STATUS") current.status = value.trim().toUpperCase();
    else if (key === "LOCATION") current.location = unescape(value);
    else if (key === "DESCRIPTION") current.description = unescape(value);
    else if (key === "GEO") {
      const [lat, lon] = value.split(";").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) current.geo = [lon, lat];
    }
    else if (key === "DTSTART") current.start = parseDate(params, value, calZone);
    else if (key === "DTEND") current.end = parseDate(params, value, calZone);
  }
  return events;
}
