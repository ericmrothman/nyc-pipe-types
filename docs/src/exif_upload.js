// Media intake. Photos: read GPS from EXIF in memory, then re-encode through a canvas so the
// uploaded copy carries no metadata at all. 3D scans (.glb): kept as-is, with a size cap.

import { isInNyc, NYC_BOUNDS } from './state.js';

const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.mjs';
export const MAX_EDGE_PX = 1000;
export const JPEG_QUALITY = 0.82;
const ACCEPTED = /^image\/(jpeg|png|webp|heic|heif)$/i;

let exifrPromise = null;
const loadExifr = () => (exifrPromise ||= import(EXIFR_URL).then((m) => m.default || m));

/**
 * @returns {Promise<{ lat: number, lng: number } | null>} GPS from the file, or null when absent/unreadable.
 */
export async function readGps(file) {
  try {
    const exifr = await loadExifr();
    const gps = await exifr.gps(file);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) return { lat: gps.latitude, lng: gps.longitude };
  } catch (err) {
    console.warn('[pipes] EXIF read failed', err);
  }
  return null;
}

/** Re-encodes the image at <= MAX_EDGE_PX as JPEG. Canvas output never includes EXIF. */
export async function sanitizeImage(file, { maxEdge = MAX_EDGE_PX, quality = JPEG_QUALITY } = {}) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Couldn’t read that image file.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = source.width; const h0 = source.height;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const width = Math.round(w0 * scale); const height = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  source.close?.();
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t read that image file.'))), 'image/jpeg', quality));
  return { blob, url: URL.createObjectURL(blob), width, height };
}

/**
 * Turns a dropped/chosen file into the start of a draft.
 * @returns {Promise<{ photo, gps: {lat,lng}|null, hasExif: boolean, outsideNyc: boolean }>}
 */
export async function intakePhoto(file) {
  if (!file) throw new Error('No photo chosen.');
  if (file.type && !ACCEPTED.test(file.type)) throw new Error('Use a photo (JPEG, PNG, HEIC, WebP) or a 3D scan.');
  if (file.size > 40 * 1024 * 1024) throw new Error('File is over 40MB.');
  const [gps, photo] = await Promise.all([readGps(file), sanitizeImage(file)]);
  if (gps && isInNyc(gps.lat, gps.lng)) {
    return { photo, gps, hasExif: true, outsideNyc: false };
  }
  if (gps) {
    return { photo, gps: null, hasExif: false, outsideNyc: true }; // GPS exists, but not in the five boroughs
  }
  return { photo, gps: null, hasExif: false, outsideNyc: false };
}

export const MAX_MODEL_BYTES = 25 * 1024 * 1024;

/** True for a glTF binary scan, whether the browser labels it or not (most don't). */
export const isModelFile = (file) => Boolean(file) && (/\.glb$/i.test(file.name || '') || file.type === 'model/gltf-binary');

/** Takes a .glb as the pipe's 3D scan. */
export function intakeModel(file) {
  if (file.size > MAX_MODEL_BYTES) throw new Error('3D scan is over 25MB.');
  const blob = file.type === 'model/gltf-binary' ? file : new Blob([file], { type: 'model/gltf-binary' });
  return { blob, url: URL.createObjectURL(blob), name: file.name || 'scan.glb', size: file.size };
}

const ARCGIS = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';

/**
 * NYC address or cross-street search. ArcGIS understands intersections ("7th and 1st ave",
 * "ave a & e 4th") as well as street addresses; OpenStreetMap Nominatim is the fallback.
 * @returns {Promise<{ label: string, lat: number, lng: number }[]>}
 */
export async function searchNycPlace(query, { signal } = {}) {
  const q = query.trim();
  if (q.length < 3) return [];
  try {
    return await searchArcgis(q, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('[pipes] ArcGIS search failed, trying Nominatim', err);
    return searchNominatim(q, signal);
  }
}

async function searchArcgis(q, signal) {
  const url = new URL(`${ARCGIS}/findAddressCandidates`);
  url.search = new URLSearchParams({
    SingleLine: `${q}, New York, NY`, f: 'json', maxLocations: '6',
    searchExtent: `${NYC_BOUNDS.west},${NYC_BOUNDS.south},${NYC_BOUNDS.east},${NYC_BOUNDS.north}`,
  }).toString();
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`ArcGIS ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'ArcGIS error');
  const seen = new Set();
  return (data.candidates || [])
    .map((c) => ({ label: String(c.address || '').replace(/, USA$/, ''), lat: Number(c.location?.y), lng: Number(c.location?.x) }))
    .filter((r) => r.label && isInNyc(r.lat, r.lng))
    .filter((r) => {
      const key = `${r.label}|${r.lat.toFixed(5)}|${r.lng.toFixed(5)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function searchNominatim(q, signal) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({
    q, format: 'jsonv2', limit: '5', bounded: '1', countrycodes: 'us',
    viewbox: `${NYC_BOUNDS.west},${NYC_BOUNDS.north},${NYC_BOUNDS.east},${NYC_BOUNDS.south}`,
  }).toString();
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Address search is unavailable right now.');
  const rows = await res.json();
  return rows
    .map((r) => ({ label: r.display_name.split(', ').slice(0, 3).join(', '), lat: Number(r.lat), lng: Number(r.lon) }))
    .filter((r) => isInNyc(r.lat, r.lng));
}

/** The nearest street address to a point, or null (offline, nothing nearby). Never throws. */
export async function reverseGeocodeNyc(lat, lng, { signal } = {}) {
  try {
    const res = await fetch(`${ARCGIS}/reverseGeocode?location=${lng},${lat}&f=json`, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.address?.Address || data.address?.Match_addr || null;
  } catch {
    return null;
  }
}

/** 40.72478° N, 73.98089° W */
export const fmtCoords = ({ lat, lng }) =>
  `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? 'E' : 'W'}`;
