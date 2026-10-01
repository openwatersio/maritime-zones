import * as L from "leaflet";
import "./style.css";
import type { Hit, Layer, Zone } from "../src/queries.ts";
import { assessDischarge, canadianSource, territoryCodes } from "./regulations.js";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const latitude = element<HTMLInputElement>("latitude");
const longitude = element<HTMLInputElement>("longitude");
const result = element("result");
const status = element("status");
const raw = element("raw");
const snippet = element("snippet");
const runtime = element<HTMLSelectElement>("runtime");
const question = element("question");
const retry = element<HTMLButtonElement>("retry");
const check = element<HTMLButtonElement>("check");
const labels: Record<Layer, string> = {
  internal: "Internal waters",
  archipelagic: "Archipelagic waters",
  "12nm": "Territorial sea (12 NM)",
  "24nm": "Contiguous zone (24 NM)",
  eez: "Exclusive economic zone",
  high_seas: "High seas",
};
const colors: Record<Layer, string> = {
  internal: "#2dd4bf",
  archipelagic: "#a78bfa",
  "12nm": "#38bdf8",
  "24nm": "#fb923c",
  eez: "#60a5fa",
  high_seas: "#94a3b8",
};
const presets: Record<string, { lat: number; lon: number; zoom: number; iso: string }> = {
  canada: { lat: 49.15, lon: -123.4, zoom: 10, iso: "CAN" },
  shore: { lat: 48.4, lon: -124, zoom: 11, iso: "CAN" },
  haro: { lat: 48.6, lon: -123.2, zoom: 10, iso: "CAN" },
  channel: { lat: 51.1, lon: 1.4, zoom: 8, iso: "BEL" },
  ostend: { lat: 51.25, lon: 2.85, zoom: 9, iso: "BEL" },
  atlantic: { lat: 40, lon: -40, zoom: 5, iso: "PRT" },
  fiji: { lat: -17.9, lon: -179.9, zoom: 7, iso: "FJI" },
};
type Mode = "blackwater" | "zones" | "nearest" | "territory" | "land";
let mode: Mode = "blackwater";
let iso = "CAN";
let sequence = 0;
let reader: typeof import("./reader.js");
let zoneTable: Zone[] = [];
let selectedZone: string | null = null;
const map = L.map("map", { worldCopyJump: true, minZoom: 2, maxZoom: 16 }).setView([49.15, -123.4], 10);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).addTo(map);
const overlays = L.layerGroup().addTo(map);
const pin = L.marker([49.15, -123.4], {
  draggable: true,
  title: "Selected position; use coordinate fields to move with the keyboard",
  icon: L.divIcon({
    className: "boat-pin",
    html: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18"><path d="M9 2l5 13-5-3-5 3z" fill="currentColor" /></svg>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  }),
}).addTo(map);

function append(tag: string, text: string, parent: HTMLElement = result, className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  parent.append(node);
  return node;
}
const nm = (value: number) => `${value.toFixed(2)} NM`;
const position = () => [Number(latitude.value), Number(longitude.value)] as [number, number];
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const onMap = (point: [number, number], lon: number): [number, number] => [point[0], lon + wrap(point[1] - lon)];
const zoneName = (zone: Zone) => zone.territory ?? zone.sovereign ?? zone.name;

function code() {
  const [lat, lon] = position();
  const source = runtime.value === "node" ? "./src/index.ts" : "./reader.js";
  const args = `${lat}, ${lon}`;
  const functions = { zones: "whereAmI", nearest: "nearestTerritory", territory: "distanceTo", land: "distanceToLand" };
  if (mode === "blackwater") {
    const regulations = runtime.value === "node" ? "./demo/regulations.ts" : "./regulations.js";
    snippet.textContent = `import { whereAmI, distanceToLand } from "${source}";
import { assessDischarge } from "${regulations}";

const [zones, land] = await Promise.all([
  whereAmI(${args}),
  distanceToLand(${args}),
]);

// The caller owns this rule; it is not part of maritime-zones.
// Canadian example: at least 3 NM. Not legal clearance.
const check = assessDischarge(zones, land?.distanceNm ?? null);
console.log(check);`;
  } else {
    const fn = functions[mode];
    snippet.textContent = `import { ${fn} } from "${source}";

const answer = await ${fn}(${args}${mode === "territory" ? `, "${iso}"` : ""});
console.log(answer);`;
  }
  element("code-note").textContent =
    runtime.value === "node"
      ? "Run from the cloned repository with the release metadata in dist/. Tiles download on demand."
      : "Use reader.js from this Pages site on the same origin as its tiles. Queries read the needed byte ranges.";
}

function showHit(hit: Hit | null, label: string, lat: number, lon: number) {
  if (!hit) {
    append("p", "No result within the search limit", result, "headline");
    append(
      "p",
      "The search stops at approximately 480 NM; no result does not mean zero distance.",
      result,
      "description",
    );
    return;
  }
  append("p", nm(hit.distanceNm), result, "headline distance");
  append("p", label, result, "description");
  const facts = append("dl", "", result, "facts");
  const bearing = append("div", "", facts);
  append("dt", "Initial bearing", bearing);
  append("dd", hit.distanceNm === 0 ? "Already inside" : `${hit.bearingDeg.toFixed(0)}° true`, bearing);
  const nearest = append("div", "", facts);
  append("dt", "Nearest point", nearest);
  append("dd", `${hit.point[0].toFixed(4)}, ${hit.point[1].toFixed(4)}`, nearest);
  const target = onMap(hit.point, lon);
  L.polyline([[lat, lon], target], { color: "#fbbf24", weight: 3, dashArray: "6 5" }).addTo(overlays);
  L.circleMarker(target, { color: "#05122a", fillColor: "#fbbf24", fillOpacity: 1, radius: 6, weight: 2 })
    .bindTooltip("Nearest point")
    .addTo(overlays);
  if (hit.distanceNm > 0)
    map.fitBounds(L.latLngBounds([[lat, lon], target]), { padding: [50, 50], maxZoom: map.getZoom(), animate: false });
}

async function shade(zones: Zone[], lat: number, lon: number, request: number) {
  const chosen = selectedZone ? zones.filter((z) => `${z.layer}:${z.mrgid}` === selectedZone) : zones.slice(0, 1);
  const ids = new Set(chosen.map((zone) => zoneTable.indexOf(zone)));
  if (!ids.size) return;
  const features = await reader.zoneFeatures(
    { minX: lon - 0.35, minY: lat - 0.35, maxX: lon + 0.35, maxY: lat + 0.35 },
    ids,
  );
  if (request !== sequence) return;
  for (const feature of features) {
    const zone = zoneTable[feature.properties!.zone]!;
    L.geoJSON(feature as GeoJSON.GeoJsonObject, {
      coordsToLatLng: (point) => L.latLng(point[1], lon + wrap(point[0] - lon)),
      style: { color: colors[zone.layer], weight: 1, fillOpacity: 0.12 },
    }).addTo(overlays);
  }
  pin.setZIndexOffset(1000);
}

async function run() {
  if (!reader) return;
  const form = element<HTMLFormElement>("position");
  if (!form.reportValidity()) return;
  const request = ++sequence;
  const [lat, lon] = position();
  pin.setLatLng([lat, lon]);
  overlays.clearLayers();
  result.replaceChildren();
  raw.textContent = "Query running…";
  status.textContent = "Reading nearby tiles…";
  retry.hidden = true;
  element("results").setAttribute("aria-busy", "true");
  code();
  const titles: Record<Mode, string> = {
    blackwater: "Can I open my black-water tank here?",
    zones: "Which maritime zones am I in?",
    nearest: "How far is the next territory?",
    territory: "How far is territory X?",
    land: "How far is land?",
  };
  question.textContent = titles[mode];
  try {
    const started = performance.now();
    let answer: unknown;
    if (mode === "blackwater") {
      const [zones, land] = await Promise.all([reader.whereAmI(lat, lon), reader.distanceToLand(lat, lon)]);
      if (request !== sequence) return;
      const assessment = assessDischarge(zones, land?.distanceNm ?? null);
      answer = { ...assessment, zones, land };
      const headlines = {
        "distance-met": "The demo distance rule is met",
        "too-close": "Too close for the demo rule",
        unresolved: "The demo cannot decide here",
      };
      append("p", headlines[assessment.status], result, "headline");
      const facts = append("dl", "", result, "facts");
      const country = append("div", "", facts);
      append("dt", "Territory context", country);
      append("dd", assessment.territories.join(", ") || "No named territory", country);
      const coast = append("div", "", facts);
      append("dt", "Distance to coastline", coast);
      append("dd", land ? nm(land.distanceNm) : "Unknown within 480 NM", coast, "distance");
      const rule = append("div", "", result, "guidance");
      append("h3", "Caller-supplied Canadian example: 3 NM", rule);
      append(
        "p",
        assessment.rule
          ? "At least 3 NM from the dataset coastline is required by this example rule."
          : "This example provides a rule only for an unambiguous CAN territory context. No rule is supplied for this position.",
        rule,
      );
      append(
        "p",
        "This example checks only the distance threshold. Vessel size, underway speed, local restrictions and legal baselines must still be checked; passing it does not authorize discharge.",
        rule,
      );
      const link = append("a", "Read the actual Canadian regulation", rule) as HTMLAnchorElement;
      link.href = canadianSource;
      if (land) {
        const target = onMap(land.point, lon);
        L.polyline([[lat, lon], target], { color: "#fbbf24", weight: 3, dashArray: "6 5" }).addTo(overlays);
        L.circleMarker(target, { radius: 5, color: "#fbbf24" }).bindTooltip("Nearest coastline").addTo(overlays);
      }
      if (assessment.rule)
        L.circle([lat, lon], {
          radius: assessment.rule.minimumDistanceNm * 1852,
          color: "#2dd4bf",
          weight: 2,
          fillOpacity: 0.03,
          dashArray: "4 5",
        }).addTo(overlays);
    } else if (mode === "zones") {
      const zones = await reader.whereAmI(lat, lon);
      if (request !== sequence) return;
      answer = zones;
      if (!zones.length) {
        append("p", "No maritime zone at this point", result, "headline");
        append(
          "p",
          "Land and islands are holes in the maritime-zone polygons. Move the marker offshore to query the surrounding waters.",
          result,
          "description",
        );
      } else {
        append("p", `${zones.length} ${zones.length === 1 ? "zone" : "zones"} at this position`, result, "headline");
        const list = append("ul", "", result, "zone-list");
        for (const zone of zones) {
          const item = append("li", "", list);
          const swatch = append("span", "", item, "swatch");
          swatch.style.background = colors[zone.layer];
          const detail = append("div", "", item);
          const button = append("button", labels[zone.layer], detail) as HTMLButtonElement;
          button.addEventListener("click", () => {
            selectedZone = `${zone.layer}:${zone.mrgid}`;
            void run();
          });
          append(
            "small",
            `${zoneName(zone)}${territoryCodes([zone]).length ? ` (${territoryCodes([zone]).join(" / ")})` : ""}`,
            detail,
          );
        }
        append(
          "p",
          "Click a zone to shade its nearby pieces. Zones are listed from inner waters outward; an EEZ can overlap a territorial sea.",
          result,
          "description",
        );
        await shade(zones, lat, lon, request);
      }
    } else {
      if (mode === "territory") {
        const label = append("label", "Choose a territory");
        const select = document.createElement("select");
        select.id = "territory-select";
        const countries = new Map<string, string>();
        for (const zone of zoneTable)
          if (zone.iso_ter)
            countries.set(
              zone.iso_ter,
              zone.iso_ter === zone.iso_sov ? (zone.sovereign ?? zoneName(zone)) : zoneName(zone),
            );
        for (const [code, name] of [...countries].sort((a, b) => a[1].localeCompare(b[1]))) {
          const option = new Option(`${name} (${code})`, code);
          option.selected = code === iso;
          select.add(option);
        }
        label.append(select);
        select.addEventListener("change", () => {
          iso = select.value;
          void run();
        });
      }
      const hit =
        mode === "land"
          ? await reader.distanceToLand(lat, lon)
          : mode === "nearest"
            ? await reader.nearestTerritory(lat, lon)
            : await reader.distanceTo(lat, lon, iso);
      if (request !== sequence) return;
      answer = hit;
      showHit(
        hit,
        mode === "land"
          ? "to the nearest coastline in the dataset"
          : hit?.zone
            ? `to ${zoneName(hit.zone)} · ${labels[hit.zone.layer]}`
            : "",
        lat,
        lon,
      );
      append(
        "p",
        mode === "land"
          ? "Coastline distance is geometric. A regulation may define shore or nearest land using a different legal baseline."
          : "Territory distances measure internal, archipelagic and territorial waters by default. The next territory excludes the one you are currently in.",
        result,
        "explanation",
      );
    }
    if (request !== sequence) return;
    raw.textContent = JSON.stringify(answer, null, 2);
    status.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)} · ${(performance.now() - started).toFixed(0)} ms · ${reader.version}`;
  } catch (error) {
    if (request !== sequence) return;
    result.replaceChildren();
    status.textContent = `${(error as Error).message}. Retry the query or try another position.`;
    raw.textContent = "The query failed; no partial answer is shown.";
    retry.hidden = false;
  } finally {
    if (request === sequence) element("results").setAttribute("aria-busy", "false");
  }
}

function setPosition(lat: number, lon: number) {
  latitude.value = Math.max(-85, Math.min(85, lat)).toFixed(5);
  longitude.value = wrap(lon).toFixed(5);
  selectedZone = null;
  pin.setLatLng(position());
  void run();
}
map.on("click", (event: L.LeafletMouseEvent) => setPosition(event.latlng.lat, event.latlng.lng));
pin.on("dragend", () => {
  const point = pin.getLatLng();
  setPosition(point.lat, point.lng);
});
element<HTMLFormElement>("position").addEventListener("submit", (event) => {
  event.preventDefault();
  selectedZone = null;
  map.setView(position(), map.getZoom(), { animate: false });
  void run();
});
document.querySelectorAll<HTMLButtonElement>("[data-query]").forEach((button) =>
  button.addEventListener("click", () => {
    mode = button.dataset.query as Mode;
    selectedZone = null;
    document
      .querySelectorAll("[data-query]")
      .forEach((node) => node.setAttribute("aria-pressed", String(node === button)));
    void run();
  }),
);
document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) =>
  button.addEventListener("click", () => {
    const preset = presets[button.dataset.preset!]!;
    iso = preset.iso;
    map.setView([preset.lat, preset.lon], preset.zoom, { animate: false });
    document
      .querySelectorAll("[data-preset]")
      .forEach((node) => node.setAttribute("aria-pressed", String(node === button)));
    setPosition(preset.lat, preset.lon);
  }),
);
runtime.addEventListener("change", code);
retry.addEventListener("click", () => void boot());
element("locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    status.textContent = "Location is unavailable in this browser. Enter coordinates instead.";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (location) => {
      map.setView([location.coords.latitude, location.coords.longitude], 10);
      setPosition(location.coords.latitude, location.coords.longitude);
    },
    () => {
      status.textContent = "Could not get your position. Allow location access or enter coordinates instead.";
    },
    { timeout: 10000 },
  );
});
element("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(snippet.textContent!);
    element("copy").textContent = "Copied";
    setTimeout(() => {
      element("copy").textContent = "Copy code";
    }, 1500);
  } catch {
    status.textContent = "Clipboard access is unavailable. Select and copy the code manually.";
  }
});

async function boot() {
  try {
    reader = await import("./reader.js");
    zoneTable = (await reader.metadata()).zones;
    element("version").textContent = `Tile data ${reader.version}`;
    element<HTMLAnchorElement>("notice-link").href = `./${reader.version}/NOTICE`;
    element("coastline-attribution").innerHTML =
      reader.version === "v0.1.0"
        ? 'Coastlines: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, ODbL 1.0.'
        : 'Coastlines: Flanders Marine Institute (2020). <a href="https://marineinfo.org/doc/dataset/8873">World Countries Geodatabase</a>, CC-BY 4.0; ESRI and DeLorme (2014) source data.';
    check.disabled = false;
    await run();
  } catch (error) {
    status.textContent = `${(error as Error).message}. Retry loading the data.`;
    retry.hidden = false;
    element("results").setAttribute("aria-busy", "false");
  }
}
void boot();
