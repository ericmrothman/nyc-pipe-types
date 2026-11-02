// Pure state for the Pipe Atlas. No DOM, no network, no map.
// Every change goes dispatch(action) -> reducePipeState(state, action) -> render().

export const PIPE_TYPES = Object.freeze([
  { key: 'standpipe', label: 'Standpipe', short: 'Standpipe', color: '#FF595E', shape: 'circle' },
  { key: 'oil', label: 'Oil fill / vent', short: 'Oil', color: '#FFCA3A', shape: 'roundsquare' },
  { key: 'air', label: 'Fresh air inlet', short: 'Air inlet', color: '#1982C4', shape: 'triangle' },
  { key: 'box', label: 'Pipe with a box', short: 'Box', color: '#8AC926', shape: 'boxdot' },
  { key: 'steam', label: 'Steamy street pipe', short: 'Steam', color: '#6A4C93', shape: 'diamond' },
  { key: 'mystery', label: 'Mystery pipe', short: 'Mystery', color: '#FF924C', shape: 'hexagon' },
  // A kind the uploader knows but the original five don't cover; its name lives in customTag.
  { key: 'other', label: 'Something else', short: 'Other', color: '#2EC4B6', shape: 'star' },
]);
export const TYPE_BY_KEY = Object.freeze(Object.fromEntries(PIPE_TYPES.map((t) => [t.key, t])));
export const ALL_TYPE_KEYS = Object.freeze(PIPE_TYPES.map((t) => t.key));

export const NYC_BOUNDS = Object.freeze({ south: 40.48, north: 40.93, west: -74.27, east: -73.68 });
export const WALK_CENTER = Object.freeze({ lat: 40.7248, lng: -73.9885 });
export const WALK_ZOOM = 14.5;

export const LIMITS = Object.freeze({ note: 2000, customTag: 40, author: 40, fieldNote: 2000, maxCountPerType: 9 });

export function isInNyc(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= NYC_BOUNDS.south && lat <= NYC_BOUNDS.north &&
    lng >= NYC_BOUNDS.west && lng <= NYC_BOUNDS.east
  );
}

export const REST_FOCUS = Object.freeze({ kind: 'rest' });

/**
 * @typedef {{ kind: 'rest' }
 *   | { kind: 'inspect', pipeId: string }
 *   | { kind: 'compose', draft: Draft }} Focus
 * @typedef {{ photo: { blob: Blob, url: string, width: number, height: number },
 *   lat: number, lng: number, hasExif: boolean, exifLat: number|null, exifLng: number|null,
 *   outsideNyc: boolean, types: string[], counts: Record<string, number>,
 *   customTag: string, author: string, note: string }} Draft
 */

export function initialState({ filters = ALL_TYPE_KEYS, focus = REST_FOCUS } = {}) {
  return {
    loaded: false,
    isCloudLive: false,
    pipes: [],                 // PipeRecord[] (immutable records; appreciation tallies live in `claps`)
    claps: {},                 // pipeId -> appreciations (authoritative display count)
    notesByPipeId: {},         // pipeId -> FieldNote[]
    notesVersion: 0,
    pipesVersion: 0,
    filters: [...filters],     // visible type keys (never empty: locked-last-kind invariant)
    tab: 'top',                // 'top' | 'new'
    focus,
    pendingPipeId: focus.kind === 'inspect' ? focus.pipeId : null,
    lightbox: null,            // url | null
    status: null,              // { text, tone, id } | null
  };
}

let statusSeq = 0;
const say = (text, tone = 'info') => ({ text, tone, id: ++statusSeq });

export function pipeById(state, id) {
  return state.pipes.find((p) => p.id === id) || null;
}

export function isPipeVisible(pipe, filters) {
  return pipe.allTypes.some((t) => filters.includes(t));
}

export function visiblePipes(state) {
  return state.pipes.filter((p) => isPipeVisible(p, state.filters));
}

export function totalAppreciations(state) {
  let sum = 0;
  for (const p of state.pipes) sum += state.claps[p.id] ?? p.appreciations;
  return sum;
}

