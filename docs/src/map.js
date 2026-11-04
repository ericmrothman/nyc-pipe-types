// The map: MapLibre for streets, one HiDPI <canvas class="map-overlay"> for every pin.
// Pins are drawn, never DOM nodes, so 100+ of them pan at 60fps.

import { NYC_BOUNDS, WALK_CENTER, WALK_ZOOM, TYPE_BY_KEY } from './state.js';
import { drawShape } from './shapes.js';
import { zineStyle, resolveTheme, parseHatchId } from './map_theme.js';

// ---------------------------------------------------------------- map theme
// The theme every reader sees. Try the others live by adding ?lab to the Portal's URL (the Style Lab),
// then paste its "Copy config" output here. The font constants override the theme's fonts, one line
// each: null keeps the theme's own choice; any name in MAP_FONTS (map_theme.js) works.
// Eric's pick (Round 12): Risograph as a white line drawing. White land, parks and roofs with pink
// footprint outlines, pale kerbs, teal water, no building shadows, Darumadrop for every label.
const MAP_THEME = {
  preset: 'riso',
  colors: { land: '#ffffff', edge: '#e4d8d8', park: '#ffffff', roof: '#ffffff' },
  streetFont: 'Darumadrop One',
  placeCase: 'uppercase',
  placeSize: 1.35,
  placeSpacing: 0.03,
  streetWidth: 1.3,
  shadowOpacity: 0,
  shadowOffset: 0,
  labels: { parks: false, water: false },
};
const MAP_PLACE_FONT = null;  // neighbourhoods, boroughs, parks
const MAP_ROAD_FONT = null;   // street names
const MAP_WATER_FONT = null;  // rivers and bays
export const defaultTheme = () => resolveTheme({
  ...MAP_THEME,
  ...(MAP_PLACE_FONT && { placeFont: MAP_PLACE_FONT }),
  ...(MAP_ROAD_FONT && { streetFont: MAP_ROAD_FONT }),
  ...(MAP_WATER_FONT && { waterFont: MAP_WATER_FONT }),
});

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
// If the basemap can't load (offline, blocked), the pins still deserve a home.
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'paper', type: 'background', paint: { 'background-color': '#FFFFFF' } }],
};

const LOCAL_FONTS = new Set(['Darumadrop One', 'Cardo Regular', 'Cardo Italic', 'Cardo Bold']);
const LOCAL_RANGES = new Set(['0-255', '256-511', '8192-8447']);
const FONT_DIR = new URL('../assets/fonts/', import.meta.url);
const ZINE_GLYPHS = 'zine://{fontstack}/{range}';
let cartoGlyphs = 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf';

// Glyphs come through one door: our baked SDF ranges when we have them, CARTO's server for anything else
// (another font, or a rare character outside the ranges we baked, drawn in CARTO's Open Sans).
if (!globalThis.__zineGlyphs) {
  globalThis.__zineGlyphs = true;
  maplibregl.addProtocol('zine', async (params, abort) => {
    const [, stackRaw, range] = params.url.match(/^zine:\/\/(.+)\/(\d+-\d+)$/) || [];
    const stack = decodeURIComponent(stackRaw || '');
    const ours = LOCAL_FONTS.has(stack);
    const url = ours && LOCAL_RANGES.has(range)
      ? new URL(`${encodeURIComponent(stack)}/${range}.pbf`, FONT_DIR).href
      : cartoGlyphs.replace('{fontstack}', encodeURIComponent(ours ? (stack === 'Cardo Bold' ? 'Open Sans Bold' : stack === 'Cardo Italic' ? 'Open Sans Italic' : 'Open Sans Regular') : stack)).replace('{range}', range);
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`Glyphs ${res.status}: ${stack} ${range}`);
    return { data: await res.arrayBuffer() };
  });
}

// ---------------------------------------------------------------- hand-made effects
/**
 * A tileable square of crayon stripes: the base colour with a little paper grain showing through,
 * and wavering stripes of the line colour. Drawn at 2x for sharp screens.
 */
