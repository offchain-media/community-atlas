/**
 * Event display, shared by the build (pre-rendered list) and the browser, so both show the same text.
 * Times are shown in the event's time zone, or in UTC when the source gives none.
 */
import { esc, safeURL, safeZone } from "./util.js";
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

export function eventTitle(e, lang) {
  return e.titles?.[lang] || e.title;
}

function link(href, text) {
  const url = safeURL(href);
  return url ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(text)}</a>` : esc(text);
}

/** One event as an HTML list item: picture (or date), labels, title, sources. Every value is escaped. */
export function eventHTML(e, T, lang, tag = "li") {
  const p = dateParts(e, T.locale);
  const where = e.online ? T.online : [e.city, countryName(e.country, T.locale)].filter(Boolean).join(", ");
  const source = e.listing && e.listing !== e.url ? link(e.listing, e.sourceName) : esc(e.sourceName);
  const others = (e.alsoListedBy || []).map((o) => link(o.url, o.sourceName)).join(", ");
  const thumb = e.image
    ? `<div class="thumb${e.imageFit === "contain" ? " logo" : ""}"><img src="${esc(e.image)}" alt="" loading="lazy" decoding="async" width="480" height="270"></div>`
    : `<div class="thumb date" aria-hidden="true">${p ? `<span class="d">${esc(p.day)}</span><span class="m">${esc(p.month)} ${esc(p.year)}</span>` : '<span class="d">?</span>'}</div>`;
  const cityLevel = e.precision === "city" ? ` <span title="${esc(T.cityLevel)}">◌</span>` : "";
  return `<${tag} class="event" data-type="${esc(e.type)}">${thumb}<div class="body"><p class="kicker"><span class="cat">${esc(
    T.types[e.type] || T.types.other,
  )}</span><span>${esc(dateLabel(e, T))}</span>${where ? `<span>${esc(where)}${cityLevel}</span>` : ""}</p><h3>${link(
    e.url,
    eventTitle(e, lang),
  )}</h3><p class="source">${esc(T.listedBy)} ${source}${others ? `, ${esc(T.alsoListedBy)} ${others}` : ""}</p></div></${tag}>`;
}
