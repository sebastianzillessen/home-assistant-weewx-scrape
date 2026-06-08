/**
 * WeeWX Seasons (scrape) — dashboard strategy.
 *
 * Auto-generates a weather dashboard from the entities the `weewx_scrape`
 * integration creates: one view per configured station with charts for
 * temperature, wind (speed + direction), pressure & humidity and daily rain,
 * plus an optional Windy.com map and a windrose. Entities are discovered from
 * the registry, so there is nothing to wire up by hand.
 *
 * This module is shipped with the integration and registered with the frontend
 * automatically, so no HACS plugin or Lovelace resource setup is needed.
 *
 * Usage — create a new dashboard in "YAML"/strategy mode with:
 *
 *   strategy:
 *     type: custom:weewx-seasons
 *     # all optional:
 *     windrose: true          # default true; needs plotly-graph-card
 *     default_span: 48h       # initial time window (apexcharts graph_span); a
 *                             # picker at the top of each view overrides it
 *     # Windy map: auto-centred on the station's scraped coordinates when
 *     # available. Override with `windy: {lat, lon}` or hide with `windy: false`.
 *     base_name: WeeWX        # legend label for the scraped series
 *     sources:                # extra providers to compare (toggle via legend)
 *       - name: MeteoSwiss
 *         temperature: sensor.meteoswiss_at_7243_srs_temperature_at_7243
 *         humidity: sensor.meteoswiss_at_7243_srs_relative_humidity_at_7243
 *         pressure: sensor.meteoswiss_at_7243_srs_air_pressure_sea_level_qff_at_7243
 *         wind_speed: sensor.meteoswiss_at_7243_srs_wind_speed_at_7243
 *         wind_bearing: sensor.meteoswiss_at_7243_srs_wind_direction_at_7243
 *         forecast: weather.meteoswiss_at_7243_srs_weather_at_7243
 *       - name: Met.no
 *         weather: weather.forecast_pany   # shorthand for the 5 roles below
 *         forecast: weather.forecast_pany
 *         style: dotted          # line style for this source's overlays:
 *                                # solid | dashed | dotted (default dotted),
 *                                # or `dash: <px>` for an explicit dash length
 *
 * Each source role accepts a sensor entity id, or an "entity[attribute]"
 * reference to read a value from an entity attribute (e.g. a weather entity).
 * Source overlays appear as extra, legend-toggleable series in the charts and
 * are drawn dotted by default so they read as secondary to the scraped station;
 * any source with a `forecast`/`weather` entity also gets a card on a
 * "Forecast" tab.
 *
 * When at least one comparison source is configured, a toggle bar is shown at
 * the top of each station view with one chip per provider (the scraped station
 * plus every source). Clicking a chip shows/hides all of that provider's series
 * across every chart on the view at once; the choice is remembered per station.
 *
 * Every view also has a time-window picker at the top: quick presets
 * (12h/24h/48h/7d/30d) plus a start–end calendar range. The selection is
 * remembered per station and reloads the view so the charts fetch exactly that
 * window. The rain chart shows per-hour rainfall (mm in each hour, as columns)
 * alongside the instantaneous rain rate (mm/h).
 *
 * The charts use apexcharts-card, and the windrose uses plotly-graph-card —
 * install both from HACS → Frontend. Missing cards simply render as an error
 * card; the rest of the dashboard still works.
 */

const DOMAIN = "weewx_scrape";

// translation_key (set by the integration) -> role used when building cards.
const KEYS = {
  temperature: "outdoor_temperature",
  humidity: "humidity",
  pressure: "pressure",
  pressureTrend: "pressure_trend",
  windSpeed: "wind_speed",
  windBearing: "wind_bearing",
  rain: "rain_today",
  rainRate: "rain_rate",
  stationTime: "station_time",
};

const KNOWN_KEYS = new Set(Object.values(KEYS));

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "weewx";

