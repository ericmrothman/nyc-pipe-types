// The Style Lab: a collapsible panel on the map for trying basemap themes live against real tiles.
// Shown only with ?lab (or ?dev) in the URL, so readers never see it. Choices are remembered in this
// browser only; "Copy config" gives the JSON to paste into MAP_THEME in map.js to make it the default.

import { PRESETS, MAP_FONTS, resolveTheme } from './map_theme.js';

const STORE = 'pipeAtlas.styleLab.v1';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const labRequested = () => /[?&](lab|dev)(=|&|$)/.test(location.search);

/** The theme saved by an earlier Style Lab session in this browser, or null. */
export function loadLabTheme() {
  try { const raw = localStorage.getItem(STORE); return raw ? resolveTheme(JSON.parse(raw)) : null; } catch { return null; }
}
function saveLabTheme(cfg) {
  try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch { /* private window: fine, it just won't stick */ }
}

/** Only what differs from the chosen preset, so the pasted config stays short and readable. */
export function configDiff(cfg) {
  const base = resolveTheme({ preset: cfg.preset });
  const out = { preset: cfg.preset };
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'preset' || k === 'original') continue;
    if (k === 'colors' || k === 'labels') {
      const changed = Object.fromEntries(Object.entries(v).filter(([kk, vv]) => base[k][kk] !== vv));
      if (Object.keys(changed).length) out[k] = changed;
    } else if (JSON.stringify(base[k]) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

const COLOR_FIELDS = [
  ['land', 'Land'], ['street', 'Streets'], ['edge', 'Kerbs'], ['water', 'Water'], ['park', 'Parks'],
  ['roof', 'Roofs'], ['roofEdge', 'Roof edge'], ['shadow', 'Shadow'], ['label', 'Place labels'],
  ['streetLabel', 'Street labels'], ['waterLabel', 'Water labels'], ['parkLabel', 'Park labels'], ['halo', 'Label halo'],
];
const SLIDERS = {
  placeSize: { label: 'Place text size', min: 0.6, max: 1.8, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  streetSize: { label: 'Street text size', min: 0.6, max: 1.8, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  placeSpacing: { label: 'Place letter spacing', min: 0, max: 0.3, step: 0.01, fmt: (v) => `${v.toFixed(2)} em` },
  haloWidth: { label: 'Label halo', min: 0, max: 4, step: 0.25, fmt: (v) => `${v} px` },
  streetWidth: { label: 'Street width', min: 0.5, max: 1.8, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  shadowOpacity: { label: 'Shadow strength', min: 0, max: 0.7, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  shadowOffset: { label: 'Shadow offset', min: 0, max: 8, step: 0.5, fmt: (v) => `${v} px` },
  fillOffset: { label: 'Fill misses its lines by', min: 0, max: 6, step: 0.5, fmt: (v) => `${v} px` },
};

const slider = (k) => {
  const s = SLIDERS[k];
  return `<label class="lab-range"><span>${s.label}</span><output data-out="${k}"></output>
    <input type="range" data-k="${k}" min="${s.min}" max="${s.max}" step="${s.step}"></label>`;
};
const fontSelect = (k, label) => `<label class="lab-field"><span>${label}</span><select data-k="${k}">
  ${MAP_FONTS.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select></label>`;
const check = (k, label) => `<label class="lab-check"><input type="checkbox" data-k="${k}"><span>${label}</span></label>`;

function panelHtml() {
  const presets = Object.entries(PRESETS).map(([key, p]) => `
    <button type="button" class="lab-preset" data-preset="${key}" aria-pressed="false" title="${esc(p.blurb)}">
      <span class="lab-swatch" aria-hidden="true">${['land', 'street', 'water', 'park', 'roof'].map((c) => `<i style="background:${p.colors[c]}"></i>`).join('')}</span>
      <span>${esc(p.name)}</span>
    </button>`).join('');
  return `
    <div class="lab-head">
      <h2 class="display">Style Lab</h2>
      <button type="button" class="linkish" data-lab="close">Close</button>
    </div>
    <div class="lab-presets" role="group" aria-label="Themes">${presets}</div>
    <p class="lab-blurb" data-blurb></p>
    <fieldset class="lab-group"><legend>Type</legend>
      ${fontSelect('placeFont', 'Neighbourhoods &amp; parks')}
      ${fontSelect('streetFont', 'Streets')}
      ${fontSelect('waterFont', 'Water')}
      <div class="lab-field"><span>Neighbourhood case</span>
        <div class="lab-seg" role="group" aria-label="Neighbourhood case">
          <button type="button" data-case="none" aria-pressed="false">Mixed Case</button>
          <button type="button" data-case="uppercase" aria-pressed="false">CAPITALS</button>
        </div></div>
      ${slider('placeSize')}${slider('streetSize')}${slider('placeSpacing')}${slider('haloWidth')}
    </fieldset>
    <fieldset class="lab-group"><legend>Streets &amp; buildings</legend>
      ${slider('streetWidth')}
      ${check('buildings', 'Show buildings')}
      ${check('roofOutline', 'Outline roofs')}
      ${slider('shadowOpacity')}${slider('shadowOffset')}
    </fieldset>
    <fieldset class="lab-group"><legend>Hand-made</legend>
      ${check('hatch', 'Crayon stripes in water &amp; parks')}
      ${check('wobble', 'Shaky hand (wobbly lines)')}
      ${slider('fillOffset')}
    </fieldset>
    <fieldset class="lab-group"><legend>Labels</legend>
      <div class="lab-checks">${check('labels.places', 'Neighbourhoods')}${check('labels.streets', 'Streets')}${check('labels.parks', 'Parks')}${check('labels.water', 'Water')}</div>
    </fieldset>
    <fieldset class="lab-group"><legend>Colours</legend>
      <div class="lab-colors">${COLOR_FIELDS.map(([k, label]) => `<label class="lab-color"><input type="color" data-k="colors.${k}"><span>${label}</span></label>`).join('')}</div>
    </fieldset>
    <div class="lab-actions">
      <button type="button" class="btn btn-sm" data-lab="copy">Copy config</button>
      <button type="button" class="btn btn-sm btn-ghost" data-lab="reset">Reset theme</button>
    </div>
    <textarea class="lab-config" data-config readonly hidden aria-label="Theme config"></textarea>`;
}

const getPath = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
function setPath(o, path, v) {
  const [a, b] = path.split('.');
  return b ? { ...o, [a]: { ...o[a], [b]: v } } : { ...o, [a]: v };
}

/**
 * @param {{ stage: HTMLElement, getTheme: () => object, setTheme: (cfg: object) => void }} opts
 */
export function mountStyleLab({ stage, getTheme, setTheme }) {
  let cfg = resolveTheme(getTheme());
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-sm style-lab-toggle';
  toggle.dataset.mapObstacle = '';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '🎨 Style Lab';
  const panel = document.createElement('section');
  panel.className = 'style-lab';
  panel.dataset.mapObstacle = '';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Map Style Lab');
  panel.innerHTML = panelHtml();
  stage.append(toggle, panel);

  const sync = () => {
    for (const b of panel.querySelectorAll('[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === cfg.preset));
    panel.querySelector('[data-blurb]').textContent = PRESETS[cfg.preset].blurb;
    for (const b of panel.querySelectorAll('[data-case]')) b.setAttribute('aria-pressed', String(b.dataset.case === cfg.placeCase));
    for (const input of panel.querySelectorAll('[data-k]')) {
      const v = getPath(cfg, input.dataset.k);
      if (input.type === 'checkbox') input.checked = Boolean(v);
      else input.value = String(v);
    }
    for (const out of panel.querySelectorAll('[data-out]')) out.textContent = SLIDERS[out.dataset.out].fmt(cfg[out.dataset.out]);
    // The original style has nothing to adjust: every control would be a lie.
    panel.classList.toggle('is-original', Boolean(cfg.original));
  };

  let frame = 0;
  const apply = () => {
    sync();
    saveLabTheme(cfg);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setTheme(cfg));
  };

  const open = (on) => {
    panel.hidden = !on;
    toggle.hidden = on;
    toggle.setAttribute('aria-expanded', String(on));
    if (on) { sync(); panel.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }); } else toggle.focus({ preventScroll: true });
  };
  toggle.addEventListener('click', () => open(true));

  panel.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const t = e.target;
    const v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value;
    cfg = setPath(cfg, k, v);
    apply();
  });
  panel.addEventListener('click', async (e) => {
    const preset = e.target.closest('[data-preset]')?.dataset.preset;
    if (preset) { cfg = resolveTheme({ preset }); apply(); return; }
    const kase = e.target.closest('[data-case]')?.dataset.case;
    if (kase) { cfg = { ...cfg, placeCase: kase }; apply(); return; }
    const act = e.target.closest('[data-lab]')?.dataset.lab;
    if (act === 'close') open(false);
    if (act === 'reset') { cfg = resolveTheme({ preset: cfg.preset }); apply(); }
    if (act === 'copy') {
      const text = JSON.stringify(configDiff(cfg), null, 2);
      const box = panel.querySelector('[data-config]');
      box.value = text;
      box.hidden = false;
      const btn = e.target.closest('[data-lab]');
      try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied!'; } catch { box.select(); btn.textContent = 'Select & copy below'; }
      setTimeout(() => { btn.textContent = 'Copy config'; }, 1800);
    }
  });
  // Keys typed in the lab stay in the lab: arrows move sliders (not to the next pipe), Escape closes it.
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') open(false);
  });

  return { open, get config() { return cfg; } };
}
