import { test } from "node:test";
import assert from "node:assert/strict";
import { parseICS, zonedToUtc } from "./lib/ical.mjs";
import { inShape, representativePoint, shape } from "./lib/geo.mjs";
import { dedupe, endInstant, groupEvents, toICS } from "../src/shared/events.js";
import { planbDates } from "./harvest/planb.mjs";
import { meetupGroup } from "./harvest/meetup.mjs";
import { fromFeed } from "./harvest/feeds.mjs";

test("time zones convert across daylight saving changes", () => {
  assert.equal(zonedToUtc(2026, 7, 1, 18, 0, 0, "Europe/Vilnius").toISOString(), "2026-07-01T15:00:00.000Z");
  assert.equal(zonedToUtc(2026, 12, 1, 18, 0, 0, "Europe/Vilnius").toISOString(), "2026-12-01T16:00:00.000Z");
  assert.equal(zonedToUtc(2026, 3, 29, 3, 30, 0, "Europe/Paris").toISOString(), "2026-03-29T01:30:00.000Z");
});

test("Meetup calendars are read with their time zone and folded lines", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:event_123@meetup.com",
    "DTSTART;TZID=Europe/Amsterdam:20261105T173000",
    "DTEND;TZID=Europe/Amsterdam:20261105T193000",
    "SUMMARY:Socratic seminar\\, November",
    "URL;VALUE=URI:https://www.meetup.com/bitdevs-amsterdam/events/1",
    " 23/",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:day",
    "DTSTART;VALUE=DATE:20261201",
    "SUMMARY:All day",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const [a, b] = parseICS(ics);
  assert.equal(a.start.iso, "2026-11-05T16:30:00.000Z");
  assert.equal(a.summary, "Socratic seminar, November");
  assert.equal(a.url, "https://www.meetup.com/bitdevs-amsterdam/events/123/");
  assert.deepEqual(b.start, { iso: "2026-12-01", dateOnly: true, timeZone: null });
});

test("Meetup group names come only from meetup.com group URLs", () => {
  assert.equal(meetupGroup("https://www.meetup.com/BitDevs-Amsterdam/"), "BitDevs-Amsterdam");
  assert.equal(meetupGroup("https://meetu.ps/c/4Xp7m/sCFz6/a"), null);
  assert.equal(meetupGroup("https://www.meetup.com/events/123"), null);
  assert.equal(meetupGroup("https://evil.example/meetup.com/x"), null);
});

test("Plan ₿ dates are UTC; local midnight to 23:59 means whole days", () => {
  assert.deepEqual(planbDates("2026-11-04 23:00:00", "2026-11-06 22:59:59", "Europe/Amsterdam"), {
    start: "2026-11-05",
    end: "2026-11-06",
    dateOnly: true,
  });
  const riga = planbDates("2025-08-07 07:00:00", "2025-08-07 17:00:00", "Europe/Riga");
  assert.equal(riga.start, "2025-08-07T07:00:00.000Z");
  assert.equal(riga.dateOnly, false);
  assert.equal(planbDates("2025-01-24", "2025-01-25").dateOnly, true);
  assert.equal(planbDates("soon", null, null), null);
});

test("community feeds skip copies whose canonical page is elsewhere", () => {
  const feed = { url: "https://cypher.example/events/events.json", name: "Cypher", eventPage: "/events/{id}/" };
  assert.equal(fromFeed({ id: "a", title: { en: "A" }, start: "2026-01-01T18:00:00+02:00", canonical: "https://other.example/a/" }, feed), null);
  const own = fromFeed({ id: "b", title: { en: "B", lt: "Bė" }, start: "2026-01-01T18:00:00+02:00", lat: 54.7, lon: 25.3 }, feed);
  assert.equal(own.url, "https://cypher.example/events/b/");
  assert.equal(own.title, "B");
  assert.equal(own.precision, "venue");
  const planned = fromFeed({ id: "c", title: "C", status: "planned" }, feed);
  assert.equal(planned.status, "planned");
  assert.equal(planned.start, null);
});