/** Group this integration's entities by device, keyed by their role. */
function entitiesByDevice(hass) {
  const groups = new Map();
  for (const entry of Object.values(hass.entities || {})) {
    if (entry.platform !== DOMAIN) continue;
    const device = entry.device_id || "_";
    if (!groups.has(device)) groups.set(device, {});
    const map = groups.get(device);
    let key = entry.translation_key;
    if (!key || !KNOWN_KEYS.has(key)) {
      // Fallback when translation_key is unavailable: recover the role from
      // the entity_id suffix (the keys double as the English name slugs).
      key = [...KNOWN_KEYS].find((k) => entry.entity_id.endsWith(k));
    }
    if (key) map[key] = entry.entity_id;
  }
  return groups;
}

// --- Additional comparison sources ---------------------------------------
// Each entry in `config.sources` overlays a second provider onto the charts.
// A role (temperature/humidity/pressure/wind_speed/wind_bearing) maps to either
//   - a sensor entity id:            "sensor.foo"
//   - an entity attribute:           "weather.forecast_pany[temperature]"
// As a shorthand, `weather: weather.x` pulls the standard roles from that
// weather entity's attributes. Series share whatever display unit Home
// Assistant uses (no forced conversion); weather attributes, which carry no
// unit, are labelled from the entity's *_unit attributes.

const WEATHER_ATTR = {
  temperature: "temperature",
  humidity: "humidity",
  pressure: "pressure",
  wind_speed: "wind_speed",
  wind_bearing: "wind_bearing",
};

// Parse an "entity[attribute]" reference into { entity, attribute }.
function parseRef(value) {
  const match = /^\s*([^[\]]+?)\s*\[\s*([^[\]]+?)\s*\]\s*$/.exec(value);
  return match
    ? { entity: match[1], attribute: match[2] }
    : { entity: String(value).trim(), attribute: undefined };
}

// Unit to label a weather-entity attribute with. apexcharts infers a unit from
// a sensor's `unit_of_measurement`, but a weather attribute carries none — its
// unit lives in a sibling attribute (temperature_unit/pressure_unit/…).
function attributeUnit(role, state) {
  const attrs = state?.attributes || {};
  switch (role) {
    case "temperature":
      return attrs.temperature_unit;
    case "pressure":
      return attrs.pressure_unit;
    case "wind_speed":
      return attrs.wind_speed_unit;
    case "humidity":
      return "%";
    case "wind_bearing":
      return "°";
    default:
      return undefined;
  }
}

function normalizeSources(config) {
  return Array.isArray(config.sources) ? config.sources : [];
}

// Build a chart series for `role` from one source, or null if not provided /
// the entity does not exist (so a wrong id is skipped instead of crashing the
// chart).
function sourceSeries(source, role, hass, opts = {}) {
  const { nameSuffix = "", ...rest } = opts;
  let entity;
  let attribute;
  if (source[role]) {
    ({ entity, attribute } = parseRef(source[role]));
  } else if (source.weather && WEATHER_ATTR[role]) {
    entity = source.weather;
    attribute = WEATHER_ATTR[role];
  }
  const state = entity ? hass.states?.[entity] : undefined;
  if (!entity || !state) return null;
  const series = { entity, name: (source.name || entity) + nameSuffix, ...rest };
  if (attribute) {
    series.attribute = attribute;
    // Weather attributes have no unit_of_measurement; label them so the value
    // isn't shown bare. An explicit `wind_speed_unit` on the source wins.
    const unit =
      (role === "wind_speed" && source.wind_speed_unit) ||
      attributeUnit(role, state);
    if (unit) series.unit = unit;
  }
  return series;
}

// True if `source` can provide `role` from an entity that actually exists.
function sourceHas(source, role, hass) {
  return Boolean(sourceSeries(source, role, hass));
}

// Resolve a source's line style into an apexcharts dashArray value (px). Source
// overlays default to a dotted line so they read as "secondary" against the
// scraped station's solid line; override per source with `style: solid|dashed|
// dotted` or an explicit `dash: <number>`.
function sourceDash(source) {
  if (typeof source.dash === "number") return source.dash;
  switch (String(source.style || source.line_style || "dotted").toLowerCase()) {
    case "solid":
      return 0;
    case "dashed":
      return 6;
    case "dotted":
    default:
      return 2;
  }
}

function addSourceSeries(series, sources, role, hass, opts = {}) {
  for (const source of sources) {
    const built = sourceSeries(source, role, hass, opts);
    if (built) {
      // Internal hint consumed by apex(); kept off the emitted series config.
      built._dash = sourceDash(source);
      series.push(built);
    }
  }
}

