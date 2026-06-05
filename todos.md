# TODOs

Open items from the dashboard / multi-source work. Done items are kept briefly
for context.

## ✅ Done
- Dashboard strategy (`custom:weewx-seasons`), auto-registered with the frontend.
- New sensors: wind bearing (°), pressure trend; station coordinates → auto Windy map.
- Multi-source comparison (overlays + Forecast tab), `entity[attribute]` syntax,
  missing-entity guard, unit auto-detection for weather attributes.
- Per-source line style (`style`/`dash`, overlays dotted by default) and a
  top-of-view toggle bar to show/hide a whole provider across every chart.
- Fixes: config-flow update interval, `frontend.py` → `dashboard.py` rename.
- Releases: `v0.0.3` (stable), `v0.0.4` + `v0.0.5` (pre-release).
- Dashboard screenshot in README.
- Separate **Weather to Sensors** integration built and installed (own repo).

## 🔲 Needs the maintainer (decision / action)
- [ ] Verify the final dashboard end-to-end (Met.no headers now show units).
- [ ] Promote `v0.0.5` from pre-release → stable ("latest") once verified, and
      decide what to do with `v0.0.4`. Non-beta HACS users only update afterwards.

## 🛠️ Can be done in this repo
- [ ] Add `"hide_default_branch": true` to `hacs.json` so HACS shows only
      releases instead of every commit.
- [ ] README: document **Weather to Sensors** as the recommended way to use a
      `weather.*` source (link + updated example using its `sensor.*` entities).
- [ ] (optional) Strategy: support an `extra` series list per chart (e.g. add
      dew point / cloud coverage to a card).
- [ ] (cleanup) The `unit:` set on `weather.[attribute]` series in the strategy
      is now redundant (real sensors are used instead) — keep (harmless) or drop.
- [ ] (optional) Refresh `dashboard.yaml` (manual Option B) — it lags the
      strategy (hard-coded Windy lat/lon, no sources), or note it as basic.

## 📦 Weather to Sensors (separate repo / new session — see its CLAUDE.md)
- [ ] Test across providers (Met.no, MeteoSwiss, OpenWeatherMap).
- [ ] Cut a stable `v0.1.0` release.
- [ ] (optional) Options flow to choose which attributes to expose.
