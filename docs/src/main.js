// Wiring: one dispatch -> reduce -> render loop drives drawer, map, ticker and URL in lockstep.

import {
  PIPE_TYPES, TYPE_BY_KEY, ALL_TYPE_KEYS, LIMITS, WALK_CENTER,
  initialState, reducePipeState, pipeById, visiblePipes, sortedFeed,
  totalAppreciations, draftPrimaryType, unwindOneEscapeLayer, historyModeFor, residentStateToUrl,
  urlToResidentState, isInNyc,
} from './state.js';
import { createDrawer, drawerAfter } from './drawer.js';
import { createPipeMap } from './map.js';
import { labRequested, loadLabTheme, mountStyleLab } from './style_lab.js';
import { attachMapGestures } from './gestures.js';
import { intakePhoto, intakeModel, isModelFile, sanitizeImage, searchNycPlace, reverseGeocodeNyc, fmtCoords } from './exif_upload.js';
import { createPipeRepository } from './storage.js';
import { shapeSvg } from './shapes.js';

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => Number(x).toLocaleString('en-US');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : dateFmt.format(d); };

/** "Standpipe", "Fresh air inlet ×2", "Standpipe + Air inlet ×2 + Dryer vent": every kind and count, said once. */
const pipeTitle = (p) => {
  const multi = p.allTypes.length > 1;
  return p.allTypes.map((t) => {
    const name = t === 'other' && p.customTag ? p.customTag : multi ? TYPE_BY_KEY[t].short : TYPE_BY_KEY[t].label;
    const count = p.counts?.[t] || 1;
    return count > 1 ? `${name} ×${count}` : name;
  }).join(' + ');
};
/** Who to thank: the uploader, or Eric for the pipes from the original walk. */
const submitter = (p) => p.author || (p.source === 'walk' ? 'Eric' : 'Anonymous');
const isTyping = (node) => node && (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT' && node.type !== 'button'));

// ---------------------------------------------------------------- app state
const config = window.PIPE_CONFIG || {};
const repo = createPipeRepository(config);
const fromUrl = urlToResidentState(location.href);
let state = {
  ...initialState({ filters: fromUrl.filters.length ? fromUrl.filters : ALL_TYPE_KEYS }),
  tab: fromUrl.tab,
  pendingPipeId: fromUrl.pipeId, // opened once the atlas has loaded
};

const el = {
  drawer: $('.drawer'),
  handle: $('.drawer-handle'),
  body: $('[data-drawer-body]'),
  flaps: $('[data-flaps]'),
  ticker: $('[data-ticker]'),
  key: $('[data-map-key]'),
  toast: $('[data-toast]'),
  lightbox: $('[data-lightbox]'),
  lightboxImg: $('[data-lightbox-img]'),
  file: $('[data-file-input]'),
  stage: $('.map-stage'),
};

// ?lab in the URL opens the Style Lab (map themes, live). It keeps its own place in the URL.
const LAB = labRequested();
const pipeMap = createPipeMap($('#map'), {
  getClaps: (id) => state.claps[id] ?? 0,
  obstacleRoot: el.stage,
  theme: LAB ? loadLabTheme() : null,
});
if (LAB) mountStyleLab({ stage: el.stage, getTheme: () => pipeMap.theme, setTheme: (cfg) => pipeMap.setTheme(cfg) });

const drawer = createDrawer({
  el: el.drawer,
  handle: el.handle,
  onCoveredChange: (px) => { pipeMap.setCovered(px); el.stage.style.setProperty('--covered', `${px}px`); },
  // Resizing the sheet by hand never moves the map: the reader is choosing what to cover.
  onUserSnap: () => renderPeekHint(),
});
drawer.apply({ animate: false });

let busy = false;            // reading/compressing/posting a photo
let lastDrawerKey = '';
let lastMapKey = '';
let toastTimer = 0;
let hoveredCardId = null;     // the sidebar card lit up by hovering its pin
let navOrder = null;          // the feed order Prev/Next walks through; frozen so clapping doesn't reshuffle it

// ---------------------------------------------------------------- dispatch
function dispatch(action, { fromHistory = false } = {}) {
  const prev = state;
  state = reducePipeState(state, action);
  if (state === prev && !action.type.startsWith('escape/')) return;

  if (state.focus.kind !== 'inspect' || state.filters !== prev.filters || state.tab !== prev.tab) navOrder = null;

  const nextSnap = drawerAfter(drawer.snap, action, prev.focus.kind, state.focus.kind);
  if (nextSnap !== drawer.snap) drawer.setSnap(nextSnap);

  render(prev, action);
  choreographCamera(prev, action);

  if (!fromHistory) {
    const mode = historyModeFor(action);
    if (mode && state.loaded) {
      let url = residentStateToUrl(state, location.href);
      if (LAB) url += `${url.includes('?') ? '&' : '?'}lab`;
      if (url !== location.href) {
        if (mode === 'push') history.pushState(null, '', url); else history.replaceState(null, '', url);
      }
    }
  }
}

// ---------------------------------------------------------------- camera choreography
// The camera belongs to the reader. It moves on its own only to show something they can't see yet:
// a shared link's pipe, a pipe picked from the list that's off-screen, or where a GPS photo was taken.
// Tapping a pin on the map never moves it (they can obviously already see that pin).
function choreographCamera(prev, action) {
  const f = state.focus;
  if (action.type === 'atlas/loaded' && f.kind === 'inspect') {
    const p = pipeById(state, f.pipeId);
    if (p) pipeMap.whenReady().then(() => pipeMap.showPoint(p));
    return;
  }
  if (f.kind === 'inspect' && (prev.focus.kind !== 'inspect' || prev.focus.pipeId !== f.pipeId)) {
    // A tapped pin is already in view, so the map stays put... unless the sheet that just opened
    // landed on top of it (phones), in which case it slides up just far enough to clear the sheet.
    if (action.from === 'map') { const p = pipeById(state, f.pipeId); if (p) pipeMap.liftAboveSheet(p); return; }
    const p = pipeById(state, f.pipeId);
    if (p) pipeMap.showPoint(p);
    return;
  }
  if (action.type === 'compose/start' && f.draft.hasExif) pipeMap.flyToPoint(f.draft, 18);
}

// ---------------------------------------------------------------- rendering
function render(prev, action) {
  renderDrawer(prev);
  renderMap(prev, action);
  renderKey();
  renderTicker();
  renderClapCounts();
  renderLightbox();
  renderToast(prev);
  renderPeekHint();
  document.title = state.focus.kind === 'inspect' && pipeById(state, state.focus.pipeId)
    ? `${pipeTitle(pipeById(state, state.focus.pipeId))} · The NYC Pipe Appreciation Portal`
    : 'The NYC Pipe Appreciation Portal';
}

function drawerKey() {
  const f = state.focus;
  const parts = [state.loaded, f.kind, state.tab, state.filters.join(','), state.pipesVersion];
  if (f.kind === 'inspect') parts.push(f.pipeId, (state.notesByPipeId[f.pipeId] || []).length);
  if (f.kind === 'compose') parts.push(f.draft.photo?.url, f.draft.model?.url, f.draft.hasExif);
  return parts.join('|');
}

function renderDrawer(prev) {
  const key = drawerKey();
  if (key !== lastDrawerKey) {
    const sameFocus = prev && prev.focus.kind === state.focus.kind && (prev.focus.pipeId === state.focus.pipeId);
    const scroll = sameFocus ? el.body.scrollTop : 0;
    lastDrawerKey = key;
    const f = state.focus;
    let html;
    if (!state.loaded) html = '<div class="drawer-loading">Loading pipes…</div>';
    else if (f.kind === 'inspect') html = inspectTemplate(pipeById(state, f.pipeId));
    else if (f.kind === 'compose') html = composeTemplate(f.draft);
    else html = restTemplate();
    el.body.innerHTML = html;
    el.body.scrollTop = scroll;
    // The hovered card may be gone now (no pointerout fires for removed nodes), so drop its halo.
    hoveredCardId = null;
    pipeMap.setHover(null);
    el.drawer.dataset.focus = f.kind;
    afterDrawerRender(prev);
  }
  // Live patches that must not rebuild the drawer (inputs keep focus, buttons keep their press).
  if (state.focus.kind === 'compose') {
    const addr = $('[data-where-addr]', el.body);
    if (addr) addr.textContent = whereText(state.focus.draft);
  }
  $$('[data-busy-disable]', el.body).forEach((b) => { b.disabled = busy; });
}

/** Rebuilding the drawer drops keyboard focus; put it somewhere sensible instead of <body>. */
function afterDrawerRender(prev) {
  const f = state.focus;
  if (f.kind === 'compose') syncComposeForm();
  if ($('model-viewer', el.body)) ensureModelViewer().catch(() => {});
  if (!prev || prev.focus.kind === f.kind && prev.focus.pipeId === f.pipeId) return;
  // Coming back to the grid, scroll to the pipe you were just looking at.
  const backTo = f.kind === 'rest' && prev.focus.kind === 'inspect' ? $(`.pipe-card-photo[data-id="${CSS.escape(prev.focus.pipeId)}"]`, el.body) : null;
  if (backTo && !drawer.isMobile) backTo.scrollIntoView({ block: 'nearest' });
  // A pipe-less photo needs an address, so the search box takes the cursor (on desktop).
  const hasMedia = f.kind === 'compose' && (f.draft.photo || f.draft.model);
  if (hasMedia && !f.draft.hasExif && !drawer.isMobile) { $('#place-q', el.body)?.focus(); return; }
  // Everything else only moves focus for keyboard users: a mouse or finger doesn't need it, and it
  // would paint a focus ring on a button nobody pressed.
  if (lastInput !== 'keyboard') return;
  const active = document.activeElement;
  if (active && active !== document.body && !el.drawer.contains(active)) return; // focus lives elsewhere (map, lightbox)
  const opts = { preventScroll: drawer.isMobile };
  let target = null;
  if (f.kind === 'inspect') target = $('[data-act="appreciate"]', el.body);
  else if (f.kind === 'rest') target = backTo || $('[data-act="post-start"]', el.body);
  else if (f.kind === 'compose') target = hasMedia ? $('.type-toggle', el.body) : $('.dropzone', el.body);
  target?.focus(opts);
}

// Which kind of input the reader is using right now decides whether focus should follow along.
let lastInput = 'pointer';
document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
document.addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) lastInput = 'keyboard'; }, true);

