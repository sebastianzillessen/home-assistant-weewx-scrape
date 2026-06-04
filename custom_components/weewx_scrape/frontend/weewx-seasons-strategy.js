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
 *     windy:                  # omitted -> no Windy map
 *       lat: 46.95
 *       lon: 9.78
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

function temperatureCard(m) {
  return apex("Temperature", "36h", [
    {
      entity: m[KEYS.temperature],
      name: "Temperature",
      show: { extremas: true },
    },
  ]);
}

function windCard(m) {
  const series = [
    {
      entity: m[KEYS.windSpeed],
      name: "Speed",
      type: "line",
      yaxis_id: "speed",
      show: { extremas: "max" },
      group_by: { func: "avg" },
    },
  ];
  const yaxis = [{ id: "speed", min: 0 }];
  if (m[KEYS.windBearing]) {
    series.push({
      entity: m[KEYS.windBearing],
      name: "Direction",
      type: "line",
      yaxis_id: "direction",
      group_by: { func: "avg" },
    });
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

function pressureHumidityCard(m) {
  const series = [];
  const yaxis = [];
  if (m[KEYS.pressure]) {
    series.push({
      entity: m[KEYS.pressure],
      name: "Pressure",
      yaxis_id: "pressure",
    });
    yaxis.push({ id: "pressure", decimals: 1 });
  }
  if (m[KEYS.humidity]) {
    series.push({
      entity: m[KEYS.humidity],
      name: "Humidity",
      yaxis_id: "humidity",
    });
    yaxis.push({ id: "humidity", min: 0, max: 100, decimals: 0, opposite: true });
  }
  return apex("Pressure & Humidity", "36h", series, {
    yaxis,
    all_series_config: { stroke_width: 2, show: { extremas: true } },
  });
}

function rainCard(m) {
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

function buildStationView(title, m, config) {
  const cards = [];
  if (m[KEYS.temperature]) cards.push(temperatureCard(m));
  if (m[KEYS.windSpeed]) cards.push(windCard(m));
  if (m[KEYS.pressure] || m[KEYS.humidity]) cards.push(pressureHumidityCard(m));
  if (m[KEYS.rain]) cards.push(rainCard(m));
  if (config.windy && config.windy.lat != null && config.windy.lon != null) {
    cards.push(windyCard(config.windy));
  }
  if (config.windrose !== false && m[KEYS.windBearing] && m[KEYS.windSpeed]) {
    cards.push(windroseCard(m));
  }
  return {
    title,
    path: slugify(title),
    icon: "mdi:weather-partly-cloudy",
    cards,
  };
}

class WeewxSeasonsDashboardStrategy {
  static async generate(config, hass) {
    const groups = entitiesByDevice(hass);
    const views = [];
    for (const [deviceId, m] of groups) {
      const device = (hass.devices || {})[deviceId];
      const title = device?.name_by_user || device?.name || "WeeWX";
      const view = buildStationView(title, m, config);
      if (view.cards.length) views.push(view);
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