export function sortedFeed(state) {
  const list = visiblePipes(state);
  if (state.tab === 'new') {
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  return list.sort((a, b) =>
    (state.claps[b.id] ?? b.appreciations) - (state.claps[a.id] ?? a.appreciations) ||
    b.createdAt.localeCompare(a.createdAt));
}

/** Picks the primary type of a draft: the type with the most pipes, ties broken by pick order. */
export function draftPrimaryType(draft) {
  let best = null;
  for (const t of draft.types) if (!best || (draft.counts[t] || 1) > (draft.counts[best] || 1)) best = t;
  return best;
}

function withFocus(state, focus, extra = {}) {
  return { ...state, focus, lightbox: null, ...extra };
}

export function reducePipeState(state, action) {
  switch (action.type) {
    case 'atlas/loaded': {
      const claps = {};
      for (const p of action.pipes) claps[p.id] = p.appreciations;
      let next = {
        ...state, loaded: true, isCloudLive: action.isCloudLive, pipes: action.pipes, claps,
        notesByPipeId: action.notesByPipeId, notesVersion: state.notesVersion + 1, pipesVersion: state.pipesVersion + 1,
      };
      if (state.pendingPipeId) {
        const pipe = pipeById(next, state.pendingPipeId);
        next = pipe
          ? withFocus(next, { kind: 'inspect', pipeId: pipe.id }, { pendingPipeId: null, filters: isPipeVisible(pipe, next.filters) ? next.filters : [...ALL_TYPE_KEYS] })
          : withFocus(next, REST_FOCUS, { pendingPipeId: null, status: say('Pipe not found.') });
      }
      // The one piece of plumbing worth mentioning: posts are only saving to this browser.
      if (action.warning) next = { ...next, status: say(action.warning, 'warn') };
      return next;
    }

    case 'pipe/select': {
      const pipe = pipeById(state, action.pipeId);
      if (!pipe || state.focus.kind === 'compose') return state;
      // Opening a pipe whose type is filtered out shows everything again, so its pin is on the map.
      const filters = isPipeVisible(pipe, state.filters) ? state.filters : [...ALL_TYPE_KEYS];
      return withFocus(state, { kind: 'inspect', pipeId: pipe.id }, { filters });
    }

    case 'focus/rest':
      if (state.focus.kind === 'rest' && !state.lightbox) return state;
      return withFocus(state, REST_FOCUS);

    case 'filter/toggle': {
      // Radio-style: clicking a type shows only that type, in one click, from anywhere.
      // Clicking the type that's already showing goes back to All.
      const alreadySolo = state.filters.length === 1 && state.filters[0] === action.key;
      const filters = alreadySolo ? [...ALL_TYPE_KEYS] : [action.key];
      let next = { ...state, filters };
      if (state.focus.kind === 'inspect') {
        const pipe = pipeById(state, state.focus.pipeId);
        if (pipe && !isPipeVisible(pipe, filters)) next = withFocus(next, REST_FOCUS);
      }
      return next;
    }

    case 'filter/all':
      return state.filters.length === ALL_TYPE_KEYS.length ? state : { ...state, filters: [...ALL_TYPE_KEYS] };

    case 'tab/set':
      return state.tab === action.tab ? state : { ...state, tab: action.tab };

    case 'compose/start':
      return withFocus(state, { kind: 'compose', draft: action.draft }, { status: null });

    case 'compose/move': {
      if (state.focus.kind !== 'compose') return state;
      return { ...state, focus: { ...state.focus, draft: { ...state.focus.draft, lat: action.lat, lng: action.lng } } };
    }

    case 'compose/edit': {
      if (state.focus.kind !== 'compose') return state;
      return { ...state, focus: { ...state.focus, draft: { ...state.focus.draft, ...action.patch } } };
    }

    case 'compose/cancel':
      if (!state.focus.kind === 'compose') return state;
      return withFocus(state, REST_FOCUS);

    case 'pipe/created': {
      const pipes = [...state.pipes, action.pipe];
      const claps = { ...state.claps, [action.pipe.id]: action.pipe.appreciations };
      const filters = isPipeVisible(action.pipe, state.filters) ? state.filters : [...ALL_TYPE_KEYS];
      return withFocus({ ...state, pipes, claps, filters, pipesVersion: state.pipesVersion + 1 },
        { kind: 'inspect', pipeId: action.pipe.id },
        { status: say('Pipe posted!', 'good') });
    }

    case 'pipe/deleted': {
      const pipes = state.pipes.filter((p) => p.id !== action.pipeId);
      const next = { ...state, pipes, pipesVersion: state.pipesVersion + 1, status: say('Pipe removed.') };
      return state.focus.kind === 'inspect' && state.focus.pipeId === action.pipeId ? withFocus(next, REST_FOCUS) : next;
    }

    case 'pipe/appreciate': {
      const current = state.claps[action.pipeId] ?? 0;
      return { ...state, claps: { ...state.claps, [action.pipeId]: current + action.delta } };
    }

    case 'note/added': {
      const list = [...(state.notesByPipeId[action.note.pipeId] || []), action.note];
      return { ...state, notesByPipeId: { ...state.notesByPipeId, [action.note.pipeId]: list }, notesVersion: state.notesVersion + 1 };
    }

    case 'lightbox/open':
      return { ...state, lightbox: action.url };
    case 'lightbox/close':
      return state.lightbox ? { ...state, lightbox: null } : state;

    case 'status/say':
      return { ...state, status: say(action.text, action.tone) };
    case 'status/clear':
      return state.status && state.status.id === action.id ? { ...state, status: null } : state;

    case 'url/restore': {
      const filters = action.filters && action.filters.length ? action.filters : [...ALL_TYPE_KEYS];
      if (state.focus.kind === 'compose') return { ...state, filters };
      const pipe = action.pipeId ? pipeById(state, action.pipeId) : null;
      const shown = pipe && !isPipeVisible(pipe, filters) ? [...ALL_TYPE_KEYS] : filters;
      return withFocus({ ...state, filters: shown }, pipe ? { kind: 'inspect', pipeId: pipe.id } : REST_FOCUS);
    }

    default:
      return state;
  }
}

/**
 * The Escape stack: one transient layer per keystroke.
 * Returns the action to dispatch (or a special { type: 'escape/...' } handled by main), or null.
 */
export function unwindOneEscapeLayer(state, { isDraggingPin }) {
  if (isDraggingPin) return { type: 'escape/cancelPinDrag' };
  if (state.lightbox) return { type: 'lightbox/close' };
  if (state.focus.kind === 'compose') return { type: 'compose/cancel' };
  if (state.focus.kind === 'inspect') return { type: 'focus/rest' };
  return { type: 'escape/focusPrimary' };
}

/** Which transitions deserve a Back-button entry (push) vs. a silent URL update (replace). */
export function historyModeFor(action) {
  switch (action.type) {
    case 'pipe/select':
    case 'pipe/created':
    case 'focus/rest':
    case 'pipe/deleted':
      return 'push';
    case 'filter/toggle':
    case 'filter/all':
    case 'tab/set':
    case 'atlas/loaded':
    case 'compose/cancel':
      return 'replace';
    default:
      return null;
  }
}

/** The part of state that belongs in a shareable URL. */
export function residentStateToUrl(state, baseHref) {
  const url = new URL(baseHref);
  url.search = '';
  if (state.focus.kind === 'inspect') url.searchParams.set('pipe', state.focus.pipeId);
  if (state.filters.length !== ALL_TYPE_KEYS.length) url.searchParams.set('types', state.filters.join(','));
  if (state.tab !== 'top') url.searchParams.set('sort', state.tab);
  return url.toString();
}

export function urlToResidentState(href) {
  const url = new URL(href);
  const types = (url.searchParams.get('types') || '').split(',').filter((k) => ALL_TYPE_KEYS.includes(k));
  return { pipeId: url.searchParams.get('pipe'), filters: types, tab: url.searchParams.get('sort') === 'new' ? 'new' : 'top' };
}