function restTemplate() {
  const feed = sortedFeed(state);
  const items = feed.map((p) => pipeCard(p)).join('') || '<li class="feed-empty">No pipes of this kind yet. Be the first!</li>';
  return `
  <section class="rest">
    <h1 class="sr-only">The NYC Pipe Appreciation Portal</h1>
    <button type="button" class="btn btn-hero post-pipe" data-act="post-start" data-busy-disable>+ Post a pipe</button>
    <p class="peek-hint">Swipe up for pipes</p>

    <div class="tabs" role="tablist" aria-label="Sort pipes">
      <button type="button" role="tab" class="tab" data-act="tab" data-tab="top" aria-selected="${state.tab === 'top'}">Most appreciated</button>
      <button type="button" role="tab" class="tab" data-act="tab" data-tab="new" aria-selected="${state.tab === 'new'}">Newest</button>
    </div>
    <ol class="pipe-grid">${items}</ol>
  </section>`;
}

function pipeCard(p) {
  const shapes = p.allTypes.map((t) => shapeSvg(t, 13)).join('');
  return `
  <li class="pipe-card" data-pipe-card="${esc(p.id)}">
    <button type="button" class="pipe-card-photo" data-act="select" data-id="${esc(p.id)}" aria-label="Open ${esc(pipeTitle(p))}">
      <img src="${esc(p.photoUrl)}" alt="" loading="lazy" decoding="async">
      ${p.modelUrl ? '<span class="badge-3d" title="Has a 3D scan you can spin">3D</span>' : ''}
    </button>
    <div class="pipe-card-caption">
      <button type="button" class="pipe-card-name" data-act="select" data-id="${esc(p.id)}"><span class="shapes">${shapes}</span><span class="pipe-card-name-text">${esc(pipeTitle(p))}</span></button>
      <button type="button" class="btn btn-sm pipe-card-claps" data-act="appreciate" data-id="${esc(p.id)}" aria-label="Appreciate this pipe">👏 <span data-claps-for="${esc(p.id)}">${n(state.claps[p.id] ?? 0)}</span></button>
    </div>
  </li>`;
}

