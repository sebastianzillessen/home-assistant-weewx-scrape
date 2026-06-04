"""Sensor platform for the WeeWX Seasons scrape integration."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DEFAULT_NAME, DOMAIN, SENSORS, WeewxSensorDescription
from .coordinator import WeewxScrapeCoordinator
from .parser import (
    ATTR_LATITUDE,
    ATTR_LONGITUDE,
    ATTR_PRESSURE_TREND,
    ATTR_WIND_DIRECTION,
)


def _device_info(entry: ConfigEntry) -> DeviceInfo:
    """Shared device for every entity of a station config entry."""
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name=entry.data.get(CONF_NAME) or DEFAULT_NAME,
        manufacturer="WeeWX (Seasons skin)",
        configuration_url=entry.data.get(CONF_URL),
    )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the WeeWX sensors from a config entry."""
    coordinator: WeewxScrapeCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SensorEntity] = [
        WeewxScrapeSensor(coordinator, entry, description) for description in SENSORS
    ]
    entities.append(WeewxStationTimeSensor(coordinator, entry))
    async_add_entities(entities)


class WeewxScrapeSensor(CoordinatorEntity[WeewxScrapeCoordinator], SensorEntity):
    """A single measurement scraped from the WeeWX page."""

    _attr_has_entity_name = True
    entity_description: WeewxSensorDescription

    def __init__(
        self,
        coordinator: WeewxScrapeCoordinator,
        entry: ConfigEntry,
        description: WeewxSensorDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = _device_info(entry)

    @property
    def native_value(self) -> float | None:
        """Return the parsed value for this measurement."""
        return self.coordinator.data.get(self.entity_description.key)

    @property
    def extra_state_attributes(self) -> dict | None:
        """Expose wind direction / pressure trend as attributes."""
        attrs: dict = self.coordinator.data.get("_attrs", {})
        key = self.entity_description.key
        if key == "wind_speed" and attrs.get(ATTR_WIND_DIRECTION) is not None:
            return {"direction": attrs[ATTR_WIND_DIRECTION]}
        if key == "pressure" and attrs.get(ATTR_PRESSURE_TREND) is not None:
            return {"trend": attrs[ATTR_PRESSURE_TREND]}
        return None


class WeewxStationTimeSensor(CoordinatorEntity[WeewxScrapeCoordinator], SensorEntity):
    """The station's own reading timestamp ("data as of recording")."""

    _attr_has_entity_name = True
    _attr_translation_key = "station_time"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(
        self,
        coordinator: WeewxScrapeCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_station_time"
        self._attr_device_info = _device_info(entry)

    @property
    def native_value(self) -> datetime | None:
        """Return the timezone-aware station reading time, if available."""
        return self.coordinator.data.get("station_datetime")

    @property
    def extra_state_attributes(self) -> dict | None:
        """Expose the station's scraped coordinates, if the page shows them."""
        attrs: dict = self.coordinator.data.get("_attrs", {})
        out = {
            key: attrs[key]
            for key in (ATTR_LATITUDE, ATTR_LONGITUDE)
            if attrs.get(key) is not None
        }
        return out or None
