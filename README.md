# WeeWX Seasons (scrape) — Home Assistant integration

A Home Assistant custom integration that reads **current weather conditions
from any [WeeWX](https://weewx.com/) website using the standard "Seasons"
skin** and exposes them as Home Assistant sensors.

WeeWX publishes a static `index.html` and does not expose a JSON/realtime API by
default, so this integration scrapes the current-conditions table from that
page. It works with any Seasons-skin station — the example used throughout this
README is **[pany.gr](https://pany.gr/)** (Wetterstation im Prättigau,
Pany/Luzein, Switzerland, a Davis Vantage Pro2).

## Sensors

For each configured station the integration creates one device with these
entities:

| Sensor | Device class | Unit | Notes |
| --- | --- | --- | --- |
| Outdoor temperature | temperature | °C | |
| Humidity | humidity | % | |
| Pressure | atmospheric pressure | hPa | `trend` attribute (e.g. `-1.0`) |
| Wind speed | wind speed | m/s | `direction` attribute (e.g. `WNW`) |
| Rain today | precipitation | mm | `state_class: total_increasing` |
| Station reading time | timestamp | – | the station's own "data as of" time |

The **Station reading time** sensor exposes the timestamp printed on the page
(its `lastupdate` line) as a proper `timestamp` entity, so dashboards can show
how old the data is ("5 minutes ago"). The Seasons page prints this time
without a timezone, so the integration applies the **Station time zone** chosen
during setup (see Configuration). If the page carries no parseable timestamp,
the sensor is unavailable.

> The Seasons skin is rendered in the station owner's language. German and
> English labels are recognised out of the box. To add another language, extend
> `SENSOR_ALIASES` in
> [`custom_components/weewx_scrape/parser.py`](custom_components/weewx_scrape/parser.py).

## Installation

### HACS (recommended)

1. In HACS, open the three-dot menu → **Custom repositories**.
2. Add `https://github.com/sebastianzillessen/home-assistant-weewx-scrape`
   with category **Integration**.
3. Install **WeeWX Seasons (scrape)** and restart Home Assistant.

### Manual

1. Copy the `custom_components/weewx_scrape` folder into your Home Assistant
   `config/custom_components/` directory.
2. Restart Home Assistant.

## Configuration

This integration is configured entirely through the UI — no YAML required.

1. Go to **Settings → Devices & Services → Add Integration**.
2. Search for **WeeWX Seasons (scrape)**.
3. Fill in:
   - **Name** – a label for the station device (e.g. `Pany`).
   - **Station URL** – the station website, e.g. `https://pany.gr/`. A bare
     host or a path ending in `/` automatically resolves to `index.html`.
   - **Update interval** – `5`, `10`, `15` or `60` minutes (default `10`).
     Match this to your station's archive interval; most stations update every
     5–10 minutes, so polling faster gains nothing.
   - **Station time zone** – IANA name (e.g. `Europe/Zurich`) applied to the
     station's reading time, which the Seasons page prints without a timezone.
     Defaults to Home Assistant's own timezone; change it only if the station
     is in a different zone.

The interval and time zone can be changed later via the integration's
**Configure** button.

## Dashboard

A ready-made Lovelace dashboard is included in
[`dashboard.yaml`](dashboard.yaml). It uses only Home Assistant's built-in
cards (glance, gauges, an entities card that surfaces the `direction` and
`trend` attributes, and history graphs), so there is nothing extra to install.

To use it, open your dashboard's **Raw configuration editor** (top-right menu →
*Edit dashboard* → top-right menu → *Raw configuration editor*), paste the view
from `dashboard.yaml`, then replace every `sensor.pany_…` entity ID with your
own station's slug. The slug is the device name you chose during setup,
lower-cased with spaces replaced by underscores (e.g. a station named `Pany`
becomes `sensor.pany_outdoor_temperature`). The exact entity IDs are listed
under **Settings → Devices & Services → WeeWX Seasons (scrape)** on the device
page.

## How it works

On each update the integration fetches the station's `index.html`, isolates the
`current_widget` table and reads the `label`/`data` cell pairs, mapping known
labels (German/English) to the sensors above. If the page cannot be fetched or
the `current_widget` table is missing (station offline or an unsupported page),
the sensors become unavailable until the next successful poll.

## Troubleshooting

- **"Could not connect…" during setup** – confirm the URL opens in a browser
  and shows the current-conditions box. Use the page that contains the
  "Aktuell"/"Current" widget (usually the site root / `index.html`).
- **Sensors unavailable** – the station may be temporarily offline, or its page
  uses a non-Seasons skin or a translated label that isn't mapped yet. Enable
  debug logging:
  ```yaml
  logger:
    logs:
      custom_components.weewx_scrape: debug
  ```

## No-code alternative (built-in `scrape`)

If you prefer not to install a custom integration, Home Assistant's built-in
[`scrape`](https://www.home-assistant.io/integrations/scrape/) platform can read
a single value per sensor with a CSS selector, e.g.:

```yaml
sensor:
  - platform: scrape
    resource: https://pany.gr/index.html
    name: Pany outdoor temperature
    select: "#current_widget tr:nth-of-type(1) td.data"
    unit_of_measurement: "°C"
    value_template: "{{ value | regex_findall_index('-?\\d+(\\.\\d+)?') }}"
    scan_interval: 600
```

This integration is more convenient: one request feeds all sensors, it is
language-aware, and it is configured through the UI.

## Development

The HTML parsing logic lives in `parser.py` and has **no Home Assistant
dependency**, so it can be tested standalone:

```bash
pip install pytest
pytest tests -q
```

## Disclaimer

This project is not affiliated with WeeWX or with any weather station it reads.
It only performs read-only HTTP requests against a public website. Be a good
citizen and keep the update interval reasonable.

## License

[MIT](LICENSE)