function inspectTemplate(p) {
  if (!p) return restTemplate();
  const comments = (state.notesByPipeId[p.id] || []).filter((x) => x.body);
  const list = comments.length
    ? `<ol class="notes">${comments.slice().reverse().map((x) => `
        <li class="note-item"><p class="note-body">${esc(x.body)}</p><p class="note-by">${esc(x.author || 'Anonymous')}, ${esc(shortDate(x.createdAt))}</p></li>`).join('')}</ol>`
    : '';
  const shapes = p.allTypes.map((t) => shapeSvg(t, 20)).join('');
  return `
  <article class="inspect">
    <div class="peek-row inspect-top">
      <button type="button" class="btn btn-ghost" data-act="rest">← All pipes</button>
      <span class="prev-next">
        <button type="button" class="btn btn-ghost" data-act="nav" data-step="-1" aria-label="Previous pipe" title="Previous pipe (←)">‹ Prev</button>
        <button type="button" class="btn btn-ghost" data-act="nav" data-step="1" aria-label="Next pipe" title="Next pipe (→)">Next ›</button>
      </span>
    </div>

    <div class="pipe-head">
      <h2 class="display pipe-name"><span class="shapes">${shapes}</span>${esc(pipeTitle(p))}</h2>
      <p class="pipe-coords">Submitted by ${esc(submitter(p))} · ${esc(fmtCoords(p))}</p>
    </div>
    <div class="media">
    ${p.modelUrl && p.hasPhoto ? `
    <div class="media-toggle" role="tablist" aria-label="Show the 3D scan or the photo">
      <button type="button" role="tab" class="media-tab" data-act="media" data-view="3d" aria-selected="true">3D scan</button>
      <button type="button" role="tab" class="media-tab" data-act="media" data-view="photo" aria-selected="false">Photo</button>
    </div>` : ''}
    ${p.modelUrl ? `
    <div class="model-frame" data-media-view="3d">
      <model-viewer src="${esc(p.modelUrl)}" poster="${esc(p.photoUrl.replace(/#poster$/, ''))}" alt="3D scan: ${esc(p.note || pipeTitle(p))}" camera-controls auto-rotate ar touch-action="pan-y" shadow-intensity="0.6" interaction-prompt="none"></model-viewer>
    </div>` : ''}
    ${p.hasPhoto ? `
    <figure class="photo-frame" data-media-view="photo" ${p.modelUrl ? 'hidden' : ''}>
      <button type="button" class="photo-button" data-act="lightbox" aria-label="Open full-size photo">
        <img src="${esc(p.photoUrl)}" alt="${esc(p.note || pipeTitle(p))}" decoding="async">
      </button>
    </figure>` : ''}
    </div>

    <div class="appreciate-wrap">
      <button type="button" class="btn btn-hero appreciate" data-act="appreciate" data-id="${esc(p.id)}">
        <span class="clap" aria-hidden="true">👏</span>
        <span class="appreciate-label">Appreciate this pipe</span>
        <span class="appreciate-count" data-claps-for="${esc(p.id)}">${n(state.claps[p.id] ?? 0)}</span>
      </button>
      <p class="streak" data-streak aria-live="polite"></p>
    </div>

    ${p.note ? `<div class="pipe-about"><p class="pipe-note">${esc(p.note)}</p></div>` : ''}

    <section class="notes-box" aria-labelledby="notes-title">
      <h3 class="display" id="notes-title">Comments</h3>
      ${list}
      <form class="note-form" data-form="note" data-id="${esc(p.id)}">
        <label class="sr-only" for="note-body">Your comment</label>
        <textarea id="note-body" name="body" rows="2" maxlength="${LIMITS.fieldNote}" placeholder="Leave a comment about this pipe…" required></textarea>
        <div class="note-row">
          <label class="sr-only" for="note-author">Your name</label>
          <input id="note-author" name="author" maxlength="${LIMITS.author}" placeholder="Your name (optional)" value="${esc(repo.rememberedAuthor())}" autocomplete="nickname">
          <button type="submit" class="btn btn-primary">Post</button>
        </div>
      </form>
    </section>
    ${p.canDelete ? `<p class="delete-row"><button type="button" class="btn btn-sm btn-danger" data-act="delete-own" data-id="${esc(p.id)}">Delete my pipe</button></p>` : ''}
  </article>`;
}

/** Adding a pipe is one screen: the pin is live on the map the whole time you fill this in. */
function composeTemplate(d) {
  const rows = PIPE_TYPES.map((t) => `
    <div class="type-row" data-type-row="${t.key}">
      <button type="button" class="btn type-toggle" data-act="draft-type" data-key="${t.key}" aria-pressed="false" style="--c:${t.color}">
        ${shapeSvg(t.key, 18)}<span>${esc(t.label)}</span>
      </button>
      <div class="stepper">
        <button type="button" class="btn step" data-act="draft-count" data-key="${t.key}" data-delta="-1" aria-label="One fewer ${esc(t.label)}">−</button>
        <output data-count-for="${t.key}">1</output>
        <button type="button" class="btn step" data-act="draft-count" data-key="${t.key}" data-delta="1" aria-label="One more ${esc(t.label)}">+</button>
      </div>
      ${t.key === 'other' ? `<label class="other-name"><span>What kind of pipe is it?</span>
        <input name="customTag" maxlength="${LIMITS.customTag}" placeholder="e.g. Dryer vent, coal chute, gooseneck" autocomplete="off">
        <span class="field-error" data-field-error="other" role="alert" hidden></span></label>` : ''}
    </div>`).join('');
  const hasMedia = Boolean(d.photo || d.model);
  const top = `
    <div class="compose-top">
      <button type="button" class="btn btn-ghost" data-act="cancel-compose">← Back</button>
      ${hasMedia ? '<button type="button" class="linkish" data-act="pick-file">Change file</button>' : ''}
    </div>
    <h2 class="display compose-title">Post a pipe</h2>`;
  // Stage 1: just a place for the file. Most phone photos know where they were taken, so asking for
  // an address first would send people the long way round.
  if (!hasMedia) {
    return `
  <form class="compose" data-form="compose" novalidate>
    ${top}
    <button type="button" class="dropzone" data-act="pick-file" data-dropzone data-busy-disable>
      <span class="dropzone-title">Drop a photo or 3D scan</span>
      <span class="dropzone-sub">or click to choose a file</span>
    </button>
    <p class="field-error" data-field-error="dropzone" role="alert" hidden></p>
  </form>`;
  }
  // Stage 2: the file is in, the pin is on the map, everything else appears. One file per post:
  // "Change file" swaps it for another photo or scan.
  return `
  <form class="compose" data-form="compose" novalidate>
    ${top}
    ${d.model
      ? `<div class="model-frame compose-model"><model-viewer src="${esc(d.model.url)}" ${d.photo ? `poster="${esc(d.photo.url)}"` : ''} alt="Your 3D scan" loading="eager" camera-controls auto-rotate touch-action="pan-y" interaction-prompt="none" data-compose-model></model-viewer></div>`
      : `<button type="button" class="compose-photo" data-act="lightbox" data-url="${esc(d.photo.url)}" aria-label="See your photo full size"><img src="${esc(d.photo.url)}" alt="Your pipe photo"></button>`}

    <div class="where">
      <p class="where-addr" data-where-addr>${esc(whereText(d))}</p>
      <p class="where-line">Adjust the pipe’s location by dragging the pin on the map, or enter an address near where you saw it.</p>
      <div class="place-search" data-search>
        <label class="sr-only" for="place-q">Search an NYC address or cross streets</label>
        <input id="place-q" type="search" placeholder="219 E 7th St, or 7th and 1st Ave" autocomplete="off" enterkeyhint="search">
        <button type="button" class="btn" data-act="search">Search</button>
      </div>
      <ul class="search-results" data-results></ul>
    </div>

    <fieldset class="type-picker" data-error-section="types">
      <legend class="display">What kind of pipe is this?</legend>
      <p class="field-error" data-field-error="types" role="alert" hidden></p>
      ${rows}
    </fieldset>
    <label class="field"><span>Note <em>(optional)</em></span>
      <textarea name="note" rows="3" maxlength="${LIMITS.note}" placeholder="What's the story with this pipe?"></textarea></label>
    <label class="field"><span>Your name <em>(optional)</em></span>
      <input name="author" maxlength="${LIMITS.author}" placeholder="Name or handle" autocomplete="nickname"></label>
    <p class="form-error" data-form-error role="alert"></p>
    <button type="submit" class="btn btn-primary btn-wide" data-act="post" data-busy-disable>Post pipe</button>
  </form>`;
}

/** "Near 190 E 7th St · 40.72478° N, 73.98089° W": the address is dropped once the pin moves away from it. */
function whereText(d) {
  const near = d.address && d.addressAt && Math.hypot(d.lat - d.addressAt.lat, (d.lng - d.addressAt.lng) * 0.76) < 0.00025 ? `Near ${d.address} · ` : '';
  return near + fmtCoords(d);
}