function apex(title, graphSpan, series, extra = {}) {
  // Pull the internal `_dash` hint off each series and turn it into a per-series
  // apexcharts stroke.dashArray (index-aligned with `series`). 0 = solid.
  const cleaned = series.map(({ _dash, ...rest }) => rest);
  const dashArray = series.map((s) => s._dash || 0);
  const { all_series_config: allSeries, apex_config: extraApex, ...restExtra } =
    extra;
  const apexConfig = { ...(extraApex || {}) };
  if (dashArray.some((d) => d)) {
    apexConfig.stroke = { ...(apexConfig.stroke || {}), dashArray };
  }
  return {
    type: "custom:apexcharts-card",
    header: { show: true, title, show_states: true, colorize_states: true },
    graph_span: graphSpan,
    all_series_config: allSeries || { stroke_width: 2 },
    series: cleaned,
    ...(Object.keys(apexConfig).length ? { apex_config: apexConfig } : {}),
    ...restExtra,
  };
}

function temperatureCard({ m, sources, baseName, hass, graphSpan, spanExtra }) {
  const series = [];
  if (m[KEYS.temperature]) {
    series.push({
      entity: m[KEYS.temperature],
      name: baseName,
      show: { extremas: true },
    });
  }
  addSourceSeries(series, sources, "temperature", hass);
  return series.length ? apex("Temperature", graphSpan, series, spanExtra) : null;
}

function windCard({ m, sources, baseName, hass, graphSpan, spanExtra }) {
  const series = [];
  const yaxis = [{ id: "speed", min: 0 }];
  if (m[KEYS.windSpeed]) {
    series.push({
      entity: m[KEYS.windSpeed],
      name: baseName,
      type: "line",
      yaxis_id: "speed",
      show: { extremas: "max" },
      group_by: { func: "avg" },
    });
  }
  addSourceSeries(series, sources, "wind_speed", hass, {
    type: "line",
    yaxis_id: "speed",
    group_by: { func: "avg" },
  });
  if (!series.length) return null;

  const hasBearing =
    m[KEYS.windBearing] || sources.some((s) => sourceHas(s, "wind_bearing", hass));
  if (m[KEYS.windBearing]) {
    series.push({
      entity: m[KEYS.windBearing],
      name: `${baseName} dir`,
      type: "line",
      yaxis_id: "direction",
      group_by: { func: "avg" },
    });
  }
  addSourceSeries(series, sources, "wind_bearing", hass, {
    type: "line",
    yaxis_id: "direction",
    group_by: { func: "avg" },
    opacity: 0.4,
    nameSuffix: " dir",
  });
  if (hasBearing) {
    yaxis.push({
      id: "direction",
      opposite: true,
      min: 0,
      max: 360,
      decimals: 0,
      apex_config: {
        tickAmount: 8,
        labels: {
          formatter:
            'EVAL:function(val) { const c = {0:"N",90:"E",180:"S",270:"W",360:"N"}; return c[val] || ""; }',
        },
      },
    });
  }
  return apex("Wind", graphSpan, series, { yaxis, ...spanExtra });
}

function pressureHumidityCard({ m, sources, baseName, hass, graphSpan, spanExtra }) {
  const series = [];
  const yaxis = [];
  const hasPressure =
    m[KEYS.pressure] || sources.some((s) => sourceHas(s, "pressure", hass));
  const hasHumidity =
    m[KEYS.humidity] || sources.some((s) => sourceHas(s, "humidity", hass));
  if (m[KEYS.pressure]) {
    series.push({ entity: m[KEYS.pressure], name: `${baseName} P`, yaxis_id: "pressure" });
  }
  addSourceSeries(series, sources, "pressure", hass, { yaxis_id: "pressure", nameSuffix: " P" });
  if (m[KEYS.humidity]) {
    series.push({ entity: m[KEYS.humidity], name: `${baseName} RH`, yaxis_id: "humidity" });
  }
  addSourceSeries(series, sources, "humidity", hass, { yaxis_id: "humidity", nameSuffix: " RH" });
  if (!series.length) return null;
  if (hasPressure) yaxis.push({ id: "pressure", decimals: 1 });
  if (hasHumidity) {
    yaxis.push({ id: "humidity", min: 0, max: 100, decimals: 0, opposite: true });
  }
  return apex("Pressure & Humidity", graphSpan, series, {
    yaxis,
    all_series_config: { stroke_width: 2, show: { extremas: true } },
    ...spanExtra,
  });
}

