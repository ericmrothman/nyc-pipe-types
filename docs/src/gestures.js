// Pointer physics for the map: tap vs. pan vs. pinch, zoom-scaled hit radii,
// teardrop-pin dragging, and double-tap disambiguation.

export const TAP_MOVEMENT_LIMIT_PX = 6;
export const PIN_SNAP_RADIUS_PX = 24;
export const SMALLEST_PIN_SNAP_RADIUS_PX = 10;
export const START_PIN_HEAD_RISE_PX = 24;
export const START_PIN_HIT_RADIUS_PX = 22;
export const DOUBLE_TAP_WINDOW_MS = 260;

/** The zero-travel identity law: only a one-finger gesture that barely moved is a tap. */
export function classifyPointerGesture({ largestMovementPx, mostPointersDown }) {
  if (mostPointersDown > 1) return 'pinch';
  if (largestMovementPx >= TAP_MOVEMENT_LIMIT_PX) return 'pan';
  return 'tap';
}

/** Web-Mercator pixels per mile at this zoom (512px tiles, as MapLibre uses). */
export function pixelsPerMile(zoom, lat) {
  const metresPerPx = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
  return 1609.344 / metresPerPx;
}

export function pinSnapRadiusPx(zoom, lat) {
  return Math.min(PIN_SNAP_RADIUS_PX, Math.max(SMALLEST_PIN_SNAP_RADIUS_PX, pixelsPerMile(zoom, lat) * 0.1));
}

/** @param {{x:number,y:number}} tapPx @param {{id:string,x:number,y:number}[]} pinsPx */
export function pinNearTap(tapPx, pinsPx, radiusPx) {
  let best = null;
  let bestD = Infinity;
  for (const p of pinsPx) {
    const d = Math.hypot(p.x - tapPx.x, p.y - tapPx.y);
    if (d <= radiusPx && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/** A teardrop's bulk sits above its tip, so its hit target does too. */
export function startPinHeadCentre(pinPx) {
  return { x: pinPx.x, y: pinPx.y - START_PIN_HEAD_RISE_PX };
}

export function isOnStartPin(pointPx, pinPx) {
  if (!pinPx) return false;
  const head = startPinHeadCentre(pinPx);
  return Math.hypot(pointPx.x - head.x, pointPx.y - head.y) <= START_PIN_HIT_RADIUS_PX;
}

/**
 * Wires pointer handling onto a MapLibre map.
 * @param {maplibregl.Map} map
 * @param {{
 *   pinsPx: () => {id:string,x:number,y:number}[],
 *   candidatePx: () => ({x:number,y:number}|null),
 *   clampLngLat: (ll: {lng:number,lat:number}) => {lng:number,lat:number},
 *   onPinTap: (id: string) => void,
 *   onEmptyTap: (lngLat: {lng:number,lat:number}) => void,
 *   onHover: (hit: {id:string,x:number,y:number}|null) => void,
 *   onCandidateHover: (over: boolean) => void,
 *   onCandidateDrag: (lngLat: {lng:number,lat:number}) => void,
 *   onCandidateDrop: (lngLat: {lng:number,lat:number}) => void,
 * }} h
 */
export function attachMapGestures(map, h) {
  const el = map.getCanvasContainer();
  const down = new Map(); // pointerId -> {x,y}
  let gesture = null;     // { startX, startY, largest, most, pointerType }
  let pinDrag = null;     // { pointerId, grab:{x,y}, origin:{lng,lat} }
  let emptyTapTimer = 0;

  const local = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const snapRadius = () => pinSnapRadiusPx(map.getZoom(), map.getCenter().lat);

  function onDown(e) {
    clearTimeout(emptyTapTimer);
    const p = local(e);
    down.set(e.pointerId, p);
    if (down.size === 1) gesture = { startX: p.x, startY: p.y, largest: 0, most: 1, pointerType: e.pointerType };
    else if (gesture) gesture.most = Math.max(gesture.most, down.size);

    const cand = h.candidatePx();
    if (down.size === 1 && cand && isOnStartPin(p, cand) && e.button <= 0) {
      e.preventDefault();
      e.stopPropagation();
      map.dragPan.disable();
      el.setPointerCapture(e.pointerId);
      pinDrag = { pointerId: e.pointerId, grab: { x: p.x - cand.x, y: p.y - cand.y }, origin: map.unproject([cand.x, cand.y]) };
      el.classList.add('is-dragging-pin');
    }
  }

  function onMove(e) {
    const p = local(e);
    if (down.has(e.pointerId) && gesture) {
      gesture.largest = Math.max(gesture.largest, Math.hypot(p.x - gesture.startX, p.y - gesture.startY));
      down.set(e.pointerId, p);
    }
    if (pinDrag && e.pointerId === pinDrag.pointerId) {
      const ll = h.clampLngLat(map.unproject([p.x - pinDrag.grab.x, p.y - pinDrag.grab.y]));
      h.onCandidateDrag(ll);
      return;
    }
    // Hover tooltips are a mouse-only luxury: touch has no hover, and ghosts linger.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      const cand = h.candidatePx();
      const overCand = Boolean(cand && isOnStartPin(p, cand));
      h.onCandidateHover(overCand);
      // Hover hugs the pin as drawn (taps keep the generous finger-sized radius), so leaving a pin
      // is noticed the moment the pointer is off it.
      h.onHover(overCand ? null : pinNearTap(p, h.pinsPx(), h.hoverRadius ? h.hoverRadius() : snapRadius()));
    }
  }

  function finishPinDrag(commit) {
    const drag = pinDrag;
    pinDrag = null;
    map.dragPan.enable();
    el.classList.remove('is-dragging-pin');
    if (!drag) return;
    try { el.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    if (commit) {
      const cand = h.candidatePx();
      if (cand) h.onCandidateDrop(h.clampLngLat(map.unproject([cand.x, cand.y])));
    } else {
      h.onCandidateDrag(drag.origin);
      h.onCandidateDrop(drag.origin);
    }
  }

  function onUp(e) {
    const p = local(e);
    if (pinDrag && e.pointerId === pinDrag.pointerId) {
      down.delete(e.pointerId);
      finishPinDrag(true);
      gesture = null;
      return;
    }
    if (!down.has(e.pointerId)) return;
    down.delete(e.pointerId);
    if (down.size > 0 || !gesture) return;
    const kind = classifyPointerGesture({ largestMovementPx: gesture.largest, mostPointersDown: gesture.most });
    gesture = null;
    if (kind !== 'tap' || (e.button > 0)) return;
    const hit = pinNearTap(p, h.pinsPx(), snapRadius());
    if (hit) {
      // Let MapLibre finish its own touchend bookkeeping first, or it cancels the camera move we start.
      setTimeout(() => h.onPinTap(hit.id), 0);
      return;
    }
    // Wait out a possible second tap (double-tap zoom) before treating this as "tap on nothing".
    const lngLat = map.unproject([p.x, p.y]);
    emptyTapTimer = setTimeout(() => h.onEmptyTap(lngLat), DOUBLE_TAP_WINDOW_MS);
  }

  function onCancel(e) {
    down.delete(e.pointerId);
    if (pinDrag && e.pointerId === pinDrag.pointerId) finishPinDrag(true);
    if (down.size === 0) gesture = null;
  }

  el.addEventListener('pointerdown', onDown, { capture: true });
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { h.onHover(null); h.onCandidateHover(false); } });
  el.addEventListener('dblclick', () => clearTimeout(emptyTapTimer));

  return {
    isDraggingPin: () => Boolean(pinDrag),
    cancelPinDrag: () => finishPinDrag(false),
  };
}
