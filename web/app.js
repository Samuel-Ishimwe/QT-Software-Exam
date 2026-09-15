// Parcel data is stored in EPSG:32736 (UTM 36S), but a basemap's tiles are
// served in Web Mercator (EPSG:3857) -- the two aren't the same projection,
// so we let the view use the basemap's native spatial reference and
// reproject parcel geometry into it client-side via esri/geometry/projection
// (a same-datum, projected-to-projected conversion the JS API handles
// locally, no geometry service round trip needed). Parcels are still
// fetched by the current viewport (bbox) in the data's own SRID, never the
// whole layer.
//
// esri/geometry/projection is loaded via its own, separate, deferred
// require() call rather than in the same require([...]) batch as
// esri/views/MapView (and friends), and its callback is a PLAIN function
// wrapping an async IIFE rather than an `async` function passed directly to
// require(). Both quirks were forced by this AMD loader (confirmed with a
// minimal standalone repro, independent of this app):
//   1. require()-ing esri/geometry/projection together with MapView (etc.)
//      in one batch deadlocks the loader -- some reentrancy issue between
//      the two modules' own dependency graphs. Fix: a separate, setTimeout
//      (0)-deferred require() call.
//   2. Passing an `async` function directly as a require() callback also
//      deadlocks it: the callback runs, but its returned Promise is never
//      unwrapped, so nothing downstream (success or error) ever fires. Fix:
//      a plain callback that immediately invokes an async IIFE.

const API_BASE = `${location.protocol}//${location.hostname}:3000`;
const DATA_SRID = 32736;

function fatal(message) {
  const el = document.getElementById('status');
  if (el) el.textContent = message;
  console.error(message);
}

require([
  'esri/Map',
  'esri/views/MapView',
  'esri/layers/GraphicsLayer',
  'esri/Graphic',
  'esri/geometry/SpatialReference',
  'esri/geometry/Extent',
  'esri/geometry/Polygon',
], (Map, MapView, GraphicsLayer, Graphic, SpatialReference, Extent, Polygon) => {
  setTimeout(() => {
    require(['esri/geometry/projection'], (projection) => {
      (async () => {
        try {
          await projection.load();

          const dataSr = new SpatialReference({ wkid: DATA_SRID });
          const parcelsLayer = new GraphicsLayer();
          const selectedLayer = new GraphicsLayer();
          const map = new Map({ basemap: 'osm', layers: [parcelsLayer, selectedLayer] });

          // Initial extent is authored in the data's SRID (matches the seed grid),
          // then projected into whatever spatial reference the basemap uses.
          // Kept comfortably under the API's bbox area cap even after the
          // view pads it out to fit the panel's aspect ratio.
          const initialExtentData = new Extent({
            xmin: 500000, ymin: 9780000, xmax: 500800, ymax: 9780600,
            spatialReference: dataSr,
          });

          const view = new MapView({
            container: 'viewDiv',
            map,
            extent: projection.project(initialExtentData, SpatialReference.WebMercator),
          });

          const statusEl = document.getElementById('status');
          const detailEl = document.getElementById('detail');
          const lineageEl = document.getElementById('lineage');
          const lineageBtn = document.getElementById('lineageBtn');
          const publicToggle = document.getElementById('publicToggle');
          let selectedUpi = null;

          const fillSymbol = {
            type: 'simple-fill',
            color: [227, 139, 79, 0.45],
            outline: { color: [120, 60, 0, 0.9], width: 0.75 },
          };
          const selectedSymbol = {
            type: 'simple-fill',
            color: [0, 0, 0, 0],
            outline: { color: [220, 30, 30, 1], width: 2.5 },
          };

          // GeoJSON (always in the data's SRID, DATA_SRID) -> Esri geometry in the view's spatial reference.
          function toViewGeometry(geojsonGeometry) {
            const dataPolygon = new Polygon({ rings: geojsonGeometry.coordinates, spatialReference: dataSr });
            return projection.project(dataPolygon, view.spatialReference);
          }

          // The view's extent (in its own spatial reference) -> a bbox string in the data's SRID, for the API.
          function currentBboxParam() {
            const e = projection.project(view.extent, dataSr);
            return `${e.xmin.toFixed(2)},${e.ymin.toFixed(2)},${e.xmax.toFixed(2)},${e.ymax.toFixed(2)}`;
          }

          async function loadViewport() {
            if (!view.extent) return;
            const bbox = currentBboxParam();
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
                    geometry: toViewGeometry(f.geometry),
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

          view.when(
            () => {
              loadViewport();
              view.watch('stationary', (isStationary) => {
                if (isStationary) loadViewport();
              });
            },
            (err) => fatal('view failed to load: ' + (err.stack || err.message)),
          );

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
              highlightGeoJson(feature.geometry);
              return feature;
            } catch (err) {
              detailEl.textContent = `error: ${err.message}`;
            }
          }

          // For geometry already expressed in the data's SRID (API responses).
          function highlightGeoJson(geojsonGeometry) {
            highlightViewGeometry(toViewGeometry(geojsonGeometry));
          }

          // For geometry already in the view's spatial reference (e.g. reused straight off a rendered graphic).
          function highlightViewGeometry(viewGeometry) {
            selectedLayer.removeAll();
            selectedLayer.add(new Graphic({ geometry: viewGeometry, symbol: selectedSymbol }));
          }

          view.on('click', async (evt) => {
            const hit = await view.hitTest(evt, { include: parcelsLayer });
            if (!hit.results.length) return;
            const graphic = hit.results[0].graphic;
            highlightViewGeometry(graphic.geometry); // already in view SR, no reprojection needed
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
              const g = toViewGeometry(feature.geometry);
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
        } catch (err) {
          fatal('setup error: ' + (err.stack || err.message));
        }
      })();
    }, (err) => fatal('failed to load esri/geometry/projection: ' + (err && err.message)));
  }, 0);
}, (err) => fatal('failed to load core esri modules: ' + (err && err.message)));
