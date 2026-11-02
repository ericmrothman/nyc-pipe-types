// Map themes: CARTO Positron, cleaned up and re-inked. Pure functions, no DOM, no map.
//
// zineStyle(rawPositron, config) returns a new style. Every theme first gets the same clean-up of
// Positron's ~78 layers (no dotted boundaries, paths, rail or underground tunnels; cross streets get
// their white fill at the opening zoom; no blotchy residential grey; no shouting labels), then the
// theme's colours, fonts, sizes and building shadows. "Original Positron" skips both, for A/B checks.

/** Fonts the map can use. Ours are baked into ./assets/fonts; the rest come from CARTO's glyph server. */
export const MAP_FONTS = Object.freeze([
  'Darumadrop One', 'Cardo Regular', 'Cardo Bold', 'Cardo Italic',
  'Open Sans Regular', 'Open Sans Bold', 'Open Sans Italic',
  'Montserrat Regular', 'Montserrat Medium', 'Montserrat SemiBold', 'Montserrat Regular Italic',
]);

/** The knobs every theme sets. Sizes and widths are multipliers (1 = the theme's normal). */
const BASE = Object.freeze({
  colors: {
    land: '#E5E4DF', street: '#FFFFFF', edge: '#C9C7C0', water: '#C5D7E0', park: '#D5E3CE',
    roof: '#F7F6F2', roofEdge: '#D6D3CB', shadow: '#232220',
    label: '#3A3835', halo: '#F7F6F2', streetLabel: '#6B6862', waterLabel: '#5D7A88', parkLabel: '#5E7A57',
  },
  placeFont: 'Open Sans Bold', streetFont: 'Open Sans Regular', waterFont: 'Open Sans Italic',
  placeCase: 'none',       // 'none' (Mixed Case) | 'uppercase'
  placeSize: 1, streetSize: 1, placeSpacing: 0, haloWidth: 2,
  streetWidth: 1,
  buildings: true, shadowOpacity: 0.24, shadowOffset: 3, roofOutline: true,
  labels: { places: true, streets: true, parks: true, water: true },
});

const theme = (name, blurb, patch) => ({ name, blurb, ...BASE, ...patch, colors: { ...BASE.colors, ...patch.colors }, labels: { ...BASE.labels, ...patch.labels } });

