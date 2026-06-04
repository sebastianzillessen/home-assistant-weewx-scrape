"""The WeeWX Seasons scrape integration."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import (
    CONF_SCAN_INTERVAL_MINUTES,
    CONF_TIMEZONE,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)
from .coordinator import WeewxScrapeCoordinator
from .frontend import async_register_strategy

PLATFORMS: list[Platform] = [Platform.SENSOR]


def _scan_interval(entry: ConfigEntry) -> int:
    return entry.options.get(
        CONF_SCAN_INTERVAL_MINUTES,
        entry.data.get(CONF_SCAN_INTERVAL_MINUTES, DEFAULT_SCAN_INTERVAL),
    )


def _timezone_name(hass: HomeAssistant, entry: ConfigEntry) -> str:
    """Resolve the station timezone: option, then data, then HA's own tz."""
    return (
        entry.options.get(CONF_TIMEZONE)
        or entry.data.get(CONF_TIMEZONE)
        or hass.config.time_zone
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up WeeWX Seasons scrape from a config entry."""
    tz_name = _timezone_name(hass, entry)
    station_tz = await dt_util.async_get_time_zone(tz_name)
    if station_tz is None:
        # Configured name no longer resolvable; fall back to HA's timezone.
        station_tz = await dt_util.async_get_time_zone(hass.config.time_zone)

    coordinator = WeewxScrapeCoordinator(
        hass, entry.data[CONF_URL], _scan_interval(entry), station_tz
    )
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await async_register_strategy(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when options (e.g. scan interval) change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok
