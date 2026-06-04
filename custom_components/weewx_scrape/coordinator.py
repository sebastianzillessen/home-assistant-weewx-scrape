"""Data update coordinator that fetches and parses a WeeWX Seasons page."""

from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN
from .parser import WeewxParseError, normalize_url, parse_current_conditions

_LOGGER = logging.getLogger(__name__)

_REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)


class WeewxScrapeCoordinator(DataUpdateCoordinator[dict]):
    """Fetch the station page on an interval and expose parsed measurements."""

    def __init__(
        self,
        hass: HomeAssistant,
        url: str,
        scan_interval: int,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=scan_interval),
        )
        self._url = normalize_url(url)
        self._session = async_get_clientsession(hass)

    async def _async_update_data(self) -> dict:
        try:
            async with self._session.get(
                self._url, timeout=_REQUEST_TIMEOUT
            ) as response:
                response.raise_for_status()
                text = await response.text()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise UpdateFailed(f"Error fetching {self._url}: {err}") from err

        try:
            return parse_current_conditions(text)
        except WeewxParseError as err:
            raise UpdateFailed(f"Could not parse {self._url}: {err}") from err
