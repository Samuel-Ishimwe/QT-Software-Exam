// Back-office editor: parcel subdivision (Task 3) and single-parcel boundary
// edit (bonus (c)). A separate app from the public viewer in ../web -- it
// writes legal-record transactions, so it ships in its own container and can
// be put behind its own auth/network boundary without touching the public map.
//
// Coordinates: the API speaks EPSG:32736 (UTM 36S) in both directions; the
// basemap view is Web Mercator. Geometry that goes TO the server is always
// held in (or projected back to) the data SRS -- subdivision cuts are computed
// there so the children tile the parent exactly, and a boundary edit is
// projected back from the sketch. Nothing here reprojects on the server.
//
// The nested require() and plain-callback-around-async-IIFE below are the same
// AMD-loader workaround documented at the top of ../web/app.js:
// esri/geometry/projection deadlocks if it's required in the same batch as
// MapView, and an `async` require callback is never unwrapped.

const API_BASE = `${location.protocol}//${location.hostname}:3000`;
const DATA_SRID = 32736;
const OFFICER_KEY = 'officer-ui.officer-id';

const $ = (id) => document.getElementById(id);

function fatal(message) {
  $('status').textContent = message;
  console.error(message);
}

// Small DOM builder. Everything that comes back from the API (UPIs, messages)
// goes in via textContent, never innerHTML.
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path, init) {
  const res = await fetch(`${API_BASE}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const err = new Error(
      body && body.message ? (Array.isArray(body.message) ? body.message.join('; ') : body.message) : `HTTP ${res.status}`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function postJson(path, payload) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

const fmtArea = (m2) => `${m2.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} m²`;

function caseRef(prefix) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const CHILD_COLORS = [
  [31, 119, 180], [255, 127, 14], [44, 160, 44], [148, 103, 189],
  [140, 86, 75], [227, 119, 194], [23, 190, 207], [188, 189, 34],
];

require([
  'esri/Map',
  'esri/views/MapView',
  'esri/layers/GraphicsLayer',
  'esri/Graphic',
  'esri/geometry/SpatialReference',
  'esri/geometry/Extent',
  'esri/geometry/Polygon',
  'esri/geometry/geometryEngine',
  'esri/widgets/Sketch/SketchViewModel',
  'esri/layers/support/TileInfo',
], (Map, MapView, GraphicsLayer, Graphic, SpatialReference, Extent, Polygon, geometryEngine, SketchViewModel, TileInfo) => {
  setTimeout(() => {
    require(['esri/geometry/projection'], (projection) => {
      (async () => {
        try {
          await projection.load();
          start({ Map, MapView, GraphicsLayer, Graphic, SpatialReference, Extent, Polygon, geometryEngine, SketchViewModel, TileInfo, projection });
        } catch (err) {
          fatal('setup error: ' + (err.stack || err.message));
        }
      })();
    }, (err) => fatal('failed to load esri/geometry/projection: ' + (err && err.message)));
  }, 0);
}, (err) => fatal('failed to load core esri modules: ' + (err && err.message)));

function start({ Map, MapView, GraphicsLayer, Graphic, SpatialReference, Extent, Polygon, geometryEngine, SketchViewModel, TileInfo, projection }) {
  const dataSr = new SpatialReference({ wkid: DATA_SRID });

  const parcelsLayer = new GraphicsLayer(); // ACTIVE parcels in the viewport
  const selectedLayer = new GraphicsLayer(); // outline of the parcel being worked on
  const previewLayer = new GraphicsLayer(); // subdivision children
  const ghostLayer = new GraphicsLayer(); // registered boundary while editing
  const editLayer = new GraphicsLayer(); // the editable draft boundary
  const cutLayer = new GraphicsLayer(); // cut-line sketch
  const map = new Map({
    basemap: 'osm',
    layers: [parcelsLayer, selectedLayer, previewLayer, ghostLayer, editLayer, cutLayer],
  });

  const view = new MapView({
    container: 'viewDiv',
    map,
    // Parcels are tens of metres across, but the OSM basemap stops at ~0.3 m/px
    // (a 40 m parcel is ~130 px wide) -- too coarse to place vertices or cut
    // lines precisely. Extra LODs let the view zoom past the last tile level
    // (the basemap just over-scales); parcel graphics stay crisp vector.
    constraints: { lods: TileInfo.create({ numLODs: 24 }).lods, snapToZoom: false },
    extent: projection.project(
      new Extent({ xmin: 500000, ymin: 9780000, xmax: 500800, ymax: 9780600, spatialReference: dataSr }),
      SpatialReference.WebMercator,
    ),
  });

  const fillSymbol = { type: 'simple-fill', color: [227, 139, 79, 0.3], outline: { color: [120, 60, 0, 0.8], width: 0.6 } };
  const selectedSymbol = { type: 'simple-fill', color: [0, 0, 0, 0], outline: { color: [220, 30, 30, 1], width: 2.5 } };
  const ghostSymbol = { type: 'simple-fill', color: [0, 0, 0, 0], outline: { color: [60, 60, 60, 1], width: 1.5, style: 'dash' } };
  const editSymbol = { type: 'simple-fill', color: [31, 78, 140, 0.25], outline: { color: [31, 78, 140, 1], width: 2.5 } };
  const cutSymbol = { type: 'simple-line', color: [200, 0, 0, 1], width: 2.5, style: 'dash' };

  const toViewGeometry = (geojsonGeometry) =>
    projection.project(new Polygon({ rings: geojsonGeometry.coordinates, spatialReference: dataSr }), view.spatialReference);
  const toDataGeometry = (viewGeometry) => projection.project(viewGeometry, dataSr);
  const planarArea = (dataPolygon) => Math.abs(geometryEngine.planarArea(dataPolygon, 'square-meters'));

  function currentBboxParam() {
    const e = projection.project(view.extent, dataSr);
    return `${e.xmin.toFixed(2)},${e.ymin.toFixed(2)},${e.xmax.toFixed(2)},${e.ymax.toFixed(2)}`;
  }

  // ---------------------------------------------------------------------
  // Shared state: what's selected, and which editing session (if any) is live.
  // ---------------------------------------------------------------------
  let selected = null; // { feature } from GET /parcels/{upi}
  let session = null; // null | 'split' | 'edit' -- while set, map clicks don't change the selection
  let config = {};

  const officerInput = $('officerId');
  try {
    officerInput.value = localStorage.getItem(OFFICER_KEY) || '';
  } catch {
    /* storage blocked -- field just starts empty */
  }
  officerInput.addEventListener('input', () => {
    try {
      localStorage.setItem(OFFICER_KEY, officerInput.value);
    } catch {
      /* ignore */
    }
  });

  function officerId() {
    const v = officerInput.value.trim();
    if (!v) {
      officerInput.focus();
      setStatus('enter your officer id first');
    }
    return v;
  }

  const setStatus = (t) => {
    $('status').textContent = t;
  };

  // ---------------------------------------------------------------------
  // Viewport loading (officer endpoint -- no holder identity in the payload;
  // full detail, including holders, is fetched per parcel on selection).
  // ---------------------------------------------------------------------
  async function loadViewport() {
    if (!view.extent) return;
    const bbox = currentBboxParam();
    try {
      const fc = await api(`/parcels?bbox=${bbox}`);
      parcelsLayer.removeAll();
      parcelsLayer.addMany(
        fc.features.map((f) => new Graphic({ geometry: toViewGeometry(f.geometry), symbol: fillSymbol, attributes: f.properties })),
      );
      if (!session) setStatus(`${fc.features.length} active parcel(s) in view`);
    } catch (err) {
      setStatus(`error loading parcels: ${err.message}`);
    }
  }

  view.when(
    () => {
      loadViewport();
      view.watch('stationary', (s) => {
        if (s) loadViewport();
      });
    },
    (err) => fatal('view failed to load: ' + (err.stack || err.message)),
  );

  api('/admin/config')
    .then((rows) => {
      config = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    })
    .catch(() => {
      /* advisory only -- the server re-validates every rule */
    });

  // ---------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------
  async function selectUpi(upi, { zoom } = {}) {
    try {
      const feature = await api(`/parcels/${encodeURIComponent(upi)}`);
      selected = { feature };
      const g = toViewGeometry(feature.geometry);
      selectedLayer.removeAll();
      selectedLayer.add(new Graphic({ geometry: g, symbol: selectedSymbol }));
      renderParcelCard();
      if (zoom) view.goTo({ target: g.extent.expand(2) });
      return feature;
    } catch (err) {
      selected = null;
      selectedLayer.removeAll();
      $('parcelCard').replaceChildren(h('div', { class: 'msg err' }, `${upi}: ${err.message}`));
      syncButtons();
      return null;
    }
  }

  function renderParcelCard() {
    const p = selected.feature.properties;
    const holders = (p.holders || []).map((x) => `${x.party_name} (${x.right_type})`).join(', ') || '—';
    $('parcelCard').replaceChildren(
      h(
        'dl',
        { class: 'kv', style: 'margin-top:6px' },
        h('dt', {}, 'UPI'), h('dd', {}, p.upi),
        h('dt', {}, 'Status'), h('dd', {}, p.status),
        h('dt', {}, 'Area'), h('dd', {}, fmtArea(p.area_computed)),
        h('dt', {}, 'Land use'), h('dd', {}, p.land_use || '—'),
        h('dt', {}, 'Version'), h('dd', {}, String(p.version)),
        h('dt', {}, 'Holders'), h('dd', {}, holders),
      ),
    );
    syncButtons();
  }

  view.on('click', async (evt) => {
    if (session) return;
    const hit = await view.hitTest(evt, { include: parcelsLayer });
    if (!hit.results.length) return;
    await selectUpi(hit.results[0].graphic.attributes.upi);
  });

  $('searchBtn').addEventListener('click', async () => {
    if (session) return;
    const upi = $('upiInput').value.trim();
    if (upi) await selectUpi(upi, { zoom: true });
  });
  $('upiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('searchBtn').click();
  });

  function syncButtons() {
    const canStart = !!selected && selected.feature.properties.status === 'ACTIVE' && !session;
    $('splitStart').disabled = !canStart;
    $('editStart').disabled = !canStart;
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  function showTab(name) {
    if (session && session !== name) {
      if (!confirm('Discard the work in progress?')) return;
      cancelSession();
    }
    $('tabSplit').classList.toggle('active', name === 'split');
    $('tabEdit').classList.toggle('active', name === 'edit');
    $('paneSplit').classList.toggle('active', name === 'split');
    $('paneEdit').classList.toggle('active', name === 'edit');
  }
  $('tabSplit').addEventListener('click', () => showTab('split'));
  $('tabEdit').addEventListener('click', () => showTab('edit'));

  function cancelSession() {
    if (session === 'split') cancelSplit();
    if (session === 'edit') cancelEdit();
  }

  // Renders a server rejection (422 subdivision_rejected / 409 boundary_edit_conflict).
  function violationsBox(err, headline) {
    const violations = err.body && Array.isArray(err.body.violations) ? err.body.violations : null;
    if (!violations) return h('div', { class: 'msg err' }, err.message);
    return h(
      'div',
      { class: 'msg err' },
      h('strong', {}, headline),
      ' Nothing was written.',
      h(
        'ul',
        {},
        violations.map((v) =>
          h(
            'li',
            {},
            h('span', { class: 'rule' }, v.rule),
            v.child_index !== undefined ? h('strong', {}, `piece ${v.child_index + 1}: `) : null,
            v.message,
            v.measured !== undefined
              ? h('span', { class: 'measure' }, `measured ${v.measured}${v.unit ? ' ' + v.unit : ''}` +
                  (v.threshold !== undefined ? ` · limit ${v.threshold}${v.unit ? ' ' + v.unit : ''}` : ''))
              : null,
          ),
        ),
      ),
    );
  }

  // =====================================================================
  // SUBDIVISION
  // =====================================================================
  let split = null; // { parent: {upi, area}, children: Polygon[] (data SRS), undo: Polygon[][], violations: [] }

  const cutSketch = new SketchViewModel({
    view,
    layer: cutLayer,
    polylineSymbol: cutSymbol,
    snappingOptions: { enabled: true, selfEnabled: true, featureEnabled: true, featureSources: [{ layer: parcelsLayer, enabled: true }] },
  });

  $('splitStart').addEventListener('click', () => {
    if (!selected) return;
    const p = selected.feature.properties;
    const parent = new Polygon({ rings: selected.feature.geometry.coordinates, spatialReference: dataSr });
    $('splitResult').replaceChildren();
    if (parent.rings.length !== 1) {
      $('splitResult').replaceChildren(
        h('div', { class: 'msg warn' }, 'This parcel has holes or several parts; the cut tool only handles single-ring parcels.'),
      );
      return;
    }
    session = 'split';
    split = { parent: { upi: p.upi, area: p.area_computed }, children: [parent], undo: [], violations: [] };
    $('splitCase').value = caseRef('SUB');
    $('splitStartBtns').style.display = 'none';
    $('splitWork').style.display = 'block';
    syncButtons();
    renderSplit();
    setStatus(`subdividing ${p.upi} -- draw a cut line across it`);
  });

  $('drawCut').addEventListener('click', () => {
    cutLayer.removeAll();
    cutSketch.create('polyline');
    setStatus('click to start the cut line, double-click to finish. It must fully cross the parcel.');
  });

  cutSketch.on('create', (evt) => {
    if (evt.state !== 'complete') return;
    const line = toDataGeometry(evt.graphic.geometry);
    cutLayer.removeAll();
    applyCut(line);
  });

  function applyCut(line) {
    const next = [];
    let cutAny = false;
    let multipart = false;
    for (const child of split.children) {
      if (!geometryEngine.intersects(child, line)) {
        next.push(child);
        continue;
      }
      const parts = geometryEngine.cut(child, line);
      if (!parts || parts.length < 2) {
        next.push(child);
        continue;
      }
      if (parts.some((p) => p.rings.length !== 1)) {
        multipart = true;
        next.push(child);
        continue;
      }
      next.push(...parts);
      cutAny = true;
    }
    if (multipart) {
      setStatus('that cut would produce a multi-part piece -- redraw it so each side is one contiguous area');
    } else if (!cutAny) {
      setStatus('that line did not split anything -- it must fully cross the parcel, from outside to outside');
    } else {
      split.undo.push(split.children);
      split.children = next;
      split.violations = [];
      $('splitResult').replaceChildren();
      setStatus(`${next.length} pieces`);
    }
    renderSplit();
  }

  $('undoCut').addEventListener('click', () => {
    if (!split || !split.undo.length) return;
    split.children = split.undo.pop();
    split.violations = [];
    $('splitResult').replaceChildren();
    renderSplit();
  });

  function renderSplit() {
    previewLayer.removeAll();
    const minPlot = config['subdivision.min_plot_size_m2'];
    const badIdx = new Set((split.violations || []).filter((v) => v.child_index !== undefined).map((v) => v.child_index));
    let sum = 0;

    const items = split.children.map((child, i) => {
      const area = planarArea(child);
      sum += area;
      const color = CHILD_COLORS[i % CHILD_COLORS.length];
      const bad = badIdx.has(i);
      const small = minPlot !== undefined && area < minPlot;
      const vg = toViewGeometry({ coordinates: child.rings });
      previewLayer.add(
        new Graphic({
          geometry: vg,
          symbol: { type: 'simple-fill', color: [...color, 0.4], outline: { color: bad ? [220, 30, 30, 1] : [...color, 1], width: bad ? 3 : 1.5 } },
        }),
      );
      previewLayer.add(
        new Graphic({
          geometry: vg.centroid,
          symbol: { type: 'text', text: String(i + 1), color: [20, 20, 20, 1], haloColor: [255, 255, 255, 1], haloSize: 2, font: { size: 14, weight: 'bold' } },
        }),
      );
      return h(
        'li',
        { class: 'child' + (bad ? ' bad' : small ? ' warn' : '') },
        h('span', { class: 'swatch', style: `background:rgb(${color.join(',')})` }),
        h('strong', {}, `Piece ${i + 1}`),
        small ? h('span', { title: `below the ${minPlot} m² minimum plot size` }, '⚠ too small') : null,
        h('span', { class: 'area' }, fmtArea(area)),
      );
    });

    $('childList').replaceChildren(...items);
    const parentArea = split.parent.area;
    const diff = sum - parentArea;
    $('splitTotals').textContent =
      `${split.children.length} piece(s) · total ${fmtArea(sum)} vs parent ${fmtArea(parentArea)} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} m²)`;
    $('undoCut').disabled = !split.undo.length;
    $('submitSplit').disabled = split.children.length < 2;
  }

  $('cancelSplit').addEventListener('click', cancelSplit);

  function cancelSplit() {
    clearSplitSession();
    setStatus('cancelled');
  }

  $('submitSplit').addEventListener('click', async () => {
    const officer = officerId();
    const caseReference = $('splitCase').value.trim();
    if (!officer) return;
    if (!caseReference) {
      $('splitCase').focus();
      return;
    }
    cutSketch.cancel();
    $('submitSplit').disabled = true;
    setStatus('submitting subdivision...');
    try {
      const out = await postJson('/cases/subdivision', {
        parent_upi: split.parent.upi,
        case_reference: caseReference,
        officer_id: officer,
        child_geometries: split.children.map((c) => ({ type: 'Polygon', coordinates: c.rings })),
      });
      finishSplitSuccess(out);
    } catch (err) {
      split.violations = (err.body && err.body.violations) || [];
      $('splitResult').replaceChildren(violationsBox(err, 'Subdivision rejected.'));
      renderSplit();
      $('submitSplit').disabled = split.children.length < 2;
      setStatus(`rejected (HTTP ${err.status || '?'})`);
    }
  });

  function finishSplitSuccess(out) {
    clearSplitSession();
    $('splitResult').replaceChildren(
      h(
        'div',
        { class: 'msg ok' },
        h('strong', {}, `Subdivision ${out.case_reference} committed.`),
        ` ${out.parent_upi} is now ${out.parent_status}. New parcels: `,
        out.children.flatMap((u, i) => [i ? ', ' : '', h('a', { class: 'upi', onclick: () => selectUpi(u, { zoom: true }) }, u)]),
      ),
    );
    selected = null;
    selectedLayer.removeAll();
    $('parcelCard').replaceChildren();
    syncButtons();
    loadViewport();
    setStatus('subdivision committed');
  }

  function clearSplitSession() {
    cutSketch.cancel();
    cutLayer.removeAll();
    previewLayer.removeAll();
    split = null;
    session = null;
    $('splitWork').style.display = 'none';
    $('splitStartBtns').style.display = '';
    syncButtons();
  }

  // =====================================================================
  // BOUNDARY EDIT
  // =====================================================================
  let edit = null; // { upi, version, original: GeoJSON geometry, area, graphic }

  const editSketch = new SketchViewModel({
    view,
    layer: editLayer,
    polygonSymbol: editSymbol,
    defaultUpdateOptions: { tool: 'reshape', toggleToolOnClick: false },
    snappingOptions: { enabled: true, selfEnabled: true, featureEnabled: true, featureSources: [{ layer: parcelsLayer, enabled: true }] },
  });

  $('editStart').addEventListener('click', async () => {
    if (!selected) return;
    $('editResult').replaceChildren();
    // Re-read fresh: the version token must be the one the officer is drafting against.
    const feature = await selectUpi(selected.feature.properties.upi);
    if (!feature) return;
    beginEdit(feature);
  });

  function beginEdit(feature) {
    const p = feature.properties;
    editSketch.cancel();
    editLayer.removeAll();
    ghostLayer.removeAll();
    session = 'edit';
    const graphic = new Graphic({ geometry: toViewGeometry(feature.geometry), symbol: editSymbol });
    editLayer.add(graphic);
    ghostLayer.add(new Graphic({ geometry: toViewGeometry(feature.geometry), symbol: ghostSymbol }));
    edit = { upi: p.upi, version: p.version, original: feature.geometry, area: p.area_computed, graphic };
    $('editCase').value = caseRef('EDIT');
    $('editWork').style.display = 'block';
    $('editStart').style.display = 'none';
    syncButtons();
    editSketch.update(graphic);
    renderEditInfo();
    setStatus(`editing ${p.upi} (version ${p.version})`);
  }

  editSketch.on('update', () => {
    if (edit) renderEditInfo();
  });

  function currentDraftGeometry() {
    return toDataGeometry(edit.graphic.geometry);
  }

  function renderEditInfo() {
    const area = planarArea(currentDraftGeometry());
    const diff = area - edit.area;
    $('editInfo').replaceChildren(
      h('dt', {}, 'UPI'), h('dd', {}, edit.upi),
      h('dt', {}, 'Base version'), h('dd', {}, String(edit.version)),
      h('dt', {}, 'Area now'), h('dd', {}, fmtArea(edit.area)),
      h('dt', {}, 'Area after'), h('dd', {}, `${fmtArea(area)} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} m²)`),
    );
  }

  $('resetEdit').addEventListener('click', () => {
    if (!edit) return;
    beginEdit({ properties: { upi: edit.upi, version: edit.version, area_computed: edit.area }, geometry: edit.original });
  });

  $('cancelEdit').addEventListener('click', cancelEdit);

  function clearEditSession() {
    editSketch.cancel();
    editLayer.removeAll();
    ghostLayer.removeAll();
    edit = null;
    session = null;
    $('editWork').style.display = 'none';
    $('editStart').style.display = '';
    syncButtons();
  }

  function cancelEdit() {
    clearEditSession();
    setStatus('cancelled');
  }

  $('submitEdit').addEventListener('click', async () => {
    const officer = officerId();
    const caseReference = $('editCase').value.trim();
    if (!officer) return;
    if (!caseReference) {
      $('editCase').focus();
      return;
    }
    const draft = currentDraftGeometry();
    $('submitEdit').disabled = true;
    setStatus('submitting edit...');
    try {
      const out = await postJson('/cases/boundary-edit', {
        upi: edit.upi,
        case_reference: caseReference,
        officer_id: officer,
        base_version: edit.version,
        new_geometry: { type: 'Polygon', coordinates: draft.rings },
      });
      const upi = edit.upi;
      clearEditSession();
      $('editResult').replaceChildren(
        h(
          'div',
          { class: 'msg ok' },
          h('strong', {}, `Edit ${out.case_reference} committed.`),
          ` ${upi} is now at version ${out.version}, ${fmtArea(out.area_computed)}.`,
        ),
      );
      loadViewport();
      await selectUpi(upi);
      setStatus('edit committed');
    } catch (err) {
      const stale = err.body && Array.isArray(err.body.violations) && err.body.violations.some((v) => v.rule === 'stale_version');
      const box = violationsBox(err, 'Edit rejected.');
      // The draft stays on the map untouched; the officer chooses whether to
      // adjust it or throw it away and redraft against the latest state.
      box.append(
        h(
          'div',
          { class: 'btns' },
          h('button', { onclick: reloadLatest }, stale ? 'Reload latest version (discards draft)' : 'Reload latest state (discards draft)'),
        ),
      );
      $('editResult').replaceChildren(box);
      setStatus(`rejected (HTTP ${err.status || '?'}) -- your draft is still on the map`);
    } finally {
      $('submitEdit').disabled = false;
    }
  });

  async function reloadLatest() {
    if (!edit) return;
    const upi = edit.upi;
    const feature = await selectUpi(upi);
    if (feature) {
      $('editResult').replaceChildren();
      beginEdit(feature);
      loadViewport();
    }
  }
}