export const PRESETS = Object.freeze({
  editorial: theme('Clean Editorial', 'Quiet paper, white streets, soft roofs. Gets out of the pins’ way.', {}),
  zine: theme('Warm Zine', 'The sidebar’s grey paper and ink-edged roofs, Darumadrop neighbourhoods.', {
    colors: { land: '#DEDEDE', street: '#F7F6F2', edge: '#B8B5AD', water: '#BACFDB', park: '#CFDFC6', roof: '#FFFFFF', roofEdge: '#8A867E', label: '#232220', halo: '#F7F6F2' },
    placeFont: 'Darumadrop One', waterFont: 'Cardo Italic', placeSize: 1.1, shadowOpacity: 0.34, shadowOffset: 3.5,
  }),
  atlas: theme('Bookish Atlas', 'An old city atlas: Cardo throughout, spaced capitals for neighbourhoods.', {
    colors: { land: '#E8E6DF', street: '#FBFAF6', edge: '#C4BFB2', water: '#C3D3D6', park: '#D8E1C8', roof: '#F3F0E8', roofEdge: '#A39E92', label: '#2F2B25', streetLabel: '#5C574E', waterLabel: '#4F6A72', parkLabel: '#56704C' },
    placeFont: 'Cardo Bold', streetFont: 'Cardo Regular', waterFont: 'Cardo Italic',
    placeCase: 'uppercase', placeSpacing: 0.14, placeSize: 0.95, streetSize: 1.08, shadowOpacity: 0.2, shadowOffset: 2,
  }),
  newsprint: theme('Newsprint Sepia', 'Yellowed broadsheet: brown ink, condensed caps, a little grain of age.', {
    colors: { land: '#EDE4D1', street: '#FAF5EA', edge: '#CDBF9F', water: '#CAD5CC', park: '#D9DDBF', roof: '#F6EFDF', roofEdge: '#B3A27E', shadow: '#5A4630', label: '#4A3A26', halo: '#F6EFDF', streetLabel: '#6E5B41', waterLabel: '#566E61', parkLabel: '#5F6B3A' },
    placeFont: 'Montserrat SemiBold', streetFont: 'Cardo Regular', waterFont: 'Cardo Italic',
    placeCase: 'uppercase', placeSpacing: 0.08, placeSize: 0.92, shadowOpacity: 0.26, shadowOffset: 2.5,
  }),
  riso: theme('Risograph', 'Two-ink print: pink kerbs, teal water, a slightly off-register teal shadow.', {
    colors: { land: '#F4EDE8', street: '#FFFFFF', edge: '#F1B5C0', water: '#A9D6D2', park: '#D3E6CB', roof: '#FFFDFB', roofEdge: '#E8A0B0', shadow: '#2E8C8A', label: '#22577A', halo: '#FFFDFB', streetLabel: '#4F6D7A', waterLabel: '#1F6F6B', parkLabel: '#3E7A4F' },
    placeFont: 'Darumadrop One', streetFont: 'Montserrat Medium', waterFont: 'Cardo Italic',
    placeSize: 1.1, shadowOpacity: 0.32, shadowOffset: 3,
  }),
  mono: theme('Quiet Monochrome', 'Almost no colour at all, so all seven pipe colours pop.', {
    colors: { land: '#E2E2E0', street: '#F7F7F5', edge: '#CACAC6', water: '#CFD5D9', park: '#D8DDD6', roof: '#EFEFEC', roofEdge: '#CFCFCA', label: '#4A4A48', halo: '#EFEFEC', streetLabel: '#7A7A76', waterLabel: '#6F7A80', parkLabel: '#6C7568' },
    placeFont: 'Montserrat Medium', streetFont: 'Open Sans Regular', waterFont: 'Open Sans Italic',
    shadowOpacity: 0.18, shadowOffset: 2,
  }),
  cyanotype: theme('Cyanotype', 'Pale blueprint: blue-grey ground, navy capitals, crisp outlined blocks.', {
    colors: { land: '#D9E3EA', street: '#F3F7FA', edge: '#A9BDCC', water: '#A7BFD0', park: '#C9DACF', roof: '#EEF3F6', roofEdge: '#7F9AB0', shadow: '#1E3A52', label: '#1E3A52', halo: '#EEF3F6', streetLabel: '#43627A', waterLabel: '#2D4F69', parkLabel: '#3F6650' },
    placeFont: 'Montserrat SemiBold', streetFont: 'Montserrat Regular', waterFont: 'Montserrat Regular Italic',
    placeCase: 'uppercase', placeSpacing: 0.1, placeSize: 0.92, shadowOpacity: 0.22, shadowOffset: 2,
  }),
  charcoal: theme('Masthead Charcoal', 'Night map in the masthead’s charcoal; the pins glow on it.', {
    colors: { land: '#232220', street: '#3A3835', edge: '#1A1918', water: '#2A3D48', park: '#2C3A30', roof: '#34322F', roofEdge: '#4A4743', shadow: '#000000', label: '#F2EFE8', halo: '#232220', streetLabel: '#B9B4AA', waterLabel: '#8FA9B5', parkLabel: '#9DB394' },
    placeFont: 'Darumadrop One', waterFont: 'Cardo Italic', placeSize: 1.05, shadowOpacity: 0.55, shadowOffset: 3,
  }),
  positron: { ...theme('Original Positron', 'CARTO’s map as it comes, for comparison.', {}), original: true },
});
export const DEFAULT_PRESET = 'editorial';

/** A full config from a preset name plus any overrides (what the Style Lab's "Copy config" gives you). */
export function resolveTheme(input = {}) {
  const base = PRESETS[input.preset] || PRESETS[DEFAULT_PRESET];
  const preset = PRESETS[input.preset] ? input.preset : DEFAULT_PRESET;
  const out = { ...base, ...input, preset, colors: { ...base.colors, ...input.colors }, labels: { ...base.labels, ...input.labels } };
  delete out.name; delete out.blurb;
  return out;
}

