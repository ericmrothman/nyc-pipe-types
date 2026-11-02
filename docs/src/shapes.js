// The seven pipe-type silhouettes, defined once. The map canvas draws them with Path2D and the
// sidebar draws them as inline SVG, both from the same path string, so the two can't drift apart.

import { TYPE_BY_KEY } from './state.js';

const INK = '#232220';
const f = (n) => Number(n.toFixed(2));

function polygon(points) {
  return `M${points.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
}

/** SVG path data for a silhouette of "radius" r centred on (x, y). */
export function shapePath(shape, x, y, r) {
  switch (shape) {
    case 'circle':
      return `M${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)}Z`;
    case 'roundsquare': {
      const s = r * 0.9; const k = r * 0.38;
      const l = x - s; const t = y - s; const rr = x + s; const b = y + s;
      return `M${f(l + k)} ${f(t)}H${f(rr - k)}Q${f(rr)} ${f(t)} ${f(rr)} ${f(t + k)}V${f(b - k)}Q${f(rr)} ${f(b)} ${f(rr - k)} ${f(b)}`
        + `H${f(l + k)}Q${f(l)} ${f(b)} ${f(l)} ${f(b - k)}V${f(t + k)}Q${f(l)} ${f(t)} ${f(l + k)} ${f(t)}Z`;
    }
    case 'triangle': {
      const s = r * 1.25;
      return polygon([[x, y - s], [x + s * 0.95, y + s * 0.68], [x - s * 0.95, y + s * 0.68]]);
    }
    case 'boxdot': {
      const s = r * 0.92;
      return polygon([[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]]);
    }
    case 'diamond': {
      const s = r * 1.25;
      return polygon([[x, y - s], [x + s, y], [x, y + s], [x - s, y]]);
    }
    case 'star': {
      const outer = r * 1.35; const inner = outer * 0.48;
      return polygon(Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 ? inner : outer;
        return [x + rad * Math.cos(a), y + rad * Math.sin(a)];
      }));
    }
    case 'hexagon':
    default: {
      const s = r * 1.08;
      return polygon(Array.from({ length: 6 }, (_, i) => {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        return [x + s * Math.cos(a), y + s * Math.sin(a)];
      }));
    }
  }
}

/** The "box" type's lid dot sits inside its square. */
export const hasCentreDot = (shape) => shape === 'boxdot';
export const centreDotRadius = (r) => Math.max(1.2, r * 0.32);

/** Draws a type's silhouette on a canvas. */
export function drawShape(ctx, typeKey, x, y, r, { stroke = '#FFFFFF', lineWidth = 1.5 } = {}) {
  const type = TYPE_BY_KEY[typeKey] || TYPE_BY_KEY.mystery;
  const path = new Path2D(shapePath(type.shape, x, y, r));
  ctx.fillStyle = type.color;
  ctx.fill(path);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  if (hasCentreDot(type.shape)) {
    ctx.beginPath();
    ctx.arc(x, y, centreDotRadius(r), 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
  }
}

/** The same silhouette as an inline SVG icon, for chips, cards and headings. */
export function shapeSvg(typeKey, size = 16) {
  const type = TYPE_BY_KEY[typeKey] || TYPE_BY_KEY.mystery;
  const c = size / 2; const r = size * 0.36;
  const dot = hasCentreDot(type.shape) ? `<circle cx="${c}" cy="${c}" r="${f(centreDotRadius(r))}" fill="${INK}"/>` : '';
  return `<svg class="shape" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">`
    + `<path d="${shapePath(type.shape, c, c, r)}" fill="${type.color}" stroke="${INK}" stroke-width="1.25" stroke-linejoin="round"/>${dot}</svg>`;
}