export function drawHatch({ base, line, dir }, size = 64) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [br, bg, bb] = hex(base); const [lr, lg, lb] = hex(line);
  const data = new Uint8ClampedArray(size * size * 4);
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gap = 16; // stripes 8 css px apart
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const along = dir === 'h' ? x : y; const across = dir === 'h' ? y : x;
      // stripe centres waver with a period that divides the tile, so the pattern tiles seamlessly
      const wave = 1.6 * Math.sin((2 * Math.PI * along) / size + (6 * Math.PI * across) / size) + 0.8 * Math.sin((6 * Math.PI * along) / size);
      const d = Math.abs((((across + wave) % gap) + gap) % gap - gap / 2);
      const grain = rand();
      const inStripe = d < 1.7 + grain * 0.7 && grain > 0.08; // crayon skips: a few gaps in each stroke
      const paper = grain < 0.06; // and a few specks of paper in the fill
      const i = (y * size + x) * 4;
      const [r, g, b] = inStripe ? [lr, lg, lb] : [br, bg, bb];
      data.set([r, g, b, paper && !inStripe ? 150 : 255], i);
    }
  }
  return { width: size, height: size, data };
}

let wobbleInstalled = false;
/** The shaky hand: an SVG displacement filter the map canvas can wear (CSS: .is-wobbly). */
function installWobbleFilter() {
  if (wobbleInstalled) return;
  wobbleInstalled = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  svg.innerHTML = `<filter id="crayon-wobble" x="-2%" y="-2%" width="104%" height="104%">
    <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="11" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G"/></filter>`;
  document.body.append(svg);
}

/** Positron, themed, with its glyphs routed through the zine:// door. */
function themedStyle(raw, theme) {
  if (raw.glyphs && !raw.glyphs.startsWith('zine:')) cartoGlyphs = raw.glyphs;
  const s = zineStyle(raw, theme);
  s.glyphs = ZINE_GLYPHS;
  return s;
}

const CLOSEST_FIT_ZOOM = 16;
const RESCUE_ZOOM_BELOW = 12;   // below this a single pin is hard to find, so showing one zooms in
const RESCUE_ZOOM = 15;
const CAMERA_MS = 1600;
const PRESENCE = { cellMs: 420, rippleMs: 380 };
const COST_OF_COVERING_A_SOFT_MARK = 1000;
const INK = '#232220';
// The story's two typefaces, also on the canvas (callouts) so the map speaks the same voice.
const LABEL_FONT = '400 15px "Darumadrop One", Georgia, serif';
const COUNT_FONT = '700 13px Cardo, Georgia, serif';
const PIN_EDGE = '#FFFFFF';

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Draws one pipe pin in its primary type's shape. A photo with a second kind of pipe gets that kind's
 * silhouette tucked on the upper-right rim; two or more of the same kind show as a twin behind it.
 */
export function drawPipePin(ctx, pipe, x, y, r, { alpha = 1, emphasised = false } = {}) {
  const stroke = emphasised ? INK : PIN_EDGE;
  ctx.save();
  ctx.globalAlpha = alpha;
  const mixed = pipe.allTypes.length > 1;
  const several = !mixed && (pipe.counts[pipe.primaryType] || 1) > 1;
  if (several) drawShape(ctx, pipe.primaryType, x + r * 0.48, y - r * 0.48, r * 0.9, { stroke });
  drawShape(ctx, pipe.primaryType, x, y, r, { stroke });
  if (mixed) drawShape(ctx, pipe.allTypes[1], x + r * 0.72, y - r * 0.72, Math.max(3, r * 0.58), { stroke, lineWidth: 1.25 });
  ctx.restore();
}

