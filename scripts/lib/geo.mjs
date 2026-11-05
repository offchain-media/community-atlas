/** Small geometry helpers for GeoJSON from BTC Map areas. No dependencies. */

/** Return the list of polygons (each an array of rings) in any GeoJSON object. */
export function polygons(geo) {
  if (!geo) return [];
  if (geo.type === "FeatureCollection")
    return geo.features.flatMap((f) => polygons(f));
  if (geo.type === "Feature") return polygons(geo.geometry);
  if (geo.type === "Polygon") return [geo.coordinates];
  if (geo.type === "MultiPolygon") return geo.coordinates;
  if (geo.type === "GeometryCollection")
    return geo.geometries.flatMap((g) => polygons(g));
  return [];
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}

function ringCentroid(ring) {
  let x = 0,
    y = 0,
    a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    x += (ring[j][0] + ring[i][0]) * f;
    y += (ring[j][1] + ring[i][1]) * f;
    a += f;
  }
  if (!a) {
    const n = ring.length || 1;
    return [
      ring.reduce((s, p) => s + p[0], 0) / n,
      ring.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [x / (3 * a), y / (3 * a)];
}

/** Point inside the largest polygon of the shape (its centroid, or a vertex average when the centroid falls outside). */
export function representativePoint(geo) {
  const polys = polygons(geo).filter((p) => p[0]?.length >= 3);
  if (!polys.length) return null;
  const largest = polys.reduce((a, b) =>
    Math.abs(ringArea(b[0])) > Math.abs(ringArea(a[0])) ? b : a,
  );
  const c = ringCentroid(largest[0]);
  if (inPolygon(c[0], c[1], largest)) return round(c);
  const n = largest[0].length;
  const avg = [
    largest[0].reduce((s, p) => s + p[0], 0) / n,
    largest[0].reduce((s, p) => s + p[1], 0) / n,
  ];
  return round(inPolygon(avg[0], avg[1], largest) ? avg : largest[0][0]);
}

const round = ([x, y]) => [+x.toFixed(5), +y.toFixed(5)];

export function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i],
      [px, py] = ring[j];
    if (y > lat !== py > lat && lon < ((px - x) * (lat - y)) / (py - y) + x)
      inside = !inside;
  }
  return inside;
}

export function inPolygon(lon, lat, poly) {
  return inRing(lon, lat, poly[0]) && !poly.slice(1).some((r) => inRing(lon, lat, r));
}

export function bbox(geo) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polygons(geo))
    for (const [x, y] of poly[0]) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  return b.every(Number.isFinite) ? b : null;
}

export function inBbox(lon, lat, b) {
  return lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3];
}

/** Is the point inside the shape? Uses a precomputed bbox when given. */
export function inShape(lon, lat, shape) {
  if (shape.bbox && !inBbox(lon, lat, shape.bbox)) return false;
  return shape.polygons.some((p) => inPolygon(lon, lat, p));
}

/** Prepare a shape for repeated point tests. */
export function shape(geo) {
  return { polygons: polygons(geo), bbox: bbox(geo) };
}

/** Great-circle distance in kilometres. */
export function distanceKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r,
    dLon = (b[0] - a[0]) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Reduce coordinate precision to shrink stored geometry (about 100 m at 3 decimals). */
export function simplify(geo, digits = 3) {
  const f = 10 ** digits;
  const walk = (c) =>
    typeof c[0] === "number"
      ? [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f]
      : c.map(walk);
  return polygons(geo).map((poly) =>
    poly.map((ring) =>
      walk(ring).filter(
        (p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1],
      ),
    ),
  );
}
