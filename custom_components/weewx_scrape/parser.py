"""Pure-Python parser for WeeWX "Seasons" skin current-conditions HTML.

This module deliberately has **no Home Assistant imports** so the scraping logic
can be unit-tested standalone and reused. It extracts the values shown in the
``current_widget`` table of a WeeWX Seasons ``index.html`` page.

The Seasons skin is rendered in the station owner's language, so each
measurement is matched against a list of known label aliases (German + English).
"""

from __future__ import annotations

import html
import re
from datetime import datetime
from urllib.parse import urlparse, urlunparse

# Measurement key -> labels that may appear in the "label" cell (lower-cased,
# tag-stripped, HTML-unescaped). Extend this to support more languages.
SENSOR_ALIASES: dict[str, tuple[str, ...]] = {
    "outdoor_temperature": (
        "außentemperatur",
        "aussentemperatur",
        "outside temperature",
        "outdoor temperature",
    ),
    "humidity": ("luftfeuchte", "humidity", "outside humidity"),
    "pressure": ("luftdruck", "barometer", "pressure"),
    "wind_speed": ("wind",),
    "rain_today": ("regen heute", "rain today", "rain"),
}

# Measurements the parser *derives* from a scraped value's extras rather than
# matching against a page label: the numeric wind bearing (from the cardinal
# direction) and the pressure trend (from the parenthesised change). They are
# emitted as top-level keys in the parsed data alongside the scraped ones.
DERIVED_KEYS: tuple[str, ...] = ("wind_bearing", "pressure_trend")

# Attribute keys exposed on the relevant entities.
ATTR_WIND_DIRECTION = "wind_direction"
ATTR_PRESSURE_TREND = "pressure_trend"
ATTR_STATION_TIME = "station_time"

_ALIAS_TO_KEY: dict[str, str] = {
    alias: key for key, aliases in SENSOR_ALIASES.items() for alias in aliases
}

# Cardinal compass abbreviations to degrees (0–360). The Seasons skin prints the
# wind direction as a localised abbreviation after the speed, so both English
# (N/E/S/W) and German (N/O/S/W, e.g. "NNO", "OSO") spellings are mapped.
_CARDINAL_TO_DEGREES: dict[str, float] = {
    "N": 0.0,
    "NNE": 22.5, "NNO": 22.5,
    "NE": 45.0, "NO": 45.0,
    "ENE": 67.5, "ONO": 67.5,
    "E": 90.0, "O": 90.0,
    "ESE": 112.5, "OSO": 112.5,
    "SE": 135.0, "SO": 135.0,
    "SSE": 157.5, "SSO": 157.5,
    "S": 180.0,
    "SSW": 202.5,
    "SW": 225.0,
    "WSW": 247.5,
    "W": 270.0,
    "WNW": 292.5,
    "NW": 315.0,
    "NNW": 337.5,
}

# Slice from the current_widget marker up to the end of its table so the
# high/low table further down the page is never matched.
_CURRENT_WIDGET_RE = re.compile(
    r"id=['\"]current_widget['\"].*?</table>", re.IGNORECASE | re.DOTALL
)
_ROW_RE = re.compile(
    r'<td class="label">(.*?)</td>\s*<td class="data">(.*?)</td>',
    re.IGNORECASE | re.DOTALL,
)
_LASTUPDATE_RE = re.compile(r'class="lastupdate"[^>]*>(.*?)</p>', re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
_WIND_DIR_RE = re.compile(r"m/s\s+([^\s(]+)", re.IGNORECASE)
_TREND_RE = re.compile(r"\(\s*([-+]?\d+(?:\.\d+)?)\s*\)")
# A "DD/MM/YY HH:MM[:SS]" stamp inside the lastupdate text. Separator may be
# "/" or "."; year may be 2- or 4-digit; seconds optional.
_STATION_DT_RE = re.compile(
    r"(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?"
)


class WeewxParseError(Exception):
    """Raised when the current-conditions widget cannot be found/parsed."""


def normalize_url(url: str) -> str:
    """Return a fetchable URL, defaulting an empty path to ``/index.html``."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    parsed = urlparse(url)
    path = parsed.path
    if path in ("", "/"):
        path = "/index.html"
    elif path.endswith("/"):
        path = path + "index.html"
    return urlunparse(parsed._replace(path=path))


def _clean(text: str) -> str:
    """Strip nested tags, unescape HTML entities and trim whitespace."""
    return html.unescape(_TAG_RE.sub("", text)).strip()


def _first_number(text: str) -> float | None:
    match = _NUMBER_RE.search(text)
    return float(match.group()) if match else None


def _wind_direction(text: str) -> str | None:
    match = _WIND_DIR_RE.search(text)
    if not match:
        return None
    direction = match.group(1).strip()
    return None if direction.upper() in ("N/A", "---", "") else direction


def _wind_bearing(direction: str | None) -> float | None:
    """Map a cardinal wind-direction abbreviation to degrees (0–360)."""
    if direction is None:
        return None
    return _CARDINAL_TO_DEGREES.get(direction.upper())


def _pressure_trend(text: str) -> float | None:
    match = _TREND_RE.search(text)
    return float(match.group(1)) if match else None


def parse_station_datetime(raw: str | None) -> datetime | None:
    """Extract the station's reading time as a *naive* ``datetime``.

    The Seasons skin prints the timestamp without a timezone, so the result is
    naive — the caller attaches the configured timezone. Day/month order is
    ambiguous in the skin: a component > 12 disambiguates it, otherwise
    ``DD/MM`` is assumed (the common Seasons locale). Returns ``None`` if no
    timestamp is found.
    """
    if not raw:
        return None
    match = _STATION_DT_RE.search(raw)
    if not match:
        return None
    first, second, year, hour, minute, sec = match.groups()
    first, second = int(first), int(second)
    if first > 12:
        day, month = first, second
    elif second > 12:
        day, month = second, first
    else:
        day, month = first, second  # ambiguous -> DD/MM
    year = int(year)
    if year < 100:
        year += 2000
    try:
        return datetime(year, month, day, int(hour), int(minute), int(sec or 0))
    except ValueError:
        return None


def parse_current_conditions(page: str) -> dict:
    """Parse a WeeWX Seasons page into ``{measurement_key: value, "_attrs": {}}``.

    Raises :class:`WeewxParseError` if the ``current_widget`` table is missing,
    which signals an unsupported page or a station that is offline.
    """
    widget = _CURRENT_WIDGET_RE.search(page)
    if not widget:
        raise WeewxParseError("current_widget table not found on page")

    block = widget.group()
    data: dict = {}
    attrs: dict = {}

    for raw_label, raw_value in _ROW_RE.findall(block):
        label = _clean(raw_label).lower()
        value = _clean(raw_value)
        key = _ALIAS_TO_KEY.get(label)
        if key is None:
            continue
        data[key] = _first_number(value)
        if key == "wind_speed":
            direction = _wind_direction(value)
            attrs[ATTR_WIND_DIRECTION] = direction
            data["wind_bearing"] = _wind_bearing(direction)
        elif key == "pressure":
            trend = _pressure_trend(value)
            attrs[ATTR_PRESSURE_TREND] = trend
            data["pressure_trend"] = trend

    if not data:
        raise WeewxParseError("no known measurements found in current_widget")

    updates = [_clean(m) for m in _LASTUPDATE_RE.findall(page)]
    updates = [u for u in updates if u]
    if updates:
        # The last "lastupdate" paragraph holds the observation timestamp.
        attrs[ATTR_STATION_TIME] = updates[-1]

    data["_attrs"] = attrs
    return data