function drawTeardrop(ctx, x, y, { pulse = 0, hot = false, manual = false }) {
  const headY = y - 24;
  ctx.save();
  if (pulse > 0) {
    ctx.beginPath();
    ctx.arc(x, y, 6 + pulse * 22, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 89, 94, ${0.55 * (1 - pulse)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // ground shadow
  ctx.beginPath(); ctx.ellipse(x, y, 7, 2.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(35, 34, 32, 0.25)'; ctx.fill();
  // body
  const R = hot ? 15 : 13.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 4, y - 8, x - R, headY + 8, x - R, headY);
  ctx.arc(x, headY, R, Math.PI, 0);
  ctx.bezierCurveTo(x + R, headY + 8, x + 4, y - 8, x, y);
  ctx.closePath();
  ctx.fillStyle = manual ? '#FF924C' : '#FF595E';
  ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, headY, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Chooses where a callout box goes around an anchor: hard obstacles (UI controls, the covered
 * strip, the anchor itself) are forbidden; soft obstacles (other pins) cost a lot. Sticky across frames.
 */
export function placeCallout({ anchor, size, gap, hard, soft, bounds, previous }) {
  const { w, h } = size;
  const candidates = {
    above: { x: anchor.x - w / 2, y: anchor.y - gap - h },
    right: { x: anchor.x + gap, y: anchor.y - h / 2 },
    left: { x: anchor.x - gap - w, y: anchor.y - h / 2 },
    below: { x: anchor.x - w / 2, y: anchor.y + gap },
    aboveRight: { x: anchor.x + gap * 0.6, y: anchor.y - gap - h },
    aboveLeft: { x: anchor.x - gap * 0.6 - w, y: anchor.y - gap - h },
  };
  let best = null;
  for (const [name, pos] of Object.entries(candidates)) {
    const box = { x: pos.x, y: pos.y, w, h };
    let cost = name === previous ? -1 : 0;
    const outside = box.x < bounds.x || box.y < bounds.y || box.x + w > bounds.x + bounds.w || box.y + h > bounds.y + bounds.h;
    if (outside) cost += 1e7;
    for (const o of hard) if (overlapArea(box, o) > 0) cost += 1e6;
    for (const s of soft) if (overlapArea(box, s) > 0) cost += COST_OF_COVERING_A_SOFT_MARK;
    if (!best || cost < best.cost) best = { name, box, cost };
  }
  return best;
}

/**
 * @param {HTMLElement} container
 * @param {{ getClaps: (id: string) => number, obstacleRoot: HTMLElement }} opts
 */
export function createPipeMap(container, { getClaps, obstacleRoot, theme: initialTheme = null }) {
  const pad = 0.5;
  const latSpan = NYC_BOUNDS.north - NYC_BOUNDS.south;
  const lngSpan = NYC_BOUNDS.east - NYC_BOUNDS.west;
  const map = new maplibregl.Map({
    container,
    center: [WALK_CENTER.lng, WALK_CENTER.lat],
    zoom: WALK_ZOOM,
    minZoom: 9.5,
    maxZoom: 19,
    maxBounds: [
      [NYC_BOUNDS.west - lngSpan * pad * 0.5, NYC_BOUNDS.south - latSpan * pad * 0.5],
      [NYC_BOUNDS.east + lngSpan * pad * 0.5, NYC_BOUNDS.north + latSpan * pad * 0.5],
    ],
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
    cooperativeGestures: false,
  });
  let rawStyle = null;
  let theme = initialTheme || defaultTheme();
  // Striped fills are drawn the first time a style asks for them, in whatever colours it names.
  map.on('styleimagemissing', (e) => {
    const spec = parseHatchId(e.id);
    if (spec && !map.hasImage(e.id)) map.addImage(e.id, drawHatch(spec), { pixelRatio: 2 });
  });
  const applyWobble = () => {
    if (theme.wobble) installWobbleFilter();
    container.classList.toggle('is-wobbly', Boolean(theme.wobble) && !theme.original);
  };
  applyWobble();
  map.setStyle(STYLE_URL, { transformStyle: (_previous, next) => { rawStyle = next; return themedStyle(next, theme); }, localIdeographFontFamily: 'sans-serif' });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let styleFellBack = false;
  map.on('error', (e) => {
    const msg = String(e?.error?.message || '');
    if (!styleFellBack && !map.isStyleLoaded() && /style|fetch|Failed|NetworkError/i.test(msg)) {
      styleFellBack = true;
      map.setStyle(FALLBACK_STYLE);
    }
  });

  const canvas = document.createElement('canvas');
  canvas.className = 'map-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  const controls = map.getContainer().querySelector('.maplibregl-control-container');
  map.getContainer().insertBefore(canvas, controls);
  const ctx = canvas.getContext('2d');

  let pins = [];            // { pipe, appearAt, leaving?: number }
  let selectedId = null;
  let hoverId = null;
  let hoverCallout = false; // true when the hover comes from the sidebar (the map's own hover has a photo tooltip)
  let candidate = null;     // { id, lng, lat, hasExif, hot }
  let candidatePulseAt = 0;
  let coveredBottomPx = 0;
  let lastCallout = null;
  let animating = false;
  let ready = false;
  const readyWaiters = [];

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  sizeCanvas();
  map.on('resize', () => { sizeCanvas(); map.triggerRepaint(); });

  map.on('load', () => {
    ready = true;
    readyWaiters.splice(0).forEach((f) => f());
  });

  const pinRadius = () => {
    const z = map.getZoom();
    return Math.min(9, Math.max(3.5, 3.5 + (z - 12) * 1.25));
  };

  function presenceAlpha(pin, now) {
    if (pin.leaving) return 1 - easeInOutCubic(Math.min(1, (now - pin.leaving) / PRESENCE.cellMs));
    return easeInOutCubic(Math.max(0, Math.min(1, (now - pin.appearAt) / PRESENCE.cellMs)));
  }

  function obstacleBoxes() {
    const base = map.getContainer().getBoundingClientRect();
    const boxes = [];
    const nodes = [...(obstacleRoot?.querySelectorAll('[data-map-obstacle]') || []), ...map.getContainer().querySelectorAll('.maplibregl-ctrl')];
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(n).visibility === 'hidden') continue;
      boxes.push({ x: r.left - base.left - 4, y: r.top - base.top - 4, w: r.width + 8, h: r.height + 8 });
    }
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    if (coveredBottomPx > 0) boxes.push({ x: 0, y: h - coveredBottomPx, w, h: coveredBottomPx });
    return boxes;
  }

  function drawCallout(pipe, x, y, r) {
    const type = TYPE_BY_KEY[pipe.primaryType];
    // Same name the sidebar uses: a mixed photo reads "Standpipe + Air inlet", not just its primary type.
    const label = pipe.customTag || (pipe.allTypes.length > 1 ? pipe.allTypes.map((t) => TYPE_BY_KEY[t].short).join(' + ') : type.label);
    const claps = `👏 ${getClaps(pipe.id).toLocaleString('en-US')}`;
    ctx.save();
    ctx.font = LABEL_FONT;
    const lw = ctx.measureText(label).width;
    ctx.font = COUNT_FONT;
    const cw = ctx.measureText(claps).width;
    const w = Math.ceil(lw + cw + 14 + 22 + 12);
    const h = 30;
    const { clientWidth: W, clientHeight: H } = map.getContainer();
    const others = [];
    for (const p of pins) {
      if (p.pipe.id === pipe.id || p.leaving) continue;
      const pt = map.project([p.pipe.lng, p.pipe.lat]);
      if (Math.abs(pt.x - x) < 200 && Math.abs(pt.y - y) < 120) others.push({ x: pt.x - 6, y: pt.y - 6, w: 12, h: 12 });
    }
    const hard = [...obstacleBoxes(), { x: x - r - 3, y: y - r - 3, w: r * 2 + 6, h: r * 2 + 6 }];
    const place = placeCallout({ anchor: { x, y }, size: { w, h }, gap: r + 12, hard, soft: others, bounds: { x: 4, y: 4, w: W - 8, h: H - 8 }, previous: lastCallout });
    lastCallout = place.name;
    const b = place.box;
    // leader
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(Math.max(b.x + 6, Math.min(b.x + b.w - 6, x)), Math.max(b.y + 4, Math.min(b.y + b.h - 4, y)));
    ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.stroke();
    roundedRect(ctx, b.x, b.y, b.w, b.h, 3);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.stroke();
    drawShape(ctx, pipe.primaryType, b.x + 15, b.y + h / 2, 5, { stroke: INK, lineWidth: 1 });
    ctx.fillStyle = INK;
    ctx.textBaseline = 'middle';
    ctx.font = LABEL_FONT;
    ctx.fillText(label, b.x + 26, b.y + h / 2 + 0.5);
    ctx.font = COUNT_FONT;
    ctx.fillStyle = '#65635E';
    ctx.fillText(claps, b.x + 26 + lw + 10, b.y + h / 2 + 0.5);
    ctx.restore();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    const now = performance.now();
    const r = pinRadius();
    let stillAnimating = false;
    pins = pins.filter((p) => !(p.leaving && now - p.leaving > PRESENCE.cellMs));
    let selectedPin = null;
    let hoverPin = null;
    for (const p of pins) {
      const a = presenceAlpha(p, now);
      if (a < 1) stillAnimating = true;
      if (a <= 0.001) continue;
      const pt = map.project([p.pipe.lng, p.pipe.lat]);
      if (pt.x < -20 || pt.y < -20 || pt.x > canvas.width / dpr + 20 || pt.y > canvas.height / dpr + 20) continue;
      if (p.pipe.id === selectedId && !p.leaving) { selectedPin = { p, pt }; continue; }
      if (p.pipe.id === hoverId && !p.leaving) { hoverPin = { p, pt }; continue; }
      drawPipePin(ctx, p.pipe, pt.x, pt.y, r, { alpha: a * (selectedId || candidate ? 0.8 : 1) });
    }
    if (hoverPin) {
      // Hovered (on the map, or via its card in the sidebar): a halo you can't miss when your eye jumps over.
      const { pt, p } = hoverPin;
      const R = Math.max(r * 1.55, 8.5);
      ctx.save();
      ctx.beginPath(); ctx.arc(pt.x, pt.y, R + 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 202, 58, 0.45)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
      ctx.restore();
      drawPipePin(ctx, p.pipe, pt.x, pt.y, R, { emphasised: true });
      if (hoverCallout && !selectedPin) drawCallout(p.pipe, pt.x, pt.y, R);
    }
    if (selectedPin) {
      const { pt, p } = selectedPin;
      const R = Math.max(r * 1.7, 9);
      ctx.save();
      ctx.beginPath(); ctx.arc(pt.x, pt.y, R + 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 202, 58, 0.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(pt.x, pt.y, R + 9, 0, Math.PI * 2);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.stroke();
      ctx.restore();
      drawPipePin(ctx, p.pipe, pt.x, pt.y, R, { emphasised: true });
      drawCallout(p.pipe, pt.x, pt.y, R);
    }
    if (candidate) {
      const pt = map.project([candidate.lng, candidate.lat]);
      // The pin pulses for a few beats when it lands (or jumps), then sits still so typing in the form
      // doesn't keep the map repainting at 60fps.
      const age = now - candidatePulseAt;
      const live = age < 4800 && !reducedMotion();
      const pulse = live ? ((age % 1600) / 1600) : 0;
      drawTeardrop(ctx, pt.x, pt.y, { pulse, hot: candidate.hot, manual: !candidate.hasExif });
      if (live) stillAnimating = true;
    }
    if (stillAnimating && !reducedMotion()) {
      if (!animating) { animating = true; }
      requestAnimationFrame(() => map.triggerRepaint());
    } else {
      animating = false;
    }
  }
  map.on('render', draw);

  function uncoveredSize() {
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    return { x: w, y: Math.max(0, h - coveredBottomPx) };
  }

  // The map's own padding always equals the covered strip, so every camera move
  // (easeTo, flyTo, fitBounds) centres on the uncovered part of the map.
  function applyCoveredPadding(px) {
    const { clientWidth: W, clientHeight: H } = map.getContainer();
    const current = map.getPadding();
    if (current.bottom === px && !current.top && !current.left && !current.right) return;
    // Keep whatever is on screen exactly where it is while the padding changes.
    const newCentre = map.unproject([W / 2, (H - px) / 2]);
    map.jumpTo({ center: newCentre, padding: { top: 0, left: 0, right: 0, bottom: px } });
  }

  function moveCamera(opts) {
    const duration = reducedMotion() ? 0 : (opts.duration ?? CAMERA_MS);
    map.easeTo({ ...opts, duration, easing: easeInOutCubic });
  }

  const api = {
    map,
    whenReady: () => new Promise((res) => (ready ? res() : readyWaiters.push(res))),

    setPipes(nextPipes, focal) {
      const now = performance.now();
      const nextIds = new Set(nextPipes.map((p) => p.id));
      const current = new Map(pins.filter((p) => !p.leaving).map((p) => [p.pipe.id, p]));
      const fp = focal ? map.project([focal.lng, focal.lat]) : null;
      const { x: W, y: H } = uncoveredSize();
      const maxD = Math.hypot(W, H) || 1;
      const out = [];
      for (const pipe of nextPipes) {
        const had = current.get(pipe.id);
        if (had) { out.push({ ...had, pipe }); continue; }
        let delay = 0;
        if (fp && !reducedMotion()) {
          const pt = map.project([pipe.lng, pipe.lat]);
          delay = Math.min(1, Math.hypot(pt.x - fp.x, pt.y - fp.y) / maxD) * PRESENCE.rippleMs;
        }
        out.push({ pipe, appearAt: reducedMotion() || !fp ? now - PRESENCE.cellMs : now + delay });
      }
      for (const p of pins) if (!p.leaving && !nextIds.has(p.pipe.id)) out.push({ ...p, leaving: reducedMotion() ? now - PRESENCE.cellMs : now });
      pins = out;
      map.triggerRepaint();
    },
    setSelected(id) { if (id !== selectedId) { selectedId = id; lastCallout = null; map.triggerRepaint(); } },
    setHover(id, { callout = false } = {}) {
      if (id === hoverId && callout === hoverCallout) return;
      hoverId = id; hoverCallout = Boolean(id) && callout;
      map.triggerRepaint();
    },
    setCandidate(c) {
      if (c && (!candidate || candidate.id !== c.id)) candidatePulseAt = performance.now();
      candidate = c;
      map.triggerRepaint();
    },
    pulseCandidate() { candidatePulseAt = performance.now(); map.triggerRepaint(); },
    setCovered(px) { coveredBottomPx = px; applyCoveredPadding(px); map.triggerRepaint(); },
    get coveredBottomPx() { return coveredBottomPx; },
    uncoveredSize,
    redraw: () => map.triggerRepaint(),
    /** Re-inks the basemap in place (a style diff: no reload, the camera and pins stay put). */
    setTheme(next) {
      theme = next;
      applyWobble();
      if (!rawStyle) return; // the base style hasn't arrived yet; it will be themed when it does
      const apply = () => map.setStyle(themedStyle(rawStyle, theme), { diff: true });
      if (map.style?._loaded) apply(); else map.once('style.load', apply);
    },
    get theme() { return theme; },

    pinsPx() {
      return pins.filter((p) => !p.leaving).map((p) => {
        const pt = map.project([p.pipe.lng, p.pipe.lat]);
        return { id: p.pipe.id, x: pt.x, y: pt.y };
      }).filter((p) => p.y < uncoveredSize().y + 2);
    },
    candidatePx() {
      if (!candidate) return null;
      const pt = map.project([candidate.lng, candidate.lat]);
      return { x: pt.x, y: pt.y };
    },
    clampLngLat({ lng, lat }) {
      return { lng: Math.min(NYC_BOUNDS.east, Math.max(NYC_BOUNDS.west, lng)), lat: Math.min(NYC_BOUNDS.north, Math.max(NYC_BOUNDS.south, lat)) };
    },

    /**
     * Brings a point into view only if the reader can't already see it. Never zooms, except to rescue
     * someone zoomed so far out that the pin would be one dot among hundreds.
     */
    showPoint({ lng, lat }) {
      const pt = map.project([lng, lat]);
      const { x: W, y: H } = uncoveredSize();
      const inset = 24;
      const visible = pt.x >= inset && pt.x <= W - inset && pt.y >= inset && pt.y <= H - inset;
      if (visible) return false;
      const zoom = Math.max(map.getZoom(), RESCUE_ZOOM_BELOW > map.getZoom() ? RESCUE_ZOOM : 0);
      const far = Math.hypot(pt.x - W / 2, pt.y - H / 2) > Math.hypot(W, H) * 1.5;
      if (far && !reducedMotion()) map.flyTo({ center: [lng, lat], zoom, duration: CAMERA_MS, easing: easeInOutCubic, essential: true });
      else moveCamera({ center: [lng, lat], zoom, duration: 700 });
      return true;
    },
    /** The smallest nudge that lifts a point out from under the sheet: no zoom, no recentring. */
    liftAboveSheet({ lng, lat }) {
      const pt = map.project([lng, lat]);
      const limit = uncoveredSize().y - 40;
      if (pt.y <= limit) return false;
      map.panBy([0, pt.y - limit], { duration: reducedMotion() ? 0 : 350, easing: easeInOutCubic });
      return true;
    },
    flyToPoint({ lng, lat }, zoom) {
      if (reducedMotion()) { map.jumpTo({ center: [lng, lat], zoom }); return; }
      map.flyTo({ center: [lng, lat], zoom, duration: CAMERA_MS, easing: easeInOutCubic, essential: true });
    },
    fitPipes(list, { maxZoom = CLOSEST_FIT_ZOOM, duration = CAMERA_MS } = {}) {
      if (!list.length) return;
      const b = new maplibregl.LngLatBounds();
      for (const p of list) b.extend([p.lng, p.lat]);
      map.fitBounds(b, { padding: { top: 70, left: 24, right: 24, bottom: 24 }, maxZoom, duration: reducedMotion() ? 0 : duration, easing: easeInOutCubic });
    },
  };
  return api;
}
