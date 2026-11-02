// PipeRepository: the only module that knows where pipes live.
// Seed pipes (from the walk), Supabase rows (when configured) and localStorage (always available)
// all come out as the same PipeRecord shape, so no UI code ever asks "is this a seed pipe?".

import { SEED_PIPES } from './pipes_seed.js';
import { ALL_TYPE_KEYS, isInNyc, LIMITS } from './state.js';

/**
 * @typedef {{
 *   id: string, lat: number, lng: number, photoUrl: string, fullPhotoUrl: string, modelUrl: string|null,
 *   primaryType: string, allTypes: string[], counts: Record<string, number>, customTag: string|null,
 *   author: string, note: string, createdAt: string, source: 'walk'|'community'|'local',
 *   hasExif: boolean, needsReview: boolean, appreciations: number, canDelete: boolean,
 *   hasPhoto: boolean  // false when the only picture is a snapshot of the 3D scan
 * }} PipeRecord
 * @typedef {{ id: string, pipeId: string, author: string, suggestedType: string|null, body: string, createdAt: string }} FieldNote
 */

export const APPRECIATION_FLUSH_MS = 600;
const KEY = {
  pipes: 'pipeAtlas.v1.pipes',
  claps: 'pipeAtlas.v1.claps',
  notes: 'pipeAtlas.v1.notes',
  secrets: 'pipeAtlas.v1.secrets',
  author: 'pipeAtlas.v1.author',
};
const PIPE_COLUMNS = 'id,lat,lng,photo_url,model_url,primary_type,all_types,counts,custom_tag,author,note,has_exif,needs_review,created_at';

// ---------- tiny safe storage ----------
const store = {
  get(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (err) {
      if (err && /quota/i.test(String(err.name || err.message))) throw new Error('Browser storage is full.');
      return false;
    }
  },
};

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** Like clean(), but a story keeps its paragraphs: line breaks survive, runs of blank lines become one. */
const cleanProse = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').trim()).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const randomSecret = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

function normaliseTypes(types, counts) {
  const all = (types || []).filter((t) => ALL_TYPE_KEYS.includes(t));
  const uniq = [...new Set(all.length ? all : ['mystery'])];
  const c = {};
  for (const t of uniq) c[t] = Math.max(1, Math.min(LIMITS.maxCountPerType, Math.round(Number(counts?.[t]) || 1)));
  return { allTypes: uniq, counts: c };
}

const POSTER_FILE = /#poster$/;

/** Every pipe, whatever its origin, passes through here. */
export function toPipeRecord(raw, { source, secrets = {} }) {
  const { allTypes, counts } = normaliseTypes(raw.allTypes ?? raw.all_types, raw.counts);
  const primary = allTypes.includes(raw.primaryType ?? raw.primary_type) ? (raw.primaryType ?? raw.primary_type) : allTypes[0];
  const ordered = [primary, ...allTypes.filter((t) => t !== primary)];
  const photoUrl = raw.photoUrl ?? raw.photo_url;
  const hasExif = Boolean(raw.hasExif ?? raw.has_exif);
  const modelUrl = raw.modelUrl ?? raw.model_url ?? null;
  // A scan posted on its own gets a snapshot of the scan as its picture. Locally the record says so;
  // in the cloud its photo_url ends in "#poster" (harmless to an <img>), so the table needs no extra column.
  const hasPhoto = !modelUrl || (raw.hasPhoto ?? !POSTER_FILE.test(String(photoUrl || '')));
  return Object.freeze({
    id: String(raw.id),
    lat: Number(raw.lat),
    lng: Number(raw.lng),
    photoUrl,
    fullPhotoUrl: raw.fullPhotoUrl ?? photoUrl,
    modelUrl,
    hasPhoto: Boolean(hasPhoto),
    primaryType: primary,
    allTypes: Object.freeze(ordered),
    counts: Object.freeze(counts),
    customTag: clean(raw.customTag ?? raw.custom_tag, LIMITS.customTag) || null,
    author: clean(raw.author, LIMITS.author), // '' means nobody signed it; the UI then shows no byline
    note: cleanProse(raw.note, LIMITS.note),
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    source,
    hasExif,
    needsReview: Boolean(raw.needsReview ?? raw.needs_review ?? !hasExif),
    appreciations: Math.max(0, Number(raw.appreciations) || 0),
    canDelete: Boolean(secrets[String(raw.id)]),
  });
}

