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
 *         temperature: weather.forecast_pany[temperature]   # entity[attribute]
 *         humidity: weather.forecast_pany[humidity]
 *         pressure: weather.forecast_pany[pressure]
 *         wind_speed: weather.forecast_pany[wind_speed]
 *         wind_bearing: weather.forecast_pany[wind_bearing]
 *         forecast: weather.forecast_pany
 *         # shorthand equivalent for the five roles above:
 *         #   weather: weather.forecast_pany
 *
 * Each source role accepts a sensor entity id, or an "entity[attribute]"
 * reference to read a value from an entity attribute (e.g. a weather entity).
 * Source overlays appear as extra, legend-toggleable series in the charts; any
 * source with a `forecast`/`weather` entity also gets a card on a "Forecast" tab.
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

function addSourceSeries(series, sources, role, hass, opts = {}) {
  for (const source of sources) {
    const built = sourceSeries(source, role, hass, opts);
    if (built) series.push(built);
  }
}

function apex(title, graphSpan, series, extra = {}) {
  return {
    type: "custom:apexcharts-card",
    header: { show: true, title, show_states: true, colorize_states: true },
    graph_span: graphSpan,
    all_series_config: { stroke_width: 2 },
    series,
    ...extra,
  };
}

function temperatureCard({ m, sources, baseName, hass }) {
  const series = [];
  if (m[KEYS.temperature]) {
    series.push({
      entity: m[KEYS.temperature],
      name: baseName,
      show: { extremas: true },
    });
  }
  addSourceSeries(series, sources, "temperature", hass);
  return series.length ? apex("Temperature", "36h", series) : null;
}

function windCard({ m, sources, baseName, hass }) {
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
  return apex("Wind", "36h", series, { yaxis });
}

function pressureHumidityCard({ m, sources, baseName, hass }) {
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
  return apex("Pressure & Humidity", "36h", series, {
    yaxis,
    all_series_config: { stroke_width: 2, show: { extremas: true } },
  });
}

function rainCard({ m }) {
  if (!m[KEYS.rain]) return null;
  return apex("Rain today", "1d", [
    {
      entity: m[KEYS.rain],
      name: "Daily accumulation",
      type: "area",
      opacity: 0.3,
      show: { extremas: "max" },
    },
  ]);
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

// The observations view: scrape charts with optional source overlays, plus the
// Windy map and windrose (both from the scraped station).
function buildStationView(title, slug, m, config, hass) {
  const ctx = {
    m,
    sources: normalizeSources(config),
    baseName: config.base_name || "WeeWX",
    hass,
  };
  const cards = [
    temperatureCard(ctx),
    windCard(ctx),
    pressureHumidityCard(ctx),
    rainCard(ctx),
  ].filter(Boolean);
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
