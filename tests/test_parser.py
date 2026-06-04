"""Offline tests for the WeeWX Seasons HTML parser.

The parser module is loaded directly by file path so these tests run without a
Home Assistant installation.
"""

from __future__ import annotations

import importlib.util
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


def test_calm_wind_direction_is_none() -> None:
    data = parser.parse_current_conditions(FIXTURE)
    assert data["_attrs"][parser.ATTR_WIND_DIRECTION] is None


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


def test_missing_widget_raises() -> None:
    with pytest.raises(parser.WeewxParseError):
        parser.parse_current_conditions("<html><body>nothing here</body></html>")


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