// ---------------------------------------------------------------- helpers
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Mixes two #RRGGBB colours (t = share of b). */
export function mix(a, b, t) {
  const A = hex(a); const B = hex(b);
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Multiplies a size or width, whether it's a number, legacy {stops}, or an interpolate/step on zoom. */
export function scaleZoomValue(v, k) {
  if (k === 1 || v == null) return v;
  if (typeof v === 'number') return +(v * k).toFixed(3);
  if (Array.isArray(v?.stops)) return { ...v, stops: v.stops.map(([z, x]) => [z, typeof x === 'number' ? +(x * k).toFixed(3) : x]) };
  if (Array.isArray(v) && v[0] === 'interpolate' && Array.isArray(v[2]) && v[2][0] === 'zoom') {
    return v.map((x, i) => (i > 3 && i % 2 === 0 && typeof x === 'number' ? +(x * k).toFixed(3) : x));
  }
  if (Array.isArray(v) && v[0] === 'step' && Array.isArray(v[1]) && v[1][0] === 'zoom') {
    return v.map((x, i) => (i >= 2 && i % 2 === 0 && typeof x === 'number' ? +(x * k).toFixed(3) : x));
  }
  return v;
}

// Layers that only add noise at pipe-hunting zooms: dotted boundaries and paths, dashed rail, roads that
// run underground (they'd cut across parks and rivers), runways, circle-dot city icons, house numbers.
const HIDDEN = /^(boundary_|rail|tunnel_|aeroway|road_path|bridge_path|place_city_dot|place_capital_dot)/;
const HIDDEN_IDS = new Set(['landuse_residential', 'poi_stadium', 'housenumber']);

// Positron draws minor-road casings from z13 but their white fill only from z15, so at the Portal's
// opening zoom (14.5) every cross street was a bare grey line. These keep fill and casing together.
const ROAD_GEOMETRY = {
  road_minor_case: { minzoom: 13, width: { stops: [[13, 2.4], [14, 3.8], [15, 5.6], [16, 8], [17, 12], [18, 16]] } },
  bridge_minor_case: { minzoom: 13, width: { stops: [[13, 2.4], [14, 3.8], [15, 5.6], [16, 8], [17, 12], [18, 16]] } },
  road_minor_fill: { minzoom: 13, width: { stops: [[13, 1.3], [14, 2.2], [15, 3.8], [16, 5.8], [17, 9.5], [18, 13.5]] } },
  bridge_minor_fill: { minzoom: 13, width: { stops: [[13, 1.3], [14, 2.2], [15, 3.8], [16, 5.8], [17, 9.5], [18, 13.5]] } },
  road_service_case: { minzoom: 15, width: { stops: [[15, 2.6], [16, 3.8], [17, 5.8], [18, 8]] } },
  bridge_service_case: { minzoom: 15, width: { stops: [[15, 2.6], [16, 3.8], [17, 5.8], [18, 8]] } },
  road_service_fill: { minzoom: 15, width: { stops: [[15, 1.4], [16, 2.2], [17, 4], [18, 6]] } },
  bridge_service_fill: { minzoom: 15, width: { stops: [[15, 1.4], [16, 2.2], [17, 4], [18, 6]] } },
  road_sec_case_noramp: { minzoom: 13 },
  bridge_sec_case: { minzoom: 13 },
};

const PLACE_SIZES = {
  place_hamlet: { stops: [[13.5, 11.5], [15, 13], [17, 14.5]] },
  place_suburbs: { stops: [[12, 12.5], [14, 14.5], [16, 17]] },
  place_suburb: { stops: [[12, 12.5], [14, 14.5], [16, 17]] },
  poi_park: { stops: [[14, 11], [16, 13], [18, 14.5]] },
};
const MINOR_STREET_SIZE = { stops: [[15, 10.5], [16, 11.5], [18, 13]] };
const MAIN_STREET_SIZE = { stops: [[13, 11], [15, 12], [17, 13.5]] };
const WATER_SIZE = { stops: [[10, 11], [14, 13], [16, 15]] };

const hide = (l) => { l.layout = { ...l.layout, visibility: 'none' }; };
const show = (l, on) => { l.layout = { ...l.layout, visibility: on ? 'visible' : 'none' }; };

function label(l, { font, color, halo, haloWidth, blur, transform, spacing, size }) {
  l.layout = { ...l.layout, 'text-transform': transform, 'text-letter-spacing': spacing, 'text-size': size };
  if (font) l.layout['text-font'] = [font];
  l.paint = { ...l.paint, 'text-color': color, 'text-halo-color': halo, 'text-halo-width': haloWidth, 'text-halo-blur': blur };
}

/**
 * @param {object} raw  the Positron style JSON, untouched
 * @param {object} cfg  a resolveTheme() config
 */
export function zineStyle(raw, cfg = resolveTheme()) {
  const s = structuredClone(raw);
  if (cfg.original) return s;
  const c = cfg.colors;
  for (const l of s.layers) {
    const id = l.id;
    l.paint = { ...l.paint };
    if (HIDDEN.test(id) || HIDDEN_IDS.has(id)) { hide(l); continue; }
    if (l.type === 'line' && l.paint['line-dasharray']) { hide(l); continue; } // nothing dotted or dashed, ever

    const geo = ROAD_GEOMETRY[id];
    if (geo?.minzoom != null) l.minzoom = geo.minzoom;
    if (geo?.width) l.paint['line-width'] = geo.width;

    if (l.type === 'background') l.paint['background-color'] = c.land;
    else if (id === 'water_shadow' && l.type === 'fill') {
      Object.assign(l.paint, { 'fill-color': mix(c.water, c.shadow, 0.28), 'fill-opacity': 1, 'fill-translate': [2, 2], 'fill-translate-anchor': 'viewport' });
    } else if (/^water/.test(id) && l.type === 'fill') Object.assign(l.paint, { 'fill-color': c.water, 'fill-opacity': 1 });
    else if (/^waterway/.test(id) && l.type === 'line') l.paint['line-color'] = c.water;
    else if (/^(park|landcover|landuse)/.test(id) && l.type === 'fill') Object.assign(l.paint, { 'fill-color': c.park, 'fill-opacity': 1 });
    else if (/^(road|bridge)_.*case/.test(id) && l.type === 'line') {
      l.paint['line-color'] = c.edge;
      l.paint['line-width'] = scaleZoomValue(l.paint['line-width'], cfg.streetWidth);
    } else if (/^(road|bridge)_.*fill/.test(id) && l.type === 'line') {
      l.paint['line-color'] = c.street;
      l.paint['line-width'] = scaleZoomValue(l.paint['line-width'], cfg.streetWidth);
    } else if (id === 'building' && l.type === 'fill') {
      // the shadow: the footprint again, nudged bottom-right (like every button's shadow), growing with zoom
      l.minzoom = 13;
      show(l, cfg.buildings && cfg.shadowOpacity > 0);
      delete l.paint['fill-outline-color'];
      const o = cfg.shadowOffset;
      Object.assign(l.paint, {
        'fill-color': c.shadow,
        'fill-opacity': { stops: [[13, 0], [13.8, cfg.shadowOpacity * 0.75], [16, cfg.shadowOpacity]] },
        'fill-translate-anchor': 'viewport',
        'fill-translate': { stops: [[13.5, [o * 0.5, o * 0.5]], [16, [o, o]], [18, [o * 1.5, o * 1.5]]] },
      });
    } else if (id === 'building-top' && l.type === 'fill') {
      l.minzoom = 13;
      show(l, cfg.buildings);
      Object.assign(l.paint, {
        'fill-color': c.roof, 'fill-outline-color': cfg.roofOutline ? c.roofEdge : c.roof,
        'fill-opacity': { stops: [[13, 0], [13.8, 1]] }, 'fill-translate': [0, 0],
      });
    } else if (l.type === 'symbol' && /^(place_|poi_park)/.test(id)) {
      const park = id === 'poi_park';
      if (park) l.minzoom = 14;
      show(l, park ? cfg.labels.parks : cfg.labels.places);
      label(l, {
        font: cfg.placeFont, color: park ? c.parkLabel : c.label, halo: c.halo, haloWidth: cfg.haloWidth, blur: 0.5,
        transform: cfg.placeCase, spacing: cfg.placeSpacing,
        size: scaleZoomValue(PLACE_SIZES[id] || l.layout?.['text-size'] || 12, cfg.placeSize),
      });
    } else if (l.type === 'symbol' && /^roadname_/.test(id)) {
      if (id === 'roadname_minor') l.minzoom = 15;
      show(l, cfg.labels.streets);
      label(l, {
        font: cfg.streetFont, color: c.streetLabel, halo: c.street, haloWidth: cfg.haloWidth, blur: 0.4,
        transform: 'none', spacing: 0.01,
        size: scaleZoomValue(id === 'roadname_minor' ? MINOR_STREET_SIZE : MAIN_STREET_SIZE, cfg.streetSize),
      });
    } else if (l.type === 'symbol' && /^(watername_|waterway_label)/.test(id)) {
      show(l, cfg.labels.water);
      label(l, {
        font: cfg.waterFont, color: c.waterLabel, halo: c.water, haloWidth: cfg.haloWidth, blur: 0.4,
        transform: 'none', spacing: 0.03, size: scaleZoomValue(WATER_SIZE, cfg.placeSize),
      });
    }
  }
  // Shadows print under what casts them: the water's shadow under the water, the buildings' under the roofs.
  const before = (a, b) => {
    const i = s.layers.findIndex((l) => l.id === a); const j = s.layers.findIndex((l) => l.id === b);
    if (i > j && j >= 0) s.layers.splice(j, 0, s.layers.splice(i, 1)[0]);
  };
  before('water_shadow', 'water');
  before('building', 'building-top');
  return s;
}