function syncComposeForm() {
  const d = state.focus.draft;
  const form = $('[data-form="compose"]', el.body);
  if (!form) return;
  if (!form.elements.note) return; // stage 1: nothing to sync yet
  for (const t of ALL_TYPE_KEYS) {
    const on = d.types.includes(t);
    const row = $(`[data-type-row="${t}"]`, form);
    row.classList.toggle('is-on', on);
    $('.type-toggle', row).setAttribute('aria-pressed', String(on));
    $(`[data-count-for="${t}"]`, row).textContent = String(d.counts[t] || 1);
  }
  for (const name of ['customTag', 'author', 'note']) if (form.elements[name].value !== d[name]) form.elements[name].value = d[name];
}

function renderMap(prev, action) {
  const key = `${state.pipesVersion}|${state.filters.join(',')}`;
  if (key !== lastMapKey) {
    lastMapKey = key;
    const focal = state.focus.kind === 'inspect' ? pipeById(state, state.focus.pipeId) : pipeMap.map.getCenter();
    pipeMap.setPipes(visiblePipes(state), action.type.startsWith('filter') ? focal : null);
  }
  pipeMap.setSelected(state.focus.kind === 'inspect' ? state.focus.pipeId : null);
  const f = state.focus;
  pipeMap.setCandidate(f.kind === 'compose' && (f.draft.photo || f.draft.model) ? { id: f.draft.photo?.url || f.draft.model?.url, lng: f.draft.lng, lat: f.draft.lat, hasExif: f.draft.hasExif, hot: true } : null);
  el.stage.classList.toggle('is-placing', f.kind === 'compose');
  if (action.type === 'pipe/appreciate') pipeMap.redraw();
}

function renderKey() {
  if (!el.key.childElementCount) {
    el.key.innerHTML = '<button type="button" class="btn btn-sm key-chip key-all" data-act="filter-all">All</button>'
      + PIPE_TYPES.map((t) => `<button type="button" class="btn btn-sm key-chip" data-act="filter" data-key="${t.key}" title="${esc(t.label)}">${shapeSvg(t.key, 14)}<span>${esc(t.short)}</span></button>`).join('');
  }
  const all = state.filters.length === ALL_TYPE_KEYS.length;
  $('.key-all', el.key).setAttribute('aria-pressed', String(all));
  el.key.classList.toggle('is-narrowed', !all);
  // With everything showing, no single type is "selected"; chips light up only once you've narrowed down.
  for (const b of $$('.key-chip[data-key]', el.key)) b.setAttribute('aria-pressed', String(!all && state.filters.includes(b.dataset.key)));
  el.key.hidden = state.focus.kind === 'compose';
}

// ---- McDonald's-style split-flap ticker
let tickerChars = [];
const MIN_TICKER_CELLS = 0; // only the digits the count needs; no empty leading boxes
function renderTicker() {
  const total = state.loaded ? totalAppreciations(state) : 0;
  const text = n(total).padStart(MIN_TICKER_CELLS, ' ');
  el.ticker.setAttribute('aria-label', `Over ${n(total)} pipes appreciated`);
  if (text.length !== tickerChars.length) {
    el.flaps.innerHTML = [...text].map((ch) => `<span class="flap${ch === ',' ? ' flap-comma' : ''}${ch === ' ' ? ' flap-blank' : ''}"><span>${ch === ' ' ? '&nbsp;' : ch}</span></span>`).join('');
    tickerChars = [...text];
    return;
  }
  const cells = el.flaps.children;
  [...text].forEach((ch, i) => {
    if (ch === tickerChars[i]) return;
    const cell = cells[i];
    const face = cell.firstElementChild;
    face.textContent = ch === ' ' ? ' ' : ch;
    cell.classList.toggle('flap-blank', ch === ' ');
    cell.classList.toggle('flap-comma', ch === ',');
    if (!reducedMotion() && face.animate) {
      face.animate(
        [{ transform: 'rotateX(-90deg)', filter: 'brightness(1.6)' }, { transform: 'rotateX(8deg)', offset: 0.75 }, { transform: 'rotateX(0deg)', filter: 'brightness(1)' }],
        { duration: 170, easing: 'cubic-bezier(.3,.7,.4,1)' },
      );
    }
  });
  tickerChars = [...text];
}

function renderClapCounts() {
  for (const node of $$('[data-claps-for]')) {
    const v = n(state.claps[node.dataset.clapsFor] ?? 0);
    if (node.textContent !== v) node.textContent = v;
  }
}

function renderLightbox() {
  const open = Boolean(state.lightbox);
  if (open && el.lightboxImg.getAttribute('src') !== state.lightbox) el.lightboxImg.src = state.lightbox;
  if (el.lightbox.hidden === open) {
    el.lightbox.hidden = !open;
    if (open) $('.lightbox-close', el.lightbox).focus();
    else $('[data-act="lightbox"]', el.body)?.focus({ preventScroll: true }); // back to the photo that opened it
  }
}

function renderToast(prev) {
  const s = state.status;
  if (!s) { el.toast.hidden = true; return; }
  if (prev && prev.status && prev.status.id === s.id) return;
  el.toast.textContent = s.text;
  el.toast.dataset.tone = s.tone;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; dispatch({ type: 'status/clear', id: s.id }); }, s.tone === 'warn' ? 6000 : 3800);
}

function renderPeekHint() {
  el.drawer.classList.toggle('is-peeking', drawer.isMobile && drawer.snap === 'peek');
}

// ---------------------------------------------------------------- photo intake
/** Takes a dropped or chosen file: a photo or a .glb scan. A post holds one file; a new one replaces it and keeps the rest of the form. */
async function startCompose(fileOrPromise) {
  if (busy) return;
  busy = true;
  renderDrawer();
  try {
    const file = await fileOrPromise;
    const old = state.focus.kind === 'compose' ? state.focus.draft : null;
    // Changing the file keeps everything already filled in, and keeps a pin that's already on the map
    // unless the new photo knows where it was taken. Before any file there's no pin yet, so one lands
    // at the current map centre.
    const hadPin = Boolean(old && (old.photo || old.model));
    const release = () => { if (old?.photo) URL.revokeObjectURL(old.photo.url); if (old?.model) URL.revokeObjectURL(old.model.url); };
    if (isModelFile(file)) {
      const model = intakeModel(file);
      ensureModelViewer();
      const where = hadPin ? { lat: old.lat, lng: old.lng, hasExif: old.hasExif, exifLat: old.exifLat, exifLng: old.exifLng, address: old.address, addressAt: old.addressAt } : { ...mapCentreInNyc(), hasExif: false, exifLat: null, exifLng: null, address: null, addressAt: null };
      release();
      dispatch({ type: 'compose/start', draft: newDraft({ ...(old || {}), photo: null, model, outsideNyc: false, ...where }) });
      el.body.scrollTop = 0; // show the file that just landed
      return;
    }
    dispatch({ type: 'status/say', text: 'Reading your photo…' });
    const intake = await intakePhoto(file);
    const where = intake.gps || (hadPin ? { lat: old.lat, lng: old.lng } : mapCentreInNyc());
    release();
    dispatch({
      type: 'compose/start',
      draft: newDraft({
        ...(old || {}), photo: intake.photo, model: null, lat: where.lat, lng: where.lng,
        hasExif: intake.hasExif, exifLat: intake.gps?.lat ?? null, exifLng: intake.gps?.lng ?? null, outsideNyc: intake.outsideNyc,
        address: null, addressAt: null,
      }),
    });
    el.body.scrollTop = 0; // show the file that just landed
    if (intake.gps) fillAddress(intake.gps);
  } catch (err) {
    dispatch({ type: 'status/say', text: err.message || 'Couldn’t read that image file.', tone: 'warn' });
  } finally {
    busy = false;
    renderDrawer();
  }
}

