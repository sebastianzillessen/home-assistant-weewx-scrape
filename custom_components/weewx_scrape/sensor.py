"""Sensor platform for the WeeWX Seasons scrape integration."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DEFAULT_NAME, DOMAIN, SENSORS, WeewxSensorDescription
from .coordinator import WeewxScrapeCoordinator
from .parser import ATTR_PRESSURE_TREND, ATTR_WIND_DIRECTION


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the WeeWX sensors from a config entry."""
    coordinator: WeewxScrapeCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        WeewxScrapeSensor(coordinator, entry, description) for description in SENSORS
    )


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
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.data.get(CONF_NAME) or DEFAULT_NAME,
            manufacturer="WeeWX (Seasons skin)",
            configuration_url=entry.data.get(CONF_URL),
        )

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
