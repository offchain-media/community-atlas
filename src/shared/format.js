/**
 * Event display, shared by the build (pre-rendered list) and the browser, so both show the same text.
 * Times are shown in the event's time zone, or in UTC when the source gives none.
 */
import { esc, fmt, safeURL, safeZone } from "./util.js";
import { startInstant } from "./events.js";

const UTC_DAY = (d) => new Date(Date.parse(d.slice(0, 10) + "T00:00:00Z"));

function dateParts(e, locale) {
  const t = startInstant(e);
  if (!t) return null;
  const timeZone = e.dateOnly ? "UTC" : safeZone(e.timeZone);
  const part = (o) => new Intl.DateTimeFormat(locale, { timeZone, ...o }).format(new Date(t));
  return { day: part({ day: "numeric" }), month: part({ month: "short" }), year: part({ year: "numeric" }) };
}

export function dateLabel(e, T) {
  if (!e.start) return T.planned;
  const opts = { day: "numeric", month: "long", year: "numeric" };
  if (e.dateOnly) {
    const f = new Intl.DateTimeFormat(T.locale, { ...opts, timeZone: "UTC" });
    const a = UTC_DAY(e.start);
    const b = e.end ? UTC_DAY(e.end) : null;
    return b && b > a ? f.formatRange(a, b) : f.format(a);
  }
  return new Intl.DateTimeFormat(T.locale, {
    ...opts,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: safeZone(e.timeZone),
    timeZoneName: "short",
  }).format(new Date(e.start));
}

export function countryName(code, locale) {
  if (!code) return "";
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code);
  } catch {
    return code;
  }
}

/** Where the event takes place, as precisely as the source allows. */
export function whereLabel(e, T, withVenue = false) {
  if (e.online) return T.online;
  const country = countryName(e.country, T.locale);
  if (e.precision === "city" && e.zone && !e.city) return [fmt(T.zoneOf, { name: e.zone }), country].filter(Boolean).join(", ");
  return [withVenue && e.venue, e.city, country].filter(Boolean).join(", ");
}

export function eventTitle(e, lang) {
  return e.titles?.[lang] || e.title;
}

function link(href, text) {
  const url = safeURL(href);
  return url ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(text)}</a>` : esc(text);
}

/** Where an event's own atlas page lives, given the events folder of the page's language. */
export const eventPath = (e, base) => (e.slug && base ? `${base}${e.slug}/` : null);

/** One event as an HTML list item: picture (or date), labels, title, sources. Every value is escaped.
 *  `base` is the events folder of the current language; titles link to the event's atlas page. */
export function eventHTML(e, T, lang, base) {
  const page = eventPath(e, base);
  const p = dateParts(e, T.locale);
  const where = whereLabel(e, T);
  const source = e.listing && e.listing !== e.url ? link(e.listing, e.sourceName) : esc(e.sourceName);
  const others = (e.alsoListedBy || []).map((o) => link(o.url, o.sourceName)).join(", ");
  const inner = e.image
    ? `<img src="${esc(e.image)}" alt="" loading="lazy" decoding="async" width="480" height="270">`
    : p
      ? `<span class="d">${esc(p.day)}</span><span class="m">${esc(p.month)} ${esc(p.year)}</span>`
      : '<span class="d">?</span>';
  const cls = `thumb${e.image ? (e.imageFit === "contain" ? " logo" : "") : " date"}`;
  const thumb = page
    ? `<a class="${cls}" href="${esc(page)}" tabindex="-1" aria-hidden="true">${inner}</a>`
    : `<div class="${cls}" aria-hidden="true">${inner}</div>`;
  const title = page ? `<a href="${esc(page)}">${esc(eventTitle(e, lang))}</a>` : link(e.url, eventTitle(e, lang));
  const cityLevel = e.precision === "city" ? ` <span title="${esc(T.cityLevel)}">◌</span>` : "";
  return `<li class="event" data-type="${esc(e.type)}">${thumb}<div class="body"><p class="kicker"><span class="cat">${esc(
    T.types[e.type] || T.types.other,
  )}</span><span>${esc(dateLabel(e, T))}</span>${where ? `<span>${esc(where)}${cityLevel}</span>` : ""}</p><h3>${title}</h3><p class="source">${esc(T.listedBy)} ${source}${others ? `, ${esc(T.alsoListedBy)} ${others}` : ""}</p></div></li>`;
}