function rainCard({ m, graphSpan, spanExtra }) {
  if (!m[KEYS.rain] && !m[KEYS.rainRate]) return null;
  const series = [];
  const yaxis = [];
  if (m[KEYS.rain]) {
    // Per-hour rainfall: the scraped `rain_today` is a daily-resetting cumulative
    // total, so the rain that fell within each hour is the increase across that
    // hour — apexcharts `group_by: diff` over 1h buckets, drawn as columns.
    series.push({
      entity: m[KEYS.rain],
      name: "Hourly rain",
      type: "column",
      yaxis_id: "rain",
      group_by: { func: "diff", duration: "1h" },
      show: { extremas: "max" },
    });
    yaxis.push({ id: "rain", min: 0 });
  }
  // Rain rate (mm/h) is an instantaneous value on its own axis, drawn as a line
  // over the hourly columns so both read off the same chart.
  if (m[KEYS.rainRate]) {
    series.push({
      entity: m[KEYS.rainRate],
      name: "Rate",
      type: "line",
      yaxis_id: "rate",
      show: { extremas: "max" },
    });
    yaxis.push({ id: "rate", min: 0, opposite: true });
  }
  return apex("Rain (hourly)", graphSpan, series, { yaxis, ...spanExtra });
}

function windyCard({ lat, lon }) {
  const url =
    "https://embed.windy.com/embed.html?type=map&location=coordinates" +
    "&metricRain=mm&metricTemp=%C2%B0C&metricWind=m%2Fs&zoom=9&overlay=wind" +
    `&product=ecmwf&level=surface&lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}`;
  return { type: "iframe", aspect_ratio: "75%", url };
}

// The windrose reuses the wind bearing (degrees). Speed buckets are in m/s to
// match this integration's wind-speed unit.
const WINDROSE_AN =
  "$ex vars.theta = ( ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', " +
  "'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] )";

const WINDROSE_FN = `$ex vars.windRose = (vars, minSpeed, maxSpeed) => {
    const headings = [
        { label: "N",   min: 348.75, max:  11.25 },
        { label: "NNE", min:  11.25, max:  33.75 },
        { label: "NE",  min:  33.75, max:  56.25 },
        { label: "ENE", min:  56.25, max:  78.75 },
        { label: "E",   min:  78.75, max: 101.25 },
        { label: "ESE", min: 101.25, max: 123.75 },
        { label: "SE",  min: 123.75, max: 146.25 },
        { label: "SSE", min: 146.25, max: 168.75 },
        { label: "S",   min: 168.75, max: 191.25 },
        { label: "SSW", min: 191.25, max: 213.75 },
        { label: "SW",  min: 213.75, max: 236.25 },
        { label: "WSW", min: 236.25, max: 258.75 },
        { label: "W",   min: 258.75, max: 281.25 },
        { label: "WNW", min: 281.25, max: 303.75 },
        { label: "NW",  min: 303.75, max: 326.25 },
        { label: "NNW", min: 326.25, max: 348.75 }
    ];
    let   headingsCount    = headings.map(() => 0);
    const observationCount = vars.windDirections.length;
    for (let i = 0; i < observationCount; i++) {
        const direction = vars.windDirections[i];
        const speed     = vars.windSpeeds[i];
        if ( (minSpeed != 0 || maxSpeed != 0) && (speed > minSpeed && speed <= maxSpeed) ) {
            const headingFound = headings.find(seg => {
              if (seg.min < seg.max) {
                    return direction >= seg.min && direction <= seg.max;
                } else if ( seg.min > seg.max ) {
                    return direction >= seg.min || direction <= seg.max;
                }
                return false;
            });
            headingsCount[headings.indexOf(headingFound)]++;
        } else if (minSpeed == 0 && maxSpeed == 0 && speed == 0) {
            headingsCount.forEach((_, j) => headingsCount[j]++);
        }
    }
    return ( headingsCount.map(count => (count / observationCount) * 100) );
}`;

