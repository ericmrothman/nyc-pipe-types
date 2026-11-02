// Drawer: a 400px left sidebar on desktop (>= 900px), a 4-snap bottom sheet on phones.
// The pure half (reduceDrawer / drawerAfter) decides WHERE the sheet should be;
// the DOM half (createDrawer) only moves pixels and reports how much map it covers.

export const MOBILE_QUERY = '(max-width: 899px)';

/** Snap heights. Adding a pipe opens at `half`, so the map and its pin stay visible above the form. */
export const SNAPS = Object.freeze({
  peek: () => 120,
  half: (vh) => Math.round(vh * 0.5),
  full: (vh) => Math.round(vh * 0.9),
});
const DRAG_ORDER = ['peek', 'half', 'full'];

/** Events that always fold the sheet down so the map can breathe. */
export const COLLAPSING_EVENTS = Object.freeze(['focus/rest', 'compose/cancel', 'escape/focusPrimary']);

export function snapHeightPx(snap, viewportH) {
  return (SNAPS[snap] || SNAPS.peek)(viewportH);
}

/** Pure: where should the sheet rest after a user gesture on the sheet itself? */
export function reduceDrawer(snap, event) {
  switch (event.type) {
    case 'drag/release': {
      const { heightPx, velocityPxPerMs = 0, viewportH } = event;
      const order = DRAG_ORDER;
      // A decisive flick moves one snap in the flick's direction.
      if (Math.abs(velocityPxPerMs) > 0.6) {
        const sized = order.map((s) => [s, snapHeightPx(s, viewportH)]);
        if (velocityPxPerMs > 0) return (sized.find(([, h]) => h > heightPx + 4) || sized[sized.length - 1])[0];
        return ([...sized].reverse().find(([, h]) => h < heightPx - 4) || sized[0])[0];
      }
      let best = order[0];
      for (const s of order) if (Math.abs(snapHeightPx(s, viewportH) - heightPx) < Math.abs(snapHeightPx(best, viewportH) - heightPx)) best = s;
      return best;
    }
    case 'handle/tap':
      return snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek';
    case 'snap/set':
      return event.snap;
    default:
      return snap;
  }
}

/** Pure: where should the sheet go after an app-level action changed focus? */
export function drawerAfter(snap, action, prevFocusKind, nextFocusKind) {
  if (COLLAPSING_EVENTS.includes(action.type)) return 'peek';
  if (prevFocusKind === nextFocusKind) return snap;
  switch (nextFocusKind) {
    case 'inspect': return snap === 'full' && prevFocusKind !== 'compose' ? 'full' : 'half';
    case 'compose': return 'half';
    case 'rest': return 'peek';
    default: return snap;
  }
}

/**
 * DOM controller. `onCoveredChange(px)` fires whenever the visible sheet height settles.
 * On desktop the sheet covers nothing (it sits beside the map, not on top).
 */
export function createDrawer({ el, handle, onCoveredChange, onUserSnap }) {
  const mq = window.matchMedia(MOBILE_QUERY);
  let snap = 'peek';
  let drag = null;

  const vh = () => window.innerHeight;
  const isMobile = () => mq.matches;
  const covered = () => (isMobile() ? snapHeightPx(snap, vh()) : 0);

  function apply({ animate = true } = {}) {
    el.dataset.snap = snap;
    if (!isMobile()) {
      el.style.height = '';
      onCoveredChange(0);
      return;
    }
    el.classList.toggle('is-animating', animate);
    el.style.height = `${snapHeightPx(snap, vh())}px`;
    el.setAttribute('aria-expanded', String(snap === 'half' || snap === 'full'));
    onCoveredChange(covered());
  }

  function setSnap(next, opts) {
    if (!next || next === snap) { apply({ animate: false, ...opts }); return; }
    snap = next;
    apply(opts);
  }

  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile() || e.button > 0) return;
    handle.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, startY: e.clientY, startH: el.getBoundingClientRect().height, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: 0 };
    el.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.startY - e.clientY;
    drag.moved = Math.max(drag.moved, Math.abs(dy));
    const dt = Math.max(1, e.timeStamp - drag.lastT);
    drag.v = (drag.lastY - e.clientY) / dt;
    drag.lastY = e.clientY; drag.lastT = e.timeStamp;
    const h = Math.min(vh() * 0.92, Math.max(96, drag.startH + dy));
    el.style.height = `${h}px`;
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const h = el.getBoundingClientRect().height;
    const wasTap = drag.moved < 6;
    const v = drag.v;
    drag = null;
    el.classList.remove('is-dragging');
    const next = wasTap
      ? reduceDrawer(snap, { type: 'handle/tap' })
      : reduceDrawer(snap, { type: 'drag/release', heightPx: h, velocityPxPerMs: v, viewportH: vh() });
    snap = next;
    apply();
    onUserSnap?.(snap);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      snap = reduceDrawer(snap, { type: 'handle/tap' });
      apply();
      onUserSnap?.(snap);
    }
  });

  el.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'height') el.classList.remove('is-animating');
  });
  mq.addEventListener('change', () => apply({ animate: false }));
  window.addEventListener('resize', () => { if (!drag) apply({ animate: false }); });

  return {
    get snap() { return snap; },
    get isMobile() { return isMobile(); },
    covered,
    setSnap,
    apply,
    isDragging: () => Boolean(drag),
  };
}