/** Looks up the street address nearest where the photo was taken and shows it in the location box (best effort). */
async function fillAddress(at) {
  const address = await reverseGeocodeNyc(at.lat, at.lng);
  const d = state.focus.kind === 'compose' ? state.focus.draft : null;
  if (!address || !d || d.exifLat !== at.lat || d.exifLng !== at.lng) return; // the photo changed meanwhile
  dispatch({ type: 'compose/edit', patch: { address, addressAt: { lat: at.lat, lng: at.lng } } });
}

function mapCentreInNyc() {
  const c = pipeMap.map.getCenter();
  return isInNyc(c.lat, c.lng) ? { lat: c.lat, lng: c.lng } : WALK_CENTER;
}

function newDraft(fields) {
  return {
    photo: null, model: null, lat: WALK_CENTER.lat, lng: WALK_CENTER.lng, hasExif: false, exifLat: null, exifLng: null, outsideNyc: false,
    address: null, addressAt: null,
    types: [], counts: {}, customTag: '', author: repo.rememberedAuthor(), note: '',
    ...fields,
  };
}

/** A scan posted without a photo still needs a picture for the grid and map: snapshot the 3D view. */
async function posterFromModel() {
  const mv = $('[data-compose-model]', el.body);
  if (!mv) throw new Error('Add a photo or 3D scan first.');
  await customElements.whenDefined('model-viewer');
  if (!mv.loaded) await new Promise((resolve, reject) => { mv.addEventListener('load', resolve, { once: true }); mv.addEventListener('error', () => reject(new Error('Couldn’t open that 3D scan.')), { once: true }); });
  const blob = await mv.toBlob({ mimeType: 'image/jpeg', qualityArgument: 0.85, idealAspect: false });
  return sanitizeImage(blob);
}

// A problem is shown where it is: the section gets a marching red outline and its own message, and it
// scrolls to the middle of the panel. (Focusing it with preventScroll keeps the browser from jumping
// somewhere else and hiding the message.)
const ERROR_SECTIONS = {
  dropzone: { box: '.dropzone', focus: '.dropzone' },
  types: { box: '.type-picker', focus: '.type-toggle' },
  other: { box: '.other-name', focus: 'input[name="customTag"]' },
};
function flagError(section, message) {
  const { box, focus } = ERROR_SECTIONS[section];
  const node = $(box, el.body);
  const slot = $(`[data-field-error="${section}"]`, el.body);
  const bottom = $('[data-form-error]', el.body);
  node?.classList.add('is-errored');
  if (slot) { slot.textContent = message; slot.hidden = false; }
  if (bottom) bottom.textContent = message;
  node?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  $(focus, el.body)?.focus({ preventScroll: true });
}
function clearErrors(section) {
  const names = section ? [section] : Object.keys(ERROR_SECTIONS);
  for (const name of names) {
    $(ERROR_SECTIONS[name].box, el.body)?.classList.remove('is-errored');
    const slot = $(`[data-field-error="${name}"]`, el.body);
    if (slot) { slot.textContent = ''; slot.hidden = true; }
  }
  const bottom = $('[data-form-error]', el.body);
  if (bottom && !$('.is-errored', el.body)) bottom.textContent = '';
}

async function postDraft(form) {
  const d = state.focus.draft;
  const errorEl = $('[data-form-error]', form);
  clearErrors();
  if (!d.photo && !d.model) return flagError('dropzone', 'Add a photo or 3D scan first.');
  if (!d.types.length) return flagError('types', 'Pick a pipe type.');
  const otherName = d.customTag.trim();
  if (d.types.includes('other') && !otherName) return flagError('other', 'Name this pipe type.');
  busy = true; renderDrawer();
  try {
    const photo = d.photo || await posterFromModel();
    const pipe = await repo.createPipe({ ...d, photo, hasPhoto: Boolean(d.photo), customTag: d.types.includes('other') ? otherName : '', primaryType: draftPrimaryType(d) });
    if (d.photo) URL.revokeObjectURL(d.photo.url);
    dispatch({ type: 'pipe/created', pipe });
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message || 'Couldn’t post right now. Try again.';
  } finally {
    busy = false; renderDrawer();
  }
}

// ---------------------------------------------------------------- 3D scans
// <model-viewer> is ~1MB of script, so it loads the first time a 3D scan is on screen, not before.
const MODEL_VIEWER_URL = 'https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';
let modelViewerPromise = null;
function ensureModelViewer() {
  modelViewerPromise ||= import(MODEL_VIEWER_URL).catch((err) => {
    modelViewerPromise = null;
    dispatch({ type: 'status/say', text: 'Couldn’t load the 3D viewer.', tone: 'warn' });
    throw err;
  });
  return modelViewerPromise;
}

// ---------------------------------------------------------------- appreciation (wild mode)
// One streak at a time: it belongs to one pipe, and ends (un-wilding every button) when you pause
// or start clapping a different pipe. No button can be left stuck in wild mode.
const streak = { id: null, log: [], timer: 0 };
function endStreak() {
  clearTimeout(streak.timer);
  streak.id = null;
  streak.log.length = 0;
  $$('[data-act="appreciate"].is-wild').forEach((b) => b.classList.remove('is-wild'));
  const line = $('[data-streak]', el.body);
  if (line) line.textContent = '';
}
function appreciate(button, clientX, clientY) {
  const id = button.dataset.id;
  dispatch({ type: 'pipe/appreciate', pipeId: id, delta: 1 });
  repo.appreciatePipe(id, 1);

  if (streak.id !== id) endStreak();
  streak.id = id;
  const now = performance.now();
  streak.log.push(now);
  while (streak.log.length && now - streak.log[0] > 2000) streak.log.shift();
  const wild = streak.log.length >= 8;
  button.classList.toggle('is-wild', wild);
  const line = $('[data-streak]', el.body);
  if (line) line.textContent = wild ? `WILD MODE 🔥 ${streak.log.length} claps in 2 seconds` : '';
  clearTimeout(streak.timer);
  streak.timer = setTimeout(endStreak, 1400);

  if (reducedMotion()) return;
  button.classList.remove('is-bumped');
  requestAnimationFrame(() => button.classList.add('is-bumped'));
  const wrap = button.parentElement;
  if (wrap.querySelectorAll('.plus-one').length > 24) return;
  const r = wrap.getBoundingClientRect();
  const p = document.createElement('span');
  p.className = 'plus-one';
  p.textContent = wild ? ['+1!', '🔥', '👏', '+1!!'][streak.log.length % 4] : '+1!';
  const x = (clientX ?? r.left + r.width / 2) - r.left;
  const y = (clientY ?? r.top + 24) - r.top;
  p.style.left = `${x}px`;
  p.style.top = `${y}px`;
  p.style.setProperty('--dx', `${(Math.random() - 0.5) * 70}px`);
  p.style.setProperty('--rot', `${(Math.random() - 0.5) * 40}deg`);
  p.addEventListener('animationend', () => p.remove());
  wrap.appendChild(p);
}