const toFieldNote = (raw) => Object.freeze({
  id: String(raw.id),
  pipeId: String(raw.pipeId ?? raw.pipe_id),
  author: clean(raw.author, LIMITS.author), // shown as 'Anonymous' when blank
  suggestedType: ALL_TYPE_KEYS.includes(raw.suggestedType ?? raw.suggested_type) ? (raw.suggestedType ?? raw.suggested_type) : null,
  body: cleanProse(raw.body, LIMITS.fieldNote),
  createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
});

function groupNotes(notes) {
  const by = {};
  for (const n of notes) (by[n.pipeId] ||= []).push(n);
  for (const k of Object.keys(by)) by[k].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return by;
}

// ---------- 3D scans in practice mode: a tiny IndexedDB store (localStorage tops out around 5MB) ----------
const LOCAL_MODEL = 'idb-model:';
const models = (() => {
  let dbp = null;
  const db = () => (dbp ||= new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('This browser can’t keep 3D scans in practice mode.')); return; }
    const req = indexedDB.open('pipeAtlas', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('models');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = (mode, fn) => db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction('models', mode);
    const req = fn(tx.objectStore('models'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  }));
  return {
    put: (id, blob) => run('readwrite', (s) => s.put(blob, id)),
    get: (id) => run('readonly', (s) => s.get(id)),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
  };
})();

async function resolveLocalModel(ref) {
  if (!ref || !String(ref).startsWith(LOCAL_MODEL)) return ref || null;
  try {
    const blob = await models.get(ref.slice(LOCAL_MODEL.length));
    return blob ? URL.createObjectURL(blob) : null;
  } catch { return null; }
}

