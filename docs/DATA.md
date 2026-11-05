# Data

## Sources and rules

- **BTC Map places.** `GET https://api.btcmap.org/v4/places`, deleted places removed. Stored as `[id, lon, lat, name]`; the build adds the country code. The opening hours, address and website shown in a popup are fetched live from BTC Map, so corrections made there appear immediately.
- **BTC Map communities and countries.** `GET https://api.btcmap.org/v3/areas`: areas of type `community`, and country shapes, which give every place, community and Meetup event its country. A community is placed at a point inside its area. Only public channels are kept (website, Meetup, Telegram, X, Nostr and similar). Email, phone, WhatsApp and Signal fields are personal and never republished.
- **Meetup.** For each community whose BTC Map record links a meetup.com group, the public group calendar (`https://www.meetup.com/<group>/events/ical/`) is read. Only title, start, end and link are kept, from 30 days ago to 1 year ahead. The calendar has no coordinates, so events are placed at the community's location and marked as city-level.
- **Luma.** Calendars listed in the profile (`sources.luma`) and any Luma calendar linked from a BTC Map community. The public calendar feed gives title, time, place and coordinates; the event's own page is taken from the description, nothing else of it is kept. Without coordinates, the event is placed in its community's area.
- **Nostr.** Calendar events (NIP-52, kinds 31922 and 31923) carrying one of the profile's hashtags (default `bitcoin`, `btc`), from the profile's relays. Only events with a geohash (`g` tag) or an online location are kept. The city is found from the geohash with Nominatim (cached by 5-character cell). Each event links to njump.me unless it has a web link (`r` tag). Authors' display names come from their Nostr profiles. `data/exclusions.json` lists event ids, author keys or title patterns to leave out.
- **Plan ₿ Network.** The `events/` folder of [PlanB-Network/bitcoin-educational-content](https://github.com/PlanB-Network/bitcoin-educational-content) (CC BY-SA 4.0). Its dates are in UTC, with the event's time zone alongside; a start at local midnight and an end at local 23:59 become whole days. Cities are geocoded once with OpenStreetMap Nominatim (1 request per second) and kept in `data/geocode-cache.json`; events whose city is not found are listed in `notLocated` and shown without a map marker. Each event links to its Plan ₿ source file.
- **Community feeds.** Listed in the profile. An entry whose `canonical` page is on another site is skipped: it is a copy, and the original comes from that other site's feed.
- **Duplicates.** Two events are the same when they start the same day (or within 24 hours), are less than 100 km apart and share at least 60 % of their significant title words. The edition's own event wins, then the most precise location; the other sources stay listed under `alsoListedBy`.

- **Community areas.** BTC Map community outlines, simplified, are written one file per community under `data/areas/`. Events placed at community level (Meetup, Luma without coordinates) show that area on the map, and their place reads "<community> area".
- **Pictures.** Plan ₿ thumbnails (events from the last year onwards), the `image.src` of feed events (relative to the feed file or to the site root) and BTC Map community logos are resized to WebP (480 × 270 for events, 128 × 128 for logos) into `data/images/`, with `data/images/index.json` recording each source so a picture is fetched again only when it changes. The folder is not committed.

A source that fails keeps its previous data; `data/sources/meta.json` records the last success and error of each.

## Event format

`data/events.json` has `{ "generatedAt", "events": [...] }`. Each event:

| Field | Meaning |
|---|---|
| `id` | `<source>:<id at the source>` |
| `source`, `sourceName` | `planb`, `meetup`, `feed:<host>` or `curated`, and a display name |
| `type` | `meetup`, `conference`, `workshop`, `walk`, `course`, `hackathon`, `party` or `other` |
| `status` | `confirmed`, or `planned` when no date is announced |
| `title` | as published; `titles` holds translations when the source has them |
| `start`, `end` | ISO instant, or `YYYY-MM-DD` when `dateOnly` is true (end inclusive) |
| `timeZone` | IANA zone of the event when known |
| `city`, `country` | city name and ISO 3166-1 alpha-2 code |
| `lat`, `lon`, `precision` | location and how precise it is: `venue` or `city` |
| `online` | true for online-only events |
| `url`, `listing` | the event's page, and the page where the source lists it (credited as "Listed by") |
| `organiser`, `community` | `{ name, url }`, and the BTC Map community id when known |
| `image`, `imageFit` | path of the picture served by the atlas; `contain` when it is a community logo |
| `attribution` | `{ name, url, license }` for sources that require it |
| `alsoListedBy` | other sources that published the same event |

## Feed format

A community site can publish its events as a JSON array (or `{ "events": [...] }`) at a stable address. This is the format of Lithuania BTC and the Baltic sites:

```json
[
  {
    "id": "2026-12-03-vilnius-meetup",
    "type": "meetup",
    "title": { "en": "Vilnius Bitcoin meetup", "lt": "Vilniaus Bitcoin susitikimas" },
    "start": "2026-12-03T18:00:00+02:00",
    "end": "2026-12-03T21:00:00+02:00",
    "venue": "Café Example",
    "address": "Gedimino pr. 1, Vilnius",
    "lat": 54.6872, "lon": 25.2797,
    "country": "LT",
    "url": "https://example.org/events/2026-12-03-vilnius-meetup/"
  },
  { "id": "next-walk", "type": "walk", "status": "planned", "title": { "en": "Next Bitcoin walk" } }
]
```

Rules: a stable `id` per event; ISO dates with their UTC offset (or `"dateOnly": true` with `YYYY-MM-DD`); never invent coordinates (leave `lat`/`lon` out, or set `"addressUncertain": true`); `status: "planned"` without dates for an announced but undated event; `canonical` when the event is a copy of another site's page. Serve the file with `Access-Control-Allow-Origin: *` so browsers can read it too.