// ---------------------------------------------------------------- prev / next
/** Steps through the feed (current sort and filters) from the open pipe, wrapping at the ends. */
function stepPipe(step) {
  if (state.focus.kind !== 'inspect') return;
  const id = state.focus.pipeId;
  if (!navOrder || !navOrder.includes(id)) navOrder = sortedFeed(state).map((p) => p.id);
  if (navOrder.length < 2) return;
  const i = navOrder.indexOf(id);
  const next = navOrder[(i + step + navOrder.length) % navOrder.length];
  dispatch({ type: 'pipe/select', pipeId: next });
  if (lastInput === 'keyboard') $(`[data-act="nav"][data-step="${step}"]`, el.body)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- events
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-act="appreciate"]');
  if (!b || e.button > 0) return;
  e.preventDefault();
  appreciate(b, e.clientX, e.clientY);
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const act = t.dataset.act;
  switch (act) {
    case 'appreciate':
      if (e.detail === 0) appreciate(t); // keyboard (Enter/Space); pointer presses are handled on pointerdown
      break;
    case 'select': dispatch({ type: 'pipe/select', pipeId: t.dataset.id }); break;
    case 'rest': dispatch({ type: 'focus/rest' }); break;
    case 'filter': dispatch({ type: 'filter/toggle', key: t.dataset.key }); break;
    case 'filter-all': dispatch({ type: 'filter/all' }); break;
    case 'tab': dispatch({ type: 'tab/set', tab: t.dataset.tab }); break;
    case 'post-start': {
      // Open the form first; the file picker waits until someone asks for it.
      const at = mapCentreInNyc();
      dispatch({ type: 'compose/start', draft: newDraft({ lat: at.lat, lng: at.lng }) });
      break;
    }
    case 'pick-file': el.file.value = ''; el.file.click(); break;
    case 'media': {
      const view = t.dataset.view;
      $$('[data-act="media"]', el.body).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
      $$('[data-media-view]', el.body).forEach((n) => { n.hidden = n.dataset.mediaView !== view; });
      break;
    }
    case 'nav': stepPipe(Number(t.dataset.step)); break;
    case 'cancel-compose': dispatch({ type: 'compose/cancel' }); break;
    case 'draft-type': {
      const d = state.focus.draft;
      const k = t.dataset.key;
      const types = d.types.includes(k) ? d.types.filter((x) => x !== k) : [...d.types, k];
      dispatch({ type: 'compose/edit', patch: { types, counts: { ...d.counts, [k]: d.counts[k] || 1 } } });
      syncComposeForm();
      clearErrors('types');
      if (k !== 'other' || !types.includes('other')) clearErrors('other');
      if (k === 'other' && types.includes('other')) $('input[name="customTag"]', el.body)?.focus();
      break;
    }
    case 'draft-count': {
      const d = state.focus.draft;
      const k = t.dataset.key;
      const raw = (d.counts[k] || 1) + Number(t.dataset.delta);
      if (raw <= 0) {
        // "−" at one means "none of these": uncheck the type.
        const counts = { ...d.counts };
        delete counts[k];
        dispatch({ type: 'compose/edit', patch: { types: d.types.filter((x) => x !== k), counts } });
      } else {
        dispatch({ type: 'compose/edit', patch: { counts: { ...d.counts, [k]: Math.min(LIMITS.maxCountPerType, raw) } } });
      }
      syncComposeForm();
      break;
    }
    case 'lightbox': {
      const p = state.focus.kind === 'inspect' ? pipeById(state, state.focus.pipeId) : null;
      const url = t.dataset.url || p?.fullPhotoUrl;
      if (url) dispatch({ type: 'lightbox/open', url });
      break;
    }
    case 'lightbox-close': dispatch({ type: 'lightbox/close' }); break;
    case 'fit-all': pipeMap.fitPipes(visiblePipes(state)); break;
    case 'pick-result': {
      const lat = Number(t.dataset.lat); const lng = Number(t.dataset.lng);
      dispatch({ type: 'compose/move', lat, lng });
      dispatch({ type: 'compose/edit', patch: { address: t.dataset.label, addressAt: { lat, lng } } });
      $('[data-results]', el.body).innerHTML = '';
      document.activeElement?.blur(); // put the phone keyboard away so the pin is visible
      if (drawer.isMobile) drawer.setSnap('half');
      pipeMap.flyToPoint({ lat, lng }, 18);
      pipeMap.pulseCandidate();
      break;
    }
    case 'search': runSearch(); break;
    case 'delete-own': {
      if (!t.classList.contains('is-armed')) {
        t.classList.add('is-armed'); t.textContent = 'Confirm delete';
        setTimeout(() => { t.classList.remove('is-armed'); t.textContent = 'Delete my pipe'; }, 3500);
        break;
      }
      try {
        const ok = await repo.deleteOwnPipe(t.dataset.id);
        if (ok) dispatch({ type: 'pipe/deleted', pipeId: t.dataset.id });
        else dispatch({ type: 'status/say', text: 'Could not delete that pipe.', tone: 'warn' });
      } catch (err) { dispatch({ type: 'status/say', text: err.message, tone: 'warn' }); }
      break;
    }
    default: break;
  }
});

el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox || e.target === el.lightboxImg) dispatch({ type: 'lightbox/close' }); });

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!form.dataset.form) return;
  e.preventDefault();
  if (form.dataset.form === 'compose') { postDraft(form); return; }
  if (form.dataset.form === 'note') {
    const data = new FormData(form);
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      const note = await repo.addFieldNote(form.dataset.id, { author: data.get('author'), body: data.get('body') });
      dispatch({ type: 'note/added', note });
      $('#note-body', el.body)?.focus({ preventScroll: true });
    } catch (err) {
      dispatch({ type: 'status/say', text: err.message, tone: 'warn' });
      btn.disabled = false;
    }
    return;
  }
});

async function runSearch() {
  const list = $('[data-results]', el.body);
  const input = $('#place-q', el.body);
  if (!list || !input) return;
  list.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const results = await searchNycPlace(input.value);
    list.innerHTML = results.length
      ? results.map((r) => `<li><button type="button" class="result" data-act="pick-result" data-lat="${r.lat}" data-lng="${r.lng}" data-label="${esc(r.label)}">${esc(r.label)}</button></li>`).join('')
      : '<li class="muted">Couldn’t find that spot in NYC.</li>';
  } catch (err) {
    list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
}

// Enter in the address box searches instead of posting the whole form.
el.body.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'place-q') { e.preventDefault(); runSearch(); }
});

el.body.addEventListener('input', (e) => {
  const form = e.target.closest('[data-form="compose"]');
  if (!form || state.focus.kind !== 'compose') return;
  const name = e.target.name;
  if (!['customTag', 'author', 'note'].includes(name)) return;
  dispatch({ type: 'compose/edit', patch: { [name]: e.target.value } });
  if (name === 'customTag') clearErrors('other');
});