// ---------- Supabase over plain REST (no SDK, no build step) ----------
function supabaseClient({ supabaseUrl, supabaseAnonKey, photoBucket = 'pipe-photos' }) {
  const base = supabaseUrl.replace(/\/+$/, '');
  const headers = (extra = {}) => ({ apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}`, ...extra });
  async function call(path, init = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: headers(init.headers) });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    listPipes: () => call(`/rest/v1/pipes?select=${PIPE_COLUMNS}&order=created_at.asc`),
    listClaps: () => call('/rest/v1/appreciations?select=pipe_id,count'),
    listNotes: () => call('/rest/v1/field_notes?select=id,pipe_id,author,suggested_type,body,created_at&order=created_at.asc'),
    async upload(path, blob, contentType) {
      await call(`/storage/v1/object/${photoBucket}/${path}`, { method: 'POST', body: blob, headers: { 'Content-Type': contentType, 'x-upsert': 'false' } });
      return `${base}/storage/v1/object/public/${photoBucket}/${path}`;
    },
    insertPipe: (row) => call(`/rest/v1/pipes?select=${PIPE_COLUMNS}`, {
      method: 'POST', body: JSON.stringify(row), headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    }).then((rows) => rows[0]),
    appreciate: (pipeId, delta) => call('/rest/v1/rpc/appreciate', {
      method: 'POST', body: JSON.stringify({ p_pipe_id: pipeId, p_delta: delta }), headers: { 'Content-Type': 'application/json' },
    }),
    insertNote: (row) => call('/rest/v1/field_notes?select=id,pipe_id,author,suggested_type,body,created_at', {
      method: 'POST', body: JSON.stringify(row), headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    }).then((rows) => rows[0]),
    deletePipe: (id, secret) => call(`/rest/v1/pipes?id=eq.${encodeURIComponent(id)}&select=id`, {
      method: 'DELETE', headers: { 'x-pipe-secret': secret, Prefer: 'return=representation' },
    }),
  };
}

/**
 * @param {{ supabaseUrl?: string, supabaseAnonKey?: string, photoBucket?: string }} config
 */
export function createPipeRepository(config = {}) {
  const cloud = config.supabaseUrl && config.supabaseAnonKey ? supabaseClient(config) : null;
  let cloudLive = false;
  const pending = new Map(); // pipeId -> delta waiting to be written
  let flushTimer = 0;

  const secrets = () => store.get(KEY.secrets, {});

  async function flushAppreciations() {
    flushTimer = 0;
    if (!pending.size) return;
    const batch = [...pending.entries()];
    pending.clear();
    if (cloudLive) {
      await Promise.all(batch.map(async ([id, delta]) => {
        try { await cloud.appreciate(id, delta); } catch (err) {
          console.warn('[pipes] appreciation write failed; will retry', err);
          pending.set(id, (pending.get(id) || 0) + delta);
        }
      }));
      if (pending.size && !flushTimer) flushTimer = setTimeout(flushAppreciations, APPRECIATION_FLUSH_MS * 8);
      return;
    }
    const claps = store.get(KEY.claps, {});
    for (const [id, delta] of batch) claps[id] = (claps[id] || 0) + delta;
    store.set(KEY.claps, claps);
  }
  // Don't lose a frantic last burst of clapping when the tab closes.
  window.addEventListener('pagehide', () => { if (pending.size) { clearTimeout(flushTimer); flushAppreciations(); } });

  return {
    get isCloudLive() { return cloudLive; },

    /** @returns {Promise<{ pipes: PipeRecord[], notesByPipeId: Record<string, FieldNote[]>, isCloudLive: boolean, warning?: string }>} */
    async loadAtlas() {
      const sec = secrets();
      let warning;
      if (cloud) {
        try {
          const [rows, clapRows, noteRows] = await Promise.all([cloud.listPipes(), cloud.listClaps(), cloud.listNotes()]);
          cloudLive = true;
          const claps = Object.fromEntries((clapRows || []).map((r) => [r.pipe_id, Number(r.count) || 0]));
          const seed = SEED_PIPES.map((p) => toPipeRecord({ ...p, appreciations: p.appreciations + (claps[p.id] || 0) }, { source: 'walk' }));
          const community = (rows || []).map((r) => toPipeRecord({ ...r, appreciations: claps[r.id] || 0 }, { source: 'community', secrets: sec }));
          return { pipes: [...seed, ...community], notesByPipeId: groupNotes((noteRows || []).map(toFieldNote)), isCloudLive: true };
        } catch (err) {
          console.warn('[pipes] Supabase unreachable, falling back to this browser', err);
          warning = 'Offline mode: saving to this browser.';
        }
      }
      cloudLive = false;
      const claps = store.get(KEY.claps, {});
      const seed = SEED_PIPES.map((p) => toPipeRecord({ ...p, appreciations: p.appreciations + (claps[p.id] || 0) }, { source: 'walk' }));
      const local = await Promise.all(store.get(KEY.pipes, []).map(async (r) => toPipeRecord({
        ...r, modelUrl: await resolveLocalModel(r.modelUrl), appreciations: (r.appreciations || 0) + (claps[r.id] || 0),
      }, { source: 'local', secrets: sec })));
      const notes = store.get(KEY.notes, []).map(toFieldNote);
      return { pipes: [...seed, ...local], notesByPipeId: groupNotes(notes), isCloudLive: false, warning };
    },

    /** @returns {Promise<PipeRecord>} */
    async createPipe(draft) {
      if (!isInNyc(draft.lat, draft.lng)) throw new Error('That spot is outside the five boroughs.');
      const { allTypes, counts } = normaliseTypes(draft.types, draft.counts);
      const id = crypto.randomUUID();
      const secret = randomSecret();
      const author = clean(draft.author, LIMITS.author);
      const base = {
        id, lat: draft.lat, lng: draft.lng, primaryType: draft.primaryType || allTypes[0], allTypes, counts,
        customTag: clean(draft.customTag, LIMITS.customTag) || null, author, note: cleanProse(draft.note, LIMITS.note),
        hasExif: Boolean(draft.hasExif), hasPhoto: draft.hasPhoto !== false, needsReview: !draft.hasExif, appreciations: 0, createdAt: new Date().toISOString(),
      };
      if (author) store.set(KEY.author, author);
      const sec = secrets();
      if (cloudLive) {
        const photoUrl = await cloud.upload(`${id}.jpg`, draft.photo.blob, 'image/jpeg') + (base.hasPhoto ? '' : '#poster');
        const modelUrl = draft.model ? await cloud.upload(`${id}.glb`, draft.model.blob, 'model/gltf-binary') : null;
        const row = await cloud.insertPipe({
          id, lat: base.lat, lng: base.lng, photo_url: photoUrl, model_url: modelUrl, primary_type: base.primaryType, all_types: [base.primaryType, ...allTypes.filter((t) => t !== base.primaryType)],
          counts, custom_tag: base.customTag, author, note: base.note, has_exif: base.hasExif, owner_secret_hash: await sha256Hex(secret),
        });
        sec[id] = secret; store.set(KEY.secrets, sec);
        return toPipeRecord({ ...row, appreciations: 0 }, { source: 'community', secrets: sec });
      }
      const photoUrl = await blobToDataUrl(draft.photo.blob);
      // 3D scans are megabytes: they go to IndexedDB, and the record only remembers that one exists.
      if (draft.model) await models.put(id, draft.model.blob);
      const record = { ...base, photoUrl, modelUrl: draft.model ? `${LOCAL_MODEL}${id}` : null };
      const list = store.get(KEY.pipes, []);
      store.set(KEY.pipes, [...list, record]);
      sec[id] = secret; store.set(KEY.secrets, sec);
      return toPipeRecord({ ...record, modelUrl: draft.model ? URL.createObjectURL(draft.model.blob) : null }, { source: 'local', secrets: sec });
    },

    /** Optimism lives in the UI; this only batches the write. */
    appreciatePipe(pipeId, delta = 1) {
      pending.set(pipeId, (pending.get(pipeId) || 0) + delta);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushAppreciations, APPRECIATION_FLUSH_MS);
      return Promise.resolve();
    },
    flushNow: () => { clearTimeout(flushTimer); return flushAppreciations(); },

    /** @returns {Promise<FieldNote>} */
    async addFieldNote(pipeId, { author, suggestedType, body }) {
      const row = {
        id: crypto.randomUUID(), pipe_id: pipeId, author: clean(author, LIMITS.author),
        suggested_type: ALL_TYPE_KEYS.includes(suggestedType) ? suggestedType : null, body: cleanProse(body, LIMITS.fieldNote),
      };
      if (!row.body && !row.suggested_type) throw new Error('Write a comment first.');
      if (row.author) store.set(KEY.author, row.author);
      if (cloudLive) return toFieldNote(await cloud.insertNote(row));
      const note = toFieldNote({ ...row, created_at: new Date().toISOString() });
      store.set(KEY.notes, [...store.get(KEY.notes, []), note]);
      return note;
    },

    /** @returns {Promise<boolean>} true when the pipe is gone. */
    async deleteOwnPipe(pipeId) {
      const sec = secrets();
      const secret = sec[pipeId];
      if (!secret) return false;
      if (cloudLive) {
        const gone = await cloud.deletePipe(pipeId, secret);
        if (!gone || !gone.length) return false;
      } else {
        store.set(KEY.pipes, store.get(KEY.pipes, []).filter((p) => p.id !== pipeId));
        await models.remove(pipeId).catch(() => {});
      }
      delete sec[pipeId];
      store.set(KEY.secrets, sec);
      return true;
    },

    rememberedAuthor: () => store.get(KEY.author, '') || '',
  };
}
