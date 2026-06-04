"""Constants and sensor definitions for the WeeWX Seasons scrape integration."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import (
    PERCENTAGE,
    UnitOfPrecipitationDepth,
    UnitOfPressure,
    UnitOfSpeed,
    UnitOfTemperature,
)

from .parser import SENSOR_ALIASES

DOMAIN = "weewx_scrape"

# Config keys (CONF_NAME / CONF_URL come from homeassistant.const).
CONF_SCAN_INTERVAL_MINUTES = "scan_interval"
# IANA timezone applied to the station's (tz-naive) reading time. Defaults to
# Home Assistant's own configured timezone.
CONF_TIMEZONE = "timezone"

DEFAULT_NAME = "WeeWX Weather"
EXAMPLE_URL = "https://pany.gr/"

SCAN_INTERVAL_OPTIONS = [5, 10, 15, 60]
DEFAULT_SCAN_INTERVAL = 10


@dataclass(frozen=True, kw_only=True)
class WeewxSensorDescription(SensorEntityDescription):
    """Sensor description for a parsed WeeWX measurement."""


# Presentation metadata, keyed by the measurement keys defined in parser.py.
SENSORS: tuple[WeewxSensorDescription, ...] = (
    WeewxSensorDescription(
        key="outdoor_temperature",
        translation_key="outdoor_temperature",
        device_class=SensorDeviceClass.TEMPERATURE,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    WeewxSensorDescription(
        key="humidity",
        translation_key="humidity",
        device_class=SensorDeviceClass.HUMIDITY,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    WeewxSensorDescription(
        key="pressure",
        translation_key="pressure",
        device_class=SensorDeviceClass.ATMOSPHERIC_PRESSURE,
        native_unit_of_measurement=UnitOfPressure.HPA,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    WeewxSensorDescription(
        key="wind_speed",
        translation_key="wind_speed",
        device_class=SensorDeviceClass.WIND_SPEED,
        native_unit_of_measurement=UnitOfSpeed.METERS_PER_SECOND,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    WeewxSensorDescription(
        key="rain_today",
        translation_key="rain_today",
        device_class=SensorDeviceClass.PRECIPITATION,
        native_unit_of_measurement=UnitOfPrecipitationDepth.MILLIMETERS,
        state_class=SensorStateClass.TOTAL_INCREASING,
    ),
)

# Guard against the parser and presentation drifting apart.
assert {desc.key for desc in SENSORS} == set(SENSOR_ALIASES), (
    "SENSORS in const.py and SENSOR_ALIASES in parser.py must define the same keys"
)