const WINDROSE_BUCKETS = [
  { name: "≤1 m/s", min: 0, max: 1 },
  { name: "≤3 m/s", min: 1, max: 3 },
  { name: "≤5 m/s", min: 3, max: 5 },
  { name: "≤8 m/s", min: 5, max: 8 },
  { name: "≤11 m/s", min: 8, max: 11 },
  { name: "≤14 m/s", min: 11, max: 14 },
  { name: ">14 m/s", min: 14, max: 1000 },
];

function windroseCard(m) {
  const sampler = (assign) => ({
    internal: true,
    filters: [{ resample: "5m" }, { map_y: "parseFloat(y)" }],
    ...assign,
  });
  return {
    type: "custom:plotly-graph",
    title: "Windrose",
    hours_to_show: 24,
    raw_plotly_config: true,
    config: { displaylogo: false },
    layout: {
      legend: { orientation: "h" },
      margin: { t: 25 },
      polar: {
        barmode: "stack",
        bargap: 0,
        radialaxis: { type: "linear", ticksuffix: "%", angle: 45, dtick: 4 },
        angularaxis: { direction: "clockwise" },
      },
    },
    an: WINDROSE_AN,
    fn: WINDROSE_FN,
    defaults: { entity: { hovertemplate: "%{theta} %{r:.2f}%" } },
    entities: [
      {
        entity: m[KEYS.windBearing],
        ...sampler({ dn: "$fn ({ ys, vars }) => { vars.windDirections = ys }" }),
      },
      {
        entity: m[KEYS.windSpeed],
        ...sampler({ sn: "$fn ({ ys, vars }) => { vars.windSpeeds = ys }" }),
      },
      ...WINDROSE_BUCKETS.map((b) => ({
        entity: "",
        type: "barpolar",
        name: b.name,
        r: `$ex vars.windRose( vars, ${b.min}, ${b.max} )`,
        theta: "$ex vars.theta",
        showlegend: `$ex vars.windRose(vars, ${b.min}, ${b.max}).some((x) => x > 0)`,
      })),
    ],
  };
}

// --- Time-window picker ---------------------------------------------------
// A toolbar at the top of each view to choose how far back the charts show:
// quick presets ("last 24h/48h/…") plus a start–end calendar range. apexcharts
// only fetches data for its `graph_span`, so changing the window persists the
// choice and reloads the view, and the strategy reads it back here to set each
// chart's `graph_span`/`span` when it regenerates.
const TIME_TAG = "weewx-time-range";
const TIME_PRESETS = ["12h", "24h", "48h", "7d", "30d"];
const DAY_MS = 86400000;

function timeStorageKey(slug) {
  return `${TIME_TAG}:${slug}`;
}

