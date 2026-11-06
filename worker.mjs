/**
 * Cloudflare Worker in front of the static build.
 * - Serves the atlas under its paths (for example offchain.media/atlas/ and /fr/atlas/).
 * - Opens the data and the calendar to other sites (CORS), so communities can reuse them.
 * - Lets any site embed /embed/ pages in an iframe; other pages cannot be framed.
 */
const DATA = /\/(data\/[\w.-]+\.json|events\.ics|llms\.txt)$/;
const EMBED = /\/embed\/(index\.html)?$/;

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), payment=(), usb=()",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (DATA.test(url.pathname) && request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [k, v] of Object.entries(SECURITY)) response.headers.set(k, v);
    if (DATA.test(url.pathname)) {
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Cache-Control", "public, max-age=300, must-revalidate");
      if (url.pathname.endsWith(".ics")) response.headers.set("Content-Type", "text/calendar; charset=utf-8");
      if (url.pathname.endsWith(".txt")) response.headers.set("Content-Type", "text/plain; charset=utf-8");
    } else if (EMBED.test(url.pathname)) {
      response.headers.set("Content-Security-Policy", "frame-ancestors " + (env.EMBED_ANCESTORS || "*"));
    } else if ((response.headers.get("Content-Type") || "").includes("text/html")) {
      response.headers.set("X-Frame-Options", "SAMEORIGIN");
      response.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
    }
    if (/\/assets\/.+\.(woff2|js|css)$/.test(url.pathname) && url.search.includes("v="))
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return response;
  },
};