el.file.addEventListener('change', () => { if (el.file.files[0]) startCompose(el.file.files[0]); });

// Whole-window drag & drop. Dragging a file in opens the post form, so the one place it will land
// (the dropzone, or the current photo/scan it would replace) lights up. No full-screen overlay.
// If the drag leaves the window without dropping, a form opened only for it closes again.
let dragDepth = 0;
let composedByDrag = false;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const draftIsEmpty = () => state.focus.kind === 'compose' && !state.focus.draft.photo && !state.focus.draft.model;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add('is-dragover');
  if (state.focus.kind !== 'compose' && !busy) {
    composedByDrag = true;
    const at = mapCentreInNyc();
    dispatch({ type: 'compose/start', draft: newDraft({ lat: at.lat, lng: at.lng }) });
    if (drawer.isMobile) drawer.setSnap('half');
  }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth) return;
  document.body.classList.remove('is-dragover');
  if (composedByDrag && draftIsEmpty()) dispatch({ type: 'compose/cancel' });
  composedByDrag = false;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('is-dragover');
  composedByDrag = false;
  const file = e.dataTransfer.files[0];
  if (file) startCompose(file); // anywhere: starts a post, or swaps the photo/scan of the one in progress
});

// Escape unwinds exactly one layer per press.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.focus.kind === 'inspect' && !isTyping(document.activeElement) && !state.lightbox && !e.altKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    stepPipe(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (e.key !== 'Escape') return;
  // First Escape inside a text box just leaves the box; it never throws away a half-written pipe.
  if (isTyping(document.activeElement) && state.focus.kind === 'compose') { document.activeElement.blur(); return; }
  const action = unwindOneEscapeLayer(state, { isDraggingPin: gestures.isDraggingPin() });
  if (action.type === 'escape/cancelPinDrag') { gestures.cancelPinDrag(); return; }
  if (action.type === 'escape/focusPrimary') {
    drawer.setSnap('peek');
    $('[data-act="post-start"]', el.body)?.focus();
    return;
  }
  e.preventDefault();
  dispatch(action);
});

window.addEventListener('popstate', () => {
  const r = urlToResidentState(location.href);
  dispatch({ type: 'url/restore', pipeId: r.pipeId, filters: r.filters }, { fromHistory: true });
  if (r.tab !== state.tab) dispatch({ type: 'tab/set', tab: r.tab }, { fromHistory: true });
});

// ---------------------------------------------------------------- sidebar <-> map hover
// Pointing at a card lights up its pin (with a callout); pointing at a pin lifts its card.
function markCardHovered(id) {
  if (id === hoveredCardId) return;
  if (hoveredCardId) $(`[data-pipe-card="${CSS.escape(hoveredCardId)}"]`, el.body)?.classList.remove('is-hovered');
  hoveredCardId = id;
  if (id) $(`[data-pipe-card="${CSS.escape(id)}"]`, el.body)?.classList.add('is-hovered');
}
el.body.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const card = e.target.closest('[data-pipe-card]');
  if (card) pipeMap.setHover(card.dataset.pipeCard, { callout: true });
});
el.body.addEventListener('pointerout', (e) => {
  if (e.pointerType !== 'mouse') return;
  const card = e.target.closest('[data-pipe-card]');
  if (card && !card.contains(e.relatedTarget)) pipeMap.setHover(null);
});

// ---------------------------------------------------------------- the hand-held print
/**
 * Hovering a pin shows its photo as a print held up the way a friend beside you would hold one up:
 * it swings in on an arc, overshoots a hair and settles, each time at its own slightly different
 * spot and angle, and drops away (the wrist tips and falls, no rewind) when you move on.
 *
 * Where it's held:
 *  - nothing open: from the bottom-right, hanging off the map's corner (the hand is out of frame);
 *  - a pipe open: from the left, landing over that pipe's photo in the panel, for comparing.
 * Click the pin and the print *becomes* the photo: it straightens, loses its white frame and settles
 * onto the photo's spot as the panel switches to that pipe.
 *
 * Prints live in their own layer over the whole page (under the masthead), click-through always.
 */