function loadWindow(slug) {
  try {
    const raw = localStorage.getItem(timeStorageKey(slug));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Translate a stored window into apexcharts-card options. A preset is a plain
// duration ending "now"; a calendar range is expressed as a day-aligned span
// ending on (and offset back to) the chosen end date.
function resolveSpan(win, defaultSpan) {
  if (win && win.kind === "preset" && win.span) {
    return { graphSpan: win.span, spanExtra: {} };
  }
  if (win && win.kind === "range" && win.start && win.end) {
    const start = new Date(`${win.start}T00:00:00`);
    const end = new Date(`${win.end}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!isNaN(start) && !isNaN(end) && end >= start) {
      const days = Math.round((end - start) / DAY_MS) + 1;
      const endOffset = Math.round((end - today) / DAY_MS);
      const span = { end: "day" };
      if (endOffset !== 0) span.offset = `${endOffset}d`;
      return { graphSpan: `${days}d`, spanExtra: { span } };
    }
  }
  return { graphSpan: defaultSpan, spanExtra: {} };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

class WeewxTimeRange extends HTMLElement {
  setConfig(config) {
    this._slug = config.slug || "weewx";
    this._presets = Array.isArray(config.presets) ? config.presets : TIME_PRESETS;
    this._default = config.default_span || "48h";
    this._win = config.win || loadWindow(this._slug);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  _activePreset() {
    if (this._win && this._win.kind === "preset") return this._win.span;
    if (!this._win) return this._default;
    return null; // a calendar range is active
  }

  _commit(win) {
    try {
      localStorage.setItem(timeStorageKey(this._slug), JSON.stringify(win));
    } catch (e) {
      /* ignore — without storage the reload below can't help anyway */
    }
    // The strategy reads the window when it regenerates; reload to apply it.
    location.reload();
  }

  _render() {
    if (!this._root) this._root = this.attachShadow({ mode: "open" });
    const active = this._activePreset();
    const presetBtns = this._presets
      .map(
        (p) =>
          `<button class="chip${p === active ? " on" : ""}" type="button" data-p="${p}">${p}</button>`
      )
      .join("");
    // Default the calendar inputs to the active range, else the last `default`.
    let start;
    let end;
    if (this._win && this._win.kind === "range") {
      start = this._win.start;
      end = this._win.end;
    } else {
      const e = new Date();
      const s = new Date(e.getTime() - 1 * DAY_MS);
      start = isoDate(s);
      end = isoDate(e);
    }
    const rangeOn = this._win && this._win.kind === "range";
    this._root.innerHTML = `
      <style>
        .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
               padding: 10px 12px; }
        .label { color: var(--secondary-text-color); font-size: 0.9em; }
        .chip { border: 1px solid var(--divider-color, #444);
                background: var(--card-background-color, transparent);
                color: var(--primary-text-color); border-radius: 16px;
                padding: 4px 12px; font-size: 0.9em; cursor: pointer; }
        .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
        .sep { width: 1px; align-self: stretch; background: var(--divider-color, #444);
               margin: 2px 4px; }
        input[type=date] { background: var(--card-background-color, transparent);
                color: var(--primary-text-color);
                border: 1px solid var(--divider-color, #444); border-radius: 8px;
                padding: 3px 6px; font-size: 0.9em; color-scheme: dark light; }
        .apply { border: 1px solid var(--primary-color); color: var(--primary-color);
                 background: transparent; border-radius: 16px; padding: 4px 12px;
                 font-size: 0.9em; cursor: pointer; }
        .apply.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
      </style>
      <ha-card><div class="bar">
        <span class="label">Window:</span>${presetBtns}
        <span class="sep"></span>
        <input type="date" class="from" value="${start}" max="${end}">
        <span class="label">→</span>
        <input type="date" class="to" value="${end}">
        <button class="apply${rangeOn ? " on" : ""}" type="button">Apply range</button>
      </div></ha-card>`;
    this._root.querySelectorAll(".chip").forEach((el) =>
      el.addEventListener("click", () =>
        this._commit({ kind: "preset", span: el.dataset.p })
      )
    );
    this._root.querySelector(".apply").addEventListener("click", () => {
      const from = this._root.querySelector(".from").value;
      const to = this._root.querySelector(".to").value;
      if (from && to && to >= from) {
        this._commit({ kind: "range", start: from, end: to });
      }
    });
  }

  getCardSize() {
    return 1;
  }
}

if (!customElements.get(TIME_TAG)) {
  customElements.define(TIME_TAG, WeewxTimeRange);
}

function timeRangeCard({ slug, win, defaultSpan }) {
  return { type: `custom:${TIME_TAG}`, slug, win, default_span: defaultSpan };
}

// The observations view: scrape charts with optional source overlays, plus the
// Windy map and windrose (both from the scraped station).
function buildStationView(title, slug, m, config, hass) {
  const defaultSpan = config.default_span || "48h";
  const win = loadWindow(slug);
  const { graphSpan, spanExtra } = resolveSpan(win, defaultSpan);
  const ctx = {
    m,
    sources: normalizeSources(config),
    baseName: config.base_name || "WeeWX",
    hass,
    graphSpan,
    spanExtra,
  };
  const cards = [
    temperatureCard(ctx),
    windCard(ctx),
    pressureHumidityCard(ctx),
    rainCard(ctx),
  ].filter(Boolean);
  // A toggle bar (when there are comparison sources) to show/hide each
  // provider's series across every chart on the view; placed at the very top.
  const toggles = cards.length ? sourceToggleCard({ ...ctx, slug }) : null;
  if (toggles) cards.unshift(toggles);
  // A time-window picker (presets + calendar range) controlling every chart on
  // the view; placed above everything else.
  const timeRange = cards.length
    ? timeRangeCard({ slug, win, defaultSpan })
    : null;
  if (timeRange) cards.unshift(timeRange);
  if (config.windy && config.windy.lat != null && config.windy.lon != null) {
    cards.push(windyCard(config.windy));
  }
  if (config.windrose !== false && m[KEYS.windBearing] && m[KEYS.windSpeed]) {
    cards.push(windroseCard(m));
  }
  return { title, path: slug, icon: "mdi:weather-partly-cloudy", cards };
}

// A separate tab comparing the forecast of every source that exposes a weather
// entity (via `forecast:` or the `weather:` shorthand). Null if none do.
function forecastView(title, slug, sources, hass) {
  const cards = [];
  for (const source of sources) {
    const entity = source.forecast || source.weather;
    if (entity && hass.states?.[entity]) {
      cards.push({
        type: "weather-forecast",
        entity,
        name: source.name || entity,
        show_current: true,
        show_forecast: true,
        forecast_type: "daily",
      });
    }
  }
  if (!cards.length) return null;
  return {
    title: `${title} · Forecast`,
    path: `${slug}-forecast`,
    icon: "mdi:weather-cloudy-clock",
    cards,
  };
}

// Resolve the Windy map config: explicit `windy` wins; otherwise fall back to
// the station coordinates the integration scrapes (exposed as attributes on the
// station-time sensor). `windy: false` disables the map.
function resolveWindy(config, hass, m) {
  if (config.windy !== undefined) return config.windy;
  const stationTime = m[KEYS.stationTime] && hass.states?.[m[KEYS.stationTime]];
  const lat = stationTime?.attributes?.latitude;
  const lon = stationTime?.attributes?.longitude;
  if (lat != null && lon != null) return { lat, lon };
  return undefined;
}

// --- Source toggle bar ----------------------------------------------------
// A small toolbar placed at the top of a station view with one chip per series
// "group" (the scraped station plus each comparison source). Toggling a chip
// shows/hides every series of that group across all apexcharts cards on the
// view at once — e.g. hide Met.no everywhere with a single click. Series are
// matched by name: the group name itself, or the group name followed by a
// suffix (e.g. "Met.no", "Met.no P", "Met.no dir").
const TOGGLE_TAG = "weewx-source-toggles";

// Collect every <apexcharts-card> on the page, descending through shadow roots.
// Home Assistant only mounts the active view, so this is effectively scoped to
// the view the toggle bar lives on.
function collectApexCharts(root = document.body, acc = []) {
  const visit = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === "APEXCHARTS-CARD") acc.push(node);
    if (node.shadowRoot) node.shadowRoot.childNodes.forEach(visit);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return acc;
}

// Show or hide every series belonging to `group` across the given apex cards.
function applyGroupVisibility(charts, group, hidden) {
  const matches = (name) => name === group || name.startsWith(`${group} `);
  for (const card of charts) {
    const chart = card._apexChart;
    const names = chart?.w?.globals?.seriesNames;
    if (!names) continue;
    for (const name of names) {
      if (!matches(name)) continue;
      try {
        if (hidden) chart.hideSeries(name);
        else chart.showSeries(name);
      } catch (e) {
        /* series not toggleable yet — ignore */
      }
    }
  }
}

class WeewxSourceToggles extends HTMLElement {
  setConfig(config) {
    this._groups = Array.isArray(config.groups) ? config.groups : [];
    this._key = `weewx-source-toggles:${config.storage_key || location.pathname}`;
    this._hidden = this._load();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // Re-apply persisted "hidden" groups once charts have had a chance to render.
    if (!this._applied) {
      this._applied = true;
      this._reapplyHidden();
    }
  }

  _load() {
    try {
      return new Set(JSON.parse(localStorage.getItem(this._key) || "[]"));
    } catch (e) {
      return new Set();
    }
  }

  _save() {
    try {
      localStorage.setItem(this._key, JSON.stringify([...this._hidden]));
    } catch (e) {
      /* storage unavailable — toggles still work for the session */
    }
  }

  // Charts can render after this card; retry applying the hidden state a few
  // times so a reload restores the previous selection.
  _reapplyHidden() {
    if (!this._hidden.size) return;
    let tries = 0;
    const tick = () => {
      const charts = collectApexCharts();
      for (const g of this._hidden) applyGroupVisibility(charts, g, true);
      if (++tries < 6) setTimeout(tick, 500);
    };
    setTimeout(tick, 250);
  }

  _toggle(group) {
    const hidden = !this._hidden.has(group);
    if (hidden) this._hidden.add(group);
    else this._hidden.delete(group);
    this._save();
    applyGroupVisibility(collectApexCharts(), group, hidden);
    this._render();
  }

  _render() {
    if (!this._root) this._root = this.attachShadow({ mode: "open" });
    const chips = this._groups
      .map((g) => {
        const off = this._hidden.has(g);
        return `<button class="chip${off ? " off" : ""}" type="button" data-g="${encodeURIComponent(
          g
        )}" aria-pressed="${!off}"><span class="dot"></span>${g}</button>`;
      })
      .join("");
    this._root.innerHTML = `
      <style>
        .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
               padding: 10px 12px; }
        .label { color: var(--secondary-text-color); font-size: 0.9em;
                 margin-right: 2px; }
        .chip { display: inline-flex; align-items: center; gap: 6px;
                border: 1px solid var(--divider-color, #444);
                background: var(--card-background-color, transparent);
                color: var(--primary-text-color); border-radius: 16px;
                padding: 4px 12px; font-size: 0.9em; cursor: pointer;
                line-height: 1.4; }
        .chip .dot { width: 9px; height: 9px; border-radius: 50%;
                     background: var(--primary-color); }
        .chip.off { opacity: 0.45; text-decoration: line-through; }
        .chip.off .dot { background: var(--disabled-text-color, #888); }
      </style>
      <ha-card><div class="bar"><span class="label">Sources:</span>${chips}</div></ha-card>`;
    this._root.querySelectorAll(".chip").forEach((el) => {
      el.addEventListener("click", () =>
        this._toggle(decodeURIComponent(el.dataset.g))
      );
    });
  }

  getCardSize() {
    return 1;
  }
}

if (!customElements.get(TOGGLE_TAG)) {
  customElements.define(TOGGLE_TAG, WeewxSourceToggles);
}

// Build the toggle bar for a view: the scraped station plus every source that
// contributes at least one series. Returns null when there is nothing to
// compare (no sources), so single-station dashboards stay uncluttered.
function sourceToggleCard({ baseName, sources, slug, hass }) {
  const roles = ["temperature", "humidity", "pressure", "wind_speed", "wind_bearing"];
  const groups = [baseName];
  for (const source of sources) {
    if (source.name && roles.some((r) => sourceHas(source, r, hass))) {
      groups.push(source.name);
    }
  }
  if (groups.length < 2) return null;
  return { type: `custom:${TOGGLE_TAG}`, groups, storage_key: slug };
}

class WeewxSeasonsDashboardStrategy {
  static async generate(config, hass) {
    const groups = entitiesByDevice(hass);
    const sources = normalizeSources(config);
    const views = [];
    for (const [deviceId, m] of groups) {
      const device = (hass.devices || {})[deviceId];
      const title = device?.name_by_user || device?.name || "WeeWX";
      const slug = slugify(title);
      const windy = resolveWindy(config, hass, m);
      const view = buildStationView(title, slug, m, { ...config, windy }, hass);
      if (view.cards.length) views.push(view);
      const forecast = forecastView(title, slug, sources, hass);
      if (forecast) views.push(forecast);
    }
    if (!views.length) {
      views.push({
        title: "WeeWX",
        cards: [
          {
            type: "markdown",
            content:
              "**WeeWX Seasons (scrape):** no station entities were found.\n\n" +
              "Add the integration under **Settings → Devices & Services → " +
              "Add Integration**, then reload this dashboard.",
          },
        ],
      });
    }
    return { title: "Weather", views };
  }
}

customElements.define(
  "ll-strategy-dashboard-weewx-seasons",
  WeewxSeasonsDashboardStrategy
);
