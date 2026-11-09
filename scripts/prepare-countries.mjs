/** Rebuild the checked-in map data. No runtime network request to GitHub is needed. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const commit = 'ca3b7150caa5d3cc3fb108a87fc6e3d57bd97d99';
const sourceUrl = `https://raw.githubusercontent.com/datasets/geo-countries/${commit}/data/countries.geojson`;
const sourceSha256 = '392a03db8aa3ba82c105852655620129b11182b95dfc34ef046827ea7d0e5b8c';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const codes = JSON.parse(await readFile(path.join(root, 'src/data/country-codes.json'), 'utf8'));
if (codes.length !== 195 || new Set(codes).size !== 195) throw new Error('Expected exactly 195 unique country codes');

const cachePath = path.join(root, '.cache/geodata', `${commit}.geojson`);
let source;
try { source = await readFile(cachePath); } catch { /* A clean checkout fetches once. */ }
if (!source || hash(source) !== sourceSha256) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GeoJSON download failed: HTTP ${response.status}`);
  source = Buffer.from(await response.arrayBuffer());
  if (hash(source) !== sourceSha256) throw new Error('Source checksum differs from the pinned source');
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, source);
}

const collection = JSON.parse(source);
const byCode = new Map(codes.map((code) => [code, []]));
for (const feature of collection.features) {
  const polygons = byCode.get(feature.properties['ISO3166-1-Alpha-2']);
  if (!polygons) continue;
  if (feature.geometry.type === 'Polygon') polygons.push(feature.geometry.coordinates);
  else if (feature.geometry.type === 'MultiPolygon') polygons.push(...feature.geometry.coordinates);
  else throw new Error(`Unexpected geometry type ${feature.geometry.type}`);
}
for (const [code, polygons] of byCode) {
  if (!polygons.length) throw new Error(`Country ${code} has no polygons`);
  for (const polygon of polygons) for (const ring of polygon) {
    if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
      throw new Error(`Unclosed/degenerate ring in ${code}`);
    }
    for (let index = 0; index < ring.length; index++) {
      const [longitude, latitude] = ring[index];
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
        throw new Error(`Invalid coordinate in ${code}`);
      }
      if (index && Math.abs(longitude - ring[index - 1][0]) > 180) throw new Error(`Uncut antimeridian edge in ${code}`);
    }
  }
}

function ringInfo(ring) {
  let crossSum = 0, xSum = 0, ySum = 0;
  for (let index = 1; index < ring.length; index++) {
    const [x0, y0] = ring[index - 1];
    const [x1, y1] = ring[index];
    const cross = x0 * y1 - x1 * y0;
    crossSum += cross;
    xSum += (x0 + x1) * cross;
    ySum += (y0 + y1) * cross;
  }
  const center = crossSum === 0 ? ring[0] : [xSum / (3 * crossSum), ySum / (3 * crossSum)];
  // Latitude correction prevents high-latitude islands winning solely by angular area.
  return { area: Math.abs(crossSum) * Math.cos(center[1] * Math.PI / 180), center };
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(point, polygon) {
  return inRing(point, polygon[0]) && !polygon.slice(1).some((ring) => inRing(point, ring));
}

function bounds(ring) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [x, y] of ring) {
    west = Math.min(west, x); east = Math.max(east, x);
    south = Math.min(south, y); north = Math.max(north, y);
  }
  return [west, south, east, north];
}

function interiorCenter(polygon, candidate) {
  if (inPolygon(candidate, polygon)) return candidate;
  const [west, south, east, north] = bounds(polygon[0]);
  let best;
  // Intersect several horizontal scanlines with outer and inner rings. Even-odd
  // intervals give real interior points without adding a geometry dependency.
  for (const fraction of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
    const y = south + (north - south) * fraction;
    const intersections = [];
    for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
      const [x0, y0] = ring[i - 1], [x1, y1] = ring[i];
      if ((y0 > y) !== (y1 > y)) intersections.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const width = intersections[i + 1] - intersections[i];
      const point = [(intersections[i + 1] + intersections[i]) / 2, y];
      const score = width / Math.max(east - west, 1e-10) - Math.abs(fraction - 0.5) * 0.15;
      if (inPolygon(point, polygon) && (!best || score > best.score)) best = { point, score };
    }
  }
  if (!best) throw new Error('Could not determine a representative interior point');
  return best.point;
}

const unwrap = (longitude, origin) => origin + ((((longitude - origin) + 180) % 360 + 360) % 360 - 180);
const mercatorY = (latitude) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, latitude)) * Math.PI / 360));

function viewpoint(polygons, code) {
  const main = polygons.map((polygon) => ({ polygon, ...ringInfo(polygon[0]) })).sort((a, b) => b.area - a.area)[0];
  const center = interiorCenter(main.polygon, main.center);
  const mainBounds = bounds(main.polygon[0]);
  const longitudeRadius = Math.max(8, (mainBounds[2] - mainBounds[0]) * 1.5);
  const latitudeRadius = Math.max(8, (mainBounds[3] - mainBounds[1]) * 1.5);
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  // Alaska/Aleutians and Svalbard otherwise force nearly global camera extents.
  // This changes the representative view only, never the rendered geometry.
  const cameraPolygons = ['US', 'NO'].includes(code) ? [main.polygon] : polygons;
  for (const polygon of cameraPolygons) {
    const info = ringInfo(polygon[0]);
    if (Math.abs(unwrap(info.center[0], center[0]) - center[0]) > longitudeRadius || Math.abs(info.center[1] - center[1]) > latitudeRadius) continue;
    for (const [lng, lat] of polygon[0]) {
      const x = unwrap(lng, center[0]);
      west = Math.min(west, x); east = Math.max(east, x);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
  }
  const span = Math.max((east - west) / 360, (mercatorY(north) - mercatorY(south)) / (2 * Math.PI));
  const zoom = Math.max(1.25, Math.min(13, Math.log2(0.62 / Math.max(span, 1e-8))));
  return { center: center.map((number) => +number.toFixed(6)), zoom: +zoom.toFixed(2) };
}

const features = codes.map((code) => ({
  type: 'Feature', id: code, properties: { iso2: code },
  geometry: { type: 'MultiPolygon', coordinates: byCode.get(code) },
}));
const geojson = JSON.stringify({ type: 'FeatureCollection', features });
const geography = codes.map((code) => ({ code, ...viewpoint(byCode.get(code), code) }));
const manifest = {
  source: 'datasets/geo-countries (Natural Earth 1:10m Admin 0)',
  sourceUrl, commit, sourceSha256,
  sourceLicense: 'https://www.naturalearthdata.com/about/terms-of-use/',
  catalog: '193 UN member states + Holy See (VA) + Palestine (PS)',
  featureCount: features.length,
  geojsonSha256: hash(geojson),
  geographySha256: hash(JSON.stringify(geography, null, 2) + '\n'),
  bytes: Buffer.byteLength(geojson),
  transformation: 'Filter catalog ISO2; group same-country parts into MultiPolygon; retain all original vertices, holes and antimeridian cuts; remove unused properties; minify JSON.',
};
await mkdir(path.join(root, 'public/data'), { recursive: true });
await writeFile(path.join(root, 'public/data/countries.geojson'), geojson);
await writeFile(path.join(root, 'public/data/countries.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(root, 'src/data/country-geography.json'), JSON.stringify(geography, null, 2) + '\n');
console.log(`Prepared ${features.length} countries (${(manifest.bytes / 1_000_000).toFixed(2)} MB). SHA-256: ${manifest.geojsonSha256}`);
