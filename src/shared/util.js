/** Helpers shared by the build scripts and the browser. */

export function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** The URL if it is http(s), otherwise null. */
export function safeURL(value) {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Replace {name} placeholders. */
export const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

/** Pick the plural form of a { one, other } string and fill {n}. */
export function plural(forms, n, locale) {
  const form = typeof forms === "string" ? forms : forms[new Intl.PluralRules(locale).select(n)] || forms.other;
  return fmt(form, { n: new Intl.NumberFormat(locale).format(n) });
}

/** A time zone name usable by Intl, or UTC. */
export function safeZone(zone) {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