function createPolaroid(layer) {
  let current = null; // { id, el, pose, mode }
  let lastTilt = 0;
  let hideTimer = 0;
  let token = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const rest = (q) => `translate3d(${q.rx}px, ${q.ry}px, 0) rotate(${q.tilt}deg)`;
  const layerRect = () => layer.getBoundingClientRect();

  function pose(mode) {
    let tilt;
    do tilt = rnd(-6.5, 5.5); while (Math.abs(tilt - lastTilt) < 2.5 || Math.abs(tilt) < 0.8);
    lastTilt = tilt;
    return mode === 'photo'
      // from the left: the wrist is cocked the other way and the arc comes up from below-left
      ? { tilt, rx: rnd(-12, 12), ry: rnd(-10, 10), ex: -rnd(420, 520), ey: rnd(140, 220), er: tilt - 16 - rnd(0, 6), dx: -300, dy: 220, dr: tilt - 14 }
      : { tilt, rx: rnd(-14, 10), ry: rnd(-10, 8), ex: rnd(100, 150), ey: rnd(320, 360), er: tilt + 16 + rnd(0, 6), dx: 85, dy: 340, dr: tilt + 14 };
  }

  /** The open pipe's photo (or 3D view) in the panel, if enough of it is on screen to cover. */
  function panelMedia() {
    if (state.focus.kind !== 'inspect') return null;
    const m = $('.inspect .media', el.body);
    if (!m) return null;
    const r = m.getBoundingClientRect(); const L = layerRect();
    const visible = Math.min(r.bottom, L.bottom) - Math.max(r.top, L.top);
    return r.width > 0 && visible > 120 ? r : null;
  }

  function drop(card) {
    if (!card) return;
    const { el: c, pose: q } = card;
    if (reducedMotion()) { c.remove(); return; }
    const from = getComputedStyle(c).transform; // wherever it is now, even mid-entrance
    c.getAnimations().forEach((a) => a.cancel());
    const out = c.animate([
      { transform: from === 'none' ? rest(q) : from },
      { transform: `translate3d(${q.rx + q.dx}px, ${q.dy}px, 0) rotate(${q.dr}deg)` },
    ], { duration: 150, easing: 'cubic-bezier(0.45, 0, 0.85, 0.3)', fill: 'forwards' });
    out.onfinish = () => c.remove();
  }

  async function show(p) {
    clearTimeout(hideTimer);
    const media = panelMedia();
    const mode = media ? 'photo' : 'corner';
    if (current && current.id === p.id && current.mode === mode) return;
    drop(current);
    current = null;
    const my = ++token;
    const q = pose(mode);
    const c = document.createElement('figure');
    c.className = `polaroid is-${mode}`;
    c.dataset.tilt = q.tilt.toFixed(2);
    c.dataset.id = p.id;
    c.innerHTML = `<img src="${esc(p.photoUrl)}" alt="">
      <figcaption class="polaroid-caption"><span class="shapes">${p.allTypes.map((t) => shapeSvg(t, 14)).join('')}</span>
      <span class="polaroid-title">${esc(pipeTitle(p))}</span><span class="polaroid-claps">👏 ${n(state.claps[p.id] ?? 0)}</span></figcaption>`;
    c.style.visibility = 'hidden';
    if (mode === 'photo') c.style.width = `${Math.round(media.width + 24)}px`;
    layer.append(c);
    current = { id: p.id, el: c, pose: q, mode };
    if (mode === 'photo') await $('img', c).decode().catch(() => {}); // its height decides where it lands
    if (my !== token || !c.isConnected) return;
    const L = layerRect(); const W = c.offsetWidth; const H = c.offsetHeight;
    if (mode === 'photo') {
      const img = $('img', c);
      // photo centre over photo centre
      c.style.left = `${media.left + media.width / 2 - W / 2 - L.left}px`;
      c.style.top = `${media.top + media.height / 2 - (img.offsetTop + img.offsetHeight / 2) - L.top}px`;
    } else {
      const stage = el.stage.getBoundingClientRect();
      c.style.left = `${stage.right - W + 46 - L.left}px`;
      c.style.top = `${stage.bottom - H + 50 - L.top}px`;
    }
    c.style.transform = rest(q);
    c.style.visibility = '';
    if (!reducedMotion()) {
      c.animate([
        { transform: `translate3d(${q.ex}px, ${q.ey}px, 0) rotate(${q.er}deg)` },
        { transform: rest(q) },
      ], { duration: mode === 'photo' ? 280 : 220, easing: 'cubic-bezier(0.2, 1.22, 0.32, 1)' });
    }
  }

  /**
   * The held print turns into the panel's photo of the pipe just opened. Call right after the
   * panel has switched. Returns false when there was no print of that pipe to turn.
   */
  function become(id) {
    clearTimeout(hideTimer);
    if (!current || current.id !== id) { hide({ instant: true }); return false; }
    const card = current;
    current = null;
    token++;
    const c = card.el;
    c.classList.add('is-becoming');
    const frame = $('.inspect .photo-frame:not([hidden]) .photo-button img', el.body) || $('.inspect .model-frame', el.body);
    if (!frame || reducedMotion()) { c.remove(); return false; }
    frame.style.visibility = 'hidden';
    // No waiting for the panel's photo to load: only its left edge, top and width matter, and those are known.
    const T = frame.getBoundingClientRect();
    const img = $('img', c);
    const L = layerRect();
    const cardLeft = c.offsetLeft + L.left; const cardTop = c.offsetTop + L.top;
    const W = c.offsetWidth; const H = c.offsetHeight;
    const ox = W * 0.75; const oy = H * 1.3; // the card's transform-origin (75% 130%)
    const s = T.width / img.offsetWidth;
    const tx = T.left - cardLeft - ox - s * (img.offsetLeft - ox);
    const ty = T.top - cardTop - oy - s * (img.offsetTop - oy);
    const from = getComputedStyle(c).transform;
    c.getAnimations().forEach((a) => a.cancel());
    const ease = { duration: 380, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)', fill: 'forwards' };
    $('.polaroid-caption', c).animate([{ opacity: 1 }, { opacity: 0 }], { ...ease, duration: 160 });
    img.animate([{ borderColor: 'rgba(35, 34, 32, 1)' }, { borderColor: 'rgba(35, 34, 32, 0)' }], ease);
    const morph = c.animate([
      { transform: from === 'none' ? rest(card.pose) : from },
      { transform: `translate(${tx}px, ${ty}px) scale(${s})`, backgroundColor: 'rgba(255, 255, 255, 0)', borderColor: 'rgba(35, 34, 32, 0)', boxShadow: '0 0 0 rgba(35, 34, 32, 0)' },
    ], ease);
    morph.finished.catch(() => {}).then(() => { frame.style.visibility = ''; c.remove(); });
    return true;
  }

  function hide({ instant = false } = {}) {
    clearTimeout(hideTimer);
    if (instant) { token++; layer.querySelectorAll('.polaroid:not(.is-becoming)').forEach((c) => c.remove()); current = null; return; }
    hideTimer = setTimeout(() => { drop(current); current = null; }, 45);
  }

  return { show, hide, become, holding: (id) => Boolean(current && current.id === id) };
}
const printLayer = document.createElement('div');
printLayer.className = 'print-layer';
printLayer.setAttribute('aria-hidden', 'true');
document.body.append(printLayer);
const polaroid = createPolaroid(printLayer);

// ---------------------------------------------------------------- map gestures
const gestures = attachMapGestures(pipeMap.map, {
  pinsPx: () => (state.focus.kind === 'compose' ? [] : pipeMap.pinsPx()),
  candidatePx: () => (state.focus.kind === 'compose' ? pipeMap.candidatePx() : null),
  clampLngLat: pipeMap.clampLngLat,
  onPinTap: (id) => {
    if (state.focus.kind === 'inspect' && state.focus.pipeId === id) { polaroid.hide({ instant: true }); return; }
    const held = polaroid.holding(id);
    dispatch({ type: 'pipe/select', pipeId: id, from: 'map' });
    // The print being held up for this pin turns into the panel's photo of it.
    if (held) polaroid.become(id); else polaroid.hide({ instant: true });
  },
  onEmptyTap: (ll) => {
    // Tapping the map only moves the pin when there was no photo GPS to lose.
    if (state.focus.kind === 'compose' && !state.focus.draft.hasExif) {
      const c = pipeMap.clampLngLat(ll);
      dispatch({ type: 'compose/move', lat: c.lat, lng: c.lng });
    } else if (state.focus.kind === 'inspect') {
      dispatch({ type: 'focus/rest' });
    }
  },
  onHover: (hit) => {
    pipeMap.setHover(hit ? hit.id : null);
    markCardHovered(hit ? hit.id : null);
    pipeMap.map.getCanvas().style.cursor = hit ? 'pointer' : '';
    const p = hit ? pipeById(state, hit.id) : null;
    // A selected pin already wears its own label on the map; a hover card on top would say it twice.
    const selected = state.focus.kind === 'inspect' && hit && state.focus.pipeId === hit.id;
    if (!p || selected) { polaroid.hide(); return; }
    polaroid.show(p);
  },
  onCandidateHover: (over) => { if (over) pipeMap.map.getCanvas().style.cursor = 'grab'; },
  onCandidateDrag: (ll) => dispatch({ type: 'compose/move', lat: ll.lat, lng: ll.lng }),
  onCandidateDrop: (ll) => dispatch({ type: 'compose/move', lat: ll.lat, lng: ll.lng }),
});

// ---------------------------------------------------------------- boot
render(null, { type: 'boot' });
repo.loadAtlas().then((atlas) => {
  dispatch({ type: 'atlas/loaded', ...atlas });
  // Open on every pipe in the portal, wherever in the city people have posted them.
  if (state.focus.kind === 'rest') pipeMap.whenReady().then(() => pipeMap.fitPipes(visiblePipes(state), { duration: 0 }));
}).catch((err) => {
  console.error(err);
  el.body.innerHTML = `<div class="drawer-loading">Couldn’t load the map: ${esc(err.message)}</div>`;
});

// Canvas callouts use the web fonts; redraw once they've arrived.
document.fonts?.ready.then(() => pipeMap.redraw());

// Expose a tiny handle for debugging in the console.
window.pipeAtlas = { get state() { return state; }, dispatch, map: pipeMap.map, pins: pipeMap, repo };
