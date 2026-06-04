"""Offline tests for the WeeWX Seasons HTML parser.

The parser module is loaded directly by file path so these tests run without a
Home Assistant installation.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime
from pathlib import Path

import pytest

_PARSER_PATH = (
    Path(__file__).resolve().parent.parent
    / "custom_components"
    / "weewx_scrape"
    / "parser.py"
)
_spec = importlib.util.spec_from_file_location("weewx_parser", _PARSER_PATH)
parser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(parser)

FIXTURE = (Path(__file__).resolve().parent / "fixtures" / "index.html").read_text(
    encoding="utf-8"
)


def test_parse_core_values() -> None:
    data = parser.parse_current_conditions(FIXTURE)
    assert data["outdoor_temperature"] == 14.5
    assert data["humidity"] == 50.0
    assert data["pressure"] == 1011.0
    assert data["wind_speed"] == 0.0
    assert data["rain_today"] == 0.0


def test_pressure_picks_value_not_trend() -> None:
    # "1011.0 hPa (-1.0)" -> value 1011.0, trend -1.0
    data = parser.parse_current_conditions(FIXTURE)
    assert data["pressure"] == 1011.0
    assert data["_attrs"][parser.ATTR_PRESSURE_TREND] == -1.0


def test_pressure_trend_is_a_derived_value() -> None:
    # The trend is also exposed as a top-level derived measurement.
    data = parser.parse_current_conditions(FIXTURE)
    assert data["pressure_trend"] == -1.0


def test_calm_wind_direction_is_none() -> None:
    data = parser.parse_current_conditions(FIXTURE)
    assert data["_attrs"][parser.ATTR_WIND_DIRECTION] is None


def test_calm_wind_bearing_is_none() -> None:
    # No direction -> no derived bearing.
    data = parser.parse_current_conditions(FIXTURE)
    assert data["wind_bearing"] is None


def test_wind_bearing_maps_cardinal_to_degrees() -> None:
    assert parser._wind_bearing("NW") == 315.0
    assert parser._wind_bearing("n") == 0.0
    assert parser._wind_bearing(None) is None
    # German compass spelling (Ost / Nordost) is mapped too.
    assert parser._wind_bearing("O") == 90.0
    assert parser._wind_bearing("NNO") == 22.5
    # An unknown abbreviation yields no bearing rather than a wrong one.
    assert parser._wind_bearing("XYZ") is None


def test_wind_bearing_prefers_exact_degrees() -> None:
    # "0.4 m/s WNW (292°)" -> direction WNW, bearing the exact 292 (not 292.5).
    html = (
        "<div id='current_widget'><table>"
        '<tr><td class="label">Wind</td>'
        '<td class="data">0.4 m/s WNW (292&#176;)</td></tr>'
        "</table></div>"
    )
    data = parser.parse_current_conditions(html)
    assert data["_attrs"][parser.ATTR_WIND_DIRECTION] == "WNW"
    assert data["wind_bearing"] == 292.0


def test_wind_bearing_falls_back_to_cardinal_without_degrees() -> None:
    html = (
        "<div id='current_widget'><table>"
        '<tr><td class="label">Wind</td>'
        '<td class="data">3.0 m/s NW</td></tr>'
        "</table></div>"
    )
    data = parser.parse_current_conditions(html)
    assert data["wind_bearing"] == 315.0


def test_parse_location_degrees_decimal_minutes() -> None:
    page = (
        "<tr><td>geogr. Breite</td><td>46&deg; 55.96' N</td></tr>"
        "<tr><td>geogr. L&auml;nge</td><td>009&deg; 45.06' O</td></tr>"
    )
    lat, lon = parser.parse_location(page)
    assert lat == pytest.approx(46.93267, abs=1e-4)
    assert lon == pytest.approx(9.751, abs=1e-4)


def test_parse_location_southern_western_hemisphere() -> None:
    lat, lon = parser.parse_location("12° 30.0' S 045° 15.0' W")
    assert lat == pytest.approx(-12.5)
    assert lon == pytest.approx(-45.25)


def test_parse_location_absent_returns_none() -> None:
    assert parser.parse_location("no coordinates on this page") == (None, None)


def test_station_time_attribute() -> None:
    data = parser.parse_current_conditions(FIXTURE)
    assert data["_attrs"][parser.ATTR_STATION_TIME] == (
        "Aktuelle Wetterdaten vom 04/06/26 10:00:00"
    )


def test_hilo_table_not_matched() -> None:
    # The high/low table below also has an "Außentemperatur" row (20.1) which
    # must NOT override the current value (14.5).
    data = parser.parse_current_conditions(FIXTURE)
    assert data["outdoor_temperature"] == 14.5


def test_english_labels_supported() -> None:
    html = (
        "<div id='current_widget'><table>"
        '<tr><td class="label">Outside Temperature</td>'
        '<td class="data">7.2&#176;C</td></tr>'
        '<tr><td class="label">Barometer</td>'
        '<td class="data">1004.0 hPa</td></tr>'
        '<tr><td class="label">Wind</td>'
        '<td class="data">3.1 m/s NW ( 315&#176;)</td></tr>'
        "</table></div>"
    )
    data = parser.parse_current_conditions(html)
    assert data["outdoor_temperature"] == 7.2
    assert data["pressure"] == 1004.0
    assert data["wind_speed"] == 3.1
    assert data["_attrs"][parser.ATTR_WIND_DIRECTION] == "NW"
    assert data["wind_bearing"] == 315.0
    # No parenthesised pressure change in this page -> no trend.
    assert data["pressure_trend"] is None


def test_missing_widget_raises() -> None:
    with pytest.raises(parser.WeewxParseError):
        parser.parse_current_conditions("<html><body>nothing here</body></html>")


def test_station_datetime_from_fixture() -> None:
    data = parser.parse_current_conditions(FIXTURE)
    raw = data["_attrs"][parser.ATTR_STATION_TIME]
    # "...vom 04/06/26 10:00:00" -> 4 June 2026, naive (no tz on the page).
    assert parser.parse_station_datetime(raw) == datetime(2026, 6, 4, 10, 0, 0)


def test_station_datetime_disambiguates_day_month() -> None:
    # Day > 12 forces DD/MM; otherwise DD/MM is assumed.
    assert parser.parse_station_datetime("15/06/26 09:30:00") == datetime(
        2026, 6, 15, 9, 30, 0
    )
    # Month-position > 12 forces MM/DD (e.g. a US-formatted station).
    assert parser.parse_station_datetime("06/15/2026 09:30") == datetime(
        2026, 6, 15, 9, 30, 0
    )


def test_station_datetime_missing_returns_none() -> None:
    assert parser.parse_station_datetime(None) is None
    assert parser.parse_station_datetime("no timestamp here") is None


def test_normalize_url() -> None:
    assert parser.normalize_url("pany.gr") == "https://pany.gr/index.html"
    assert parser.normalize_url("https://pany.gr/") == "https://pany.gr/index.html"
    assert (
        parser.normalize_url("https://example.com/weewx/")
        == "https://example.com/weewx/index.html"
    )
    assert (
        parser.normalize_url("https://example.com/wx/index.html")
        == "https://example.com/wx/index.html"
    )
