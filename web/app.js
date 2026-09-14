// Function over aesthetics, per the brief: a plain graphics layer rendered
// directly in the data's native SRID (EPSG:32736) -- no basemap tiles, no
// client-side reprojection, no ArcGIS API key required. Parcels are fetched
// by the current viewport (bbox), never the whole layer.

const API_BASE = `${location.protocol}//${location.hostname}:3000`;
const SRID = 32736;

require([
  'esri/Map',
  'esri/views/MapView',
  'esri/layers/GraphicsLayer',
  'esri/Graphic',
  'esri/geometry/SpatialReference',
  'esri/geometry/Extent',
  'esri/geometry/Polygon',
], (Map, MapView, GraphicsLayer, Graphic, SpatialReference, Extent, Polygon) => {
  const sr = new SpatialReference({ wkid: SRID });
  const parcelsLayer = new GraphicsLayer();
  const selectedLayer = new GraphicsLayer();
  const map = new Map({ basemap: null, layers: [parcelsLayer, selectedLayer] });

  const view = new MapView({
    container: 'viewDiv',
    map,
    spatialReference: sr,
    extent: new Extent({ xmin: 500000, ymin: 9780000, xmax: 502400, ymax: 9781500, spatialReference: sr }),
  });

  const statusEl = document.getElementById('status');
  const detailEl = document.getElementById('detail');
  const lineageEl = document.getElementById('lineage');
  const lineageBtn = document.getElementById('lineageBtn');
  const publicToggle = document.getElementById('publicToggle');
  let selectedUpi = null;

  const fillSymbol = {
    type: 'simple-fill',
    color: [227, 139, 79, 0.5],
    outline: { color: [80, 80, 80, 0.9], width: 0.5 },
  };
  const selectedSymbol = {
    type: 'simple-fill',
    color: [0, 0, 0, 0],
    outline: { color: [220, 30, 30, 1], width: 2.5 },
  };

  function geojsonPolygonToEsri(geometry) {
    return new Polygon({ rings: geometry.coordinates, spatialReference: sr });
  }

  async function loadViewport() {
    const e = view.extent;
    if (!e) return;
    const bbox = `${e.xmin.toFixed(2)},${e.ymin.toFixed(2)},${e.xmax.toFixed(2)},${e.ymax.toFixed(2)}`;
    const endpoint = publicToggle.checked ? 'public/parcels' : 'parcels';
    statusEl.textContent = `loading ${endpoint}?bbox=${bbox} ...`;
    try {
      const res = await fetch(`${API_BASE}/${endpoint}?bbox=${bbox}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fc = await res.json();
      parcelsLayer.removeAll();
      const graphics = fc.features.map(
        (f) =>
          new Graphic({
            geometry: geojsonPolygonToEsri(f.geometry),
            symbol: fillSymbol,
            attributes: f.properties,
          }),
      );
      parcelsLayer.addMany(graphics);
      statusEl.textContent = `${graphics.length} parcel(s) in view (${endpoint})`;
    } catch (err) {
      statusEl.textContent = `error loading parcels: ${err.message}`;
    }
  }

  view.when(() => {
    loadViewport();
    view.watch('stationary', (isStationary) => {
      if (isStationary) loadViewport();
    });
  });

  publicToggle.addEventListener('change', loadViewport);

  function renderDetailFromAttributes(props) {
    selectedUpi = props.upi;
    lineageBtn.disabled = false;
    lineageEl.textContent = '';
    detailEl.textContent = JSON.stringify(props, null, 2);
  }

  async function renderDetailFromApi(upi) {
    try {
      const res = await fetch(`${API_BASE}/parcels/${encodeURIComponent(upi)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feature = await res.json();
      selectedUpi = upi;
      lineageBtn.disabled = false;
      lineageEl.textContent = '';
      detailEl.textContent = JSON.stringify(feature.properties, null, 2);
      highlightGeometry(feature.geometry);
      return feature;
    } catch (err) {
      detailEl.textContent = `error: ${err.message}`;
    }
  }

  function highlightGeometry(geometry) {
    selectedLayer.removeAll();
    selectedLayer.add(new Graphic({ geometry: geojsonPolygonToEsri(geometry), symbol: selectedSymbol }));
  }

  view.on('click', async (evt) => {
    const hit = await view.hitTest(evt, { include: parcelsLayer });
    if (!hit.results.length) return;
    const graphic = hit.results[0].graphic;
    highlightGeometry({ type: 'Polygon', coordinates: graphic.geometry.rings });
    if (publicToggle.checked) {
      // Public mode: show only what the public endpoint already returned.
      // Holder identity is never requested, not merely hidden client-side.
      renderDetailFromAttributes(graphic.attributes);
    } else {
      // Internal mode: fetch full detail (includes current holder(s)) by UPI.
      await renderDetailFromApi(graphic.attributes.upi);
    }
  });

  document.getElementById('searchBtn').addEventListener('click', async () => {
    const upi = document.getElementById('upiInput').value.trim();
    if (!upi) return;
    const feature = await renderDetailFromApi(upi);
    if (feature) {
      const g = geojsonPolygonToEsri(feature.geometry);
      view.goTo({ target: g.extent.expand(3) });
    }
  });

  lineageBtn.addEventListener('click', async () => {
    if (!selectedUpi) return;
    lineageEl.textContent = 'loading...';
    try {
      const res = await fetch(`${API_BASE}/parcels/${encodeURIComponent(selectedUpi)}/history`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const history = await res.json();
      const lines = [`upi: ${history.upi} (${history.status})`, '', 'ancestors:'];
      history.ancestors.forEach((a) =>
        lines.push(`  depth ${a.depth}: ${a.parent_upi} --[${a.relation_type} / ${a.case_reference}]--> ${a.child_upi}`),
      );
      if (!history.ancestors.length) lines.push('  (none — this parcel traces back to the legacy load directly)');
      lines.push('', 'descendants:');
      history.descendants.forEach((d) =>
        lines.push(`  depth ${d.depth}: ${d.parent_upi} --[${d.relation_type} / ${d.case_reference}]--> ${d.child_upi} (${d.child_status})`),
      );
      if (!history.descendants.length) lines.push('  (none — this parcel has not been subdivided or merged)');
      lineageEl.textContent = lines.join('\n');
    } catch (err) {
      lineageEl.textContent = `error: ${err.message}`;
    }
  });
});
