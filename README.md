# Community Atlas

An open-source map of the Bitcoin community: meetups, conferences, local communities, places that accept bitcoin and Bitcoin-only companies. The data comes from open sources and refreshes itself every 6 hours.

- **Off-Chain Media edition:** https://offchain.media/atlas/ (English) and https://offchain.media/fr/atlas/ (French), from `profiles/offchain-media/`.
- **Fork it** for a city, a country or a region: 1 profile folder holds the name, languages, colours, area and sources.
- **Embed it** on a meetup site without forking: `https://offchain.media/atlas/embed/?view=events&country=LT`.
- **Reuse the data:** JSON and iCalendar files, open to other sites (CORS).

## What it shows and where it comes from

| Layer | Source | Licence | Refresh |
|---|---|---|---|
| Places accepting bitcoin | [BTC Map](https://btcmap.org) (OpenStreetMap) | ODbL 1.0 | every run; details fetched live when a place is opened |
| Communities | [BTC Map communities](https://btcmap.org/communities), public channels only | ODbL 1.0 | every run |
| Meetups | Public Meetup.com calendars linked from BTC Map communities | titles, times and links only | every run |
| Meetups and talks | Luma calendars listed in the profile or linked from BTC Map communities, with their exact place | titles, times, places and links only | every run |
| Meetups | Nostr calendar events (NIP-52) tagged `#bitcoin` or `#btc`, from public relays; `data/exclusions.json` drops spam | public notes | every run |
| Conferences, meetups, workshops | [Plan ₿ Network open event list](https://github.com/PlanB-Network/bitcoin-educational-content/tree/dev/events) | CC BY-SA 4.0 | every run |
| Community events | JSON feeds published by community sites ([format](docs/DATA.md#feed-format)) | each site's terms | every run |
| Your own events | `profiles/<name>/events.json` | yours | on commit |
| Bitcoin-only companies | `profiles/<name>/ecosystem.json`, each entry with a source; only entries read at their source or approved by an editor are published | editorial | on commit |

Event pictures (Plan ₿ thumbnails, community feed covers) and community logos are copied and resized at harvest time into `data/images/` and served by the atlas itself, so visitors load nothing from third-party servers. A Meetup event shows its community's logo. Company logos live in the profile (`logos/`); `node scripts/fetch-logos.mjs` fetches them from the GitHub organisation named in each entry's `github` field.

The same event published by several sources appears once, with links to the others. Every event has its own page in each language (`<path>events/<slug>/`) with schema.org Event data, a calendar file and a link to it on the map. When the event is a copy of a community site's event page, the atlas page points search engines to that original instead. Personal contact fields from BTC Map (email, phone, WhatsApp, Signal) are never republished. Meetup descriptions are not copied. See [docs/DATA.md](docs/DATA.md).

## Run it

Node.js 22 or newer, Python 3 for the preview and Git.

```sh
npm ci
npm run harvest      # refresh every source of the profile into data/sources/
npm run build        # write the site into public/
npm test
npm run preview      # http://127.0.0.1:8817/atlas/
```

The repository holds the last harvested data, so `npm run build` works offline, without pictures until the first `npm run harvest`. Behind an HTTP proxy, run the harvest with `NODE_USE_ENV_PROXY=1` so that Node's `fetch` uses it.

Another profile: `ATLAS_PROFILE=profiles/example-region npm run build`, or `node scripts/build.mjs --profile profiles/example-region`.

## Make your own atlas

1. Fork this repository.
2. Copy `profiles/example-region/` to `profiles/<your-name>/` and edit `profile.json`: name, languages and paths, `origin`, area (`scope`), map view, sources, colours. Every key: [docs/PROFILE.md](docs/PROFILE.md).
3. Optional: `events.json` for events you publish yourself, `ecosystem.json` for a company list, a logo.
4. `ATLAS_PROFILE=profiles/<your-name> npm run harvest && npm run build && npm run preview`.
5. Publish `public/` on any static host, or add the secrets or variables described in `.github/workflows/refresh.yml` to publish automatically to Cloudflare or GitHub Pages. Set the repository variable `ATLAS_PROFILE` to `profiles/<your-name>`.

With an AI assistant that can edit files and run commands, open your fork and say: *"Read AGENTS.md and help me make our community's atlas."*

## Embed it on your site

The About page has a code generator. By hand:

```html
<iframe src="https://offchain.media/atlas/embed/?view=events&country=FR"
        title="Community Atlas" width="100%" height="640" style="border:0" loading="lazy" allow="geolocation"></iframe>
```

| Parameter | Effect |
|---|---|
| `view=map` or `view=events` | map or event list |
| `when=past` | with `view=events`: past events first |
| `country=FR` | country code: filters places, communities and events, and fits the map to the country |
| `community=<BTC Map id>` | only the events of 1 community (the id is the end of its btcmap.org/community/ address) |
| `source=feed:example.org` | only the events of 1 feed |
| `layers=events,communities` | map layers shown at start (`merchants`, `communities`, `events`) |
| `lat`, `lon`, `z` | map position and zoom |
| `theme=dark` or `light` | force a theme |
| `focus=<event id>` | open that event's card on the map (used by "Show on the map" on event pages) |

## Reuse the data

Under the edition's path (for example `https://offchain.media/atlas/`):

- `data/events.json`, `events.ics`: events, and a calendar to subscribe to.
- `data/communities.json`, `data/merchants.json` (`[id, lon, lat, name, country]`), `data/ecosystem.json`, `data/countries.json`.
- `data/meta.json`: counts and update time of each source. `llms.txt`: a summary for language models.

Keep the attributions: OpenStreetMap contributors and BTC Map (ODbL), Plan ₿ Network (CC BY-SA 4.0).

## Add your events

- Publish them on Meetup with your group linked from your BTC Map community, on Plan ₿ Network, or on Nostr as a NIP-52 calendar event tagged `#bitcoin` with a geohash (`g` tag): they appear at the next refresh.
- Using Luma: open the issue "Add our events" with your calendar address, or link it from your BTC Map community.
- Or publish a JSON feed on your own site ([format](docs/DATA.md#feed-format)) and open the issue "Add our events".

## Hosting on offchain.media

`wrangler.jsonc` deploys a Cloudflare Worker named `community-atlas` on the routes `offchain.media/atlas*` and `offchain.media/fr/atlas*` of the existing zone; the rest of offchain.media is untouched. The Worker serves `public/`, opens data files to other sites, and lets only `/embed/` pages be framed. See [docs/HOSTING.md](docs/HOSTING.md).

## Licences

Code: [MIT](LICENSE). Data and third-party assets keep their own terms: [THIRD_PARTY.md](THIRD_PARTY.md). The Off-Chain Media name and logo in `profiles/offchain-media/` are not covered by the MIT licence.