test("events are grouped by their end, date-only events last the whole day", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const g = groupEvents(
    [
      { id: "1", title: "Today", start: "2026-11-05", dateOnly: true },
      { id: "2", title: "Yesterday", start: "2026-11-04T18:00:00Z" },
      { id: "3", title: "Running", start: "2026-11-04T08:00:00Z", end: "2026-11-06T18:00:00Z" },
      { id: "4", title: "Later", status: "planned" },
    ],
    now,
  );
  assert.deepEqual(g.upcoming.map((e) => e.id), ["3", "1"]);
  assert.deepEqual(g.past.map((e) => e.id), ["2"]);
  assert.deepEqual(g.planned.map((e) => e.id), ["4"]);
  assert.ok(endInstant({ start: "2026-11-05", dateOnly: true }) > Date.parse("2026-11-06T00:00:00Z"));
});

test("the same event from two sources is merged, keeping the precise location", () => {
  const out = dedupe([
    { id: "planb:x", source: "planb", title: "Baltic Honeybadger 2025", start: "2025-08-09", dateOnly: true, lat: 56.95, lon: 24.1, precision: "city" },
    { id: "feed:x", source: "feed:a", title: "Baltic Honeybadger 2025", start: "2025-08-09T10:00:00+03:00", lat: 56.94, lon: 24.11, precision: "venue" },
    { id: "meetup:y", source: "meetup", title: "Bitcoin Riga monthly", start: "2025-08-09T18:00:00+03:00", lat: 56.95, lon: 24.1, precision: "city" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "feed:x");
  assert.deepEqual(out[0].alsoListedBy.map((a) => a.source), ["planb"]);
});

test("calendar export keeps whole-day events as dates", () => {
  const ics = toICS(
    [
      { id: "planb:a", title: "Conf, Riga", start: "2026-08-07", end: "2026-08-08", dateOnly: true, city: "Riga" },
      { id: "x", title: "Talk", start: "2026-08-07T15:00:00Z", status: "confirmed" },
      { id: "p", title: "Soon", status: "planned" },
    ],
    { name: "Atlas", host: "example.org" },
  );
  assert.match(ics, /DTSTART;VALUE=DATE:20260807\r\nDTEND;VALUE=DATE:20260809/);
  assert.match(ics, /SUMMARY:Conf\\, Riga/);
  assert.match(ics, /DTSTART:20260807T150000Z/);
  assert.doesNotMatch(ics, /Soon/);
});

test("community points fall inside their area", () => {
  const ring = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0]];
  const geo = { type: "Polygon", coordinates: [ring] };
  const [lon, lat] = representativePoint(geo);
  assert.ok(inShape(lon, lat, shape(geo)));
});

import { geohashCenter, naddr, npub } from "./harvest/nostr.mjs";
import { lumaSlug } from "./harvest/luma.mjs";

test("Nostr geohashes and addresses", () => {
  const [lon, lat] = geohashCenter("u99zp");
  assert.ok(Math.abs(lat - 54.69) < 0.05 && Math.abs(lon - 25.27) < 0.05, `Vilnius cell: ${lat},${lon}`);
  assert.equal(geohashCenter("ai"), null);
  const pubkey = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
  assert.equal(npub(pubkey), "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6");
  assert.match(naddr({ kind: 31923, pubkey, tags: [["d", "meetup-1"]] }), /^naddr1[02-9ac-hj-np-z]+$/);
});

test("Luma calendar links, not event pages", () => {
  assert.equal(lumaSlug("https://luma.com/freedomlab"), "freedomlab");
  assert.equal(lumaSlug("https://lu.ma/lacasadesatoshi/"), "lacasadesatoshi");
  assert.equal(lumaSlug("https://luma.com/event/evt-123"), null);
  assert.equal(lumaSlug("https://www.meetup.com/x/"), null);
});
