"""Config and options flow for the WeeWX Seasons scrape integration."""

from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_NAME, CONF_URL
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .const import (
    CONF_SCAN_INTERVAL_MINUTES,
    CONF_TIMEZONE,
    DEFAULT_NAME,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    EXAMPLE_URL,
    SCAN_INTERVAL_OPTIONS,
    USER_AGENT,
)
from .parser import WeewxParseError, normalize_url, parse_current_conditions

_LOGGER = logging.getLogger(__name__)

_REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)


async def _validate_url(hass, url: str) -> None:
    """Fetch and parse the URL once; raise on failure."""
    session = async_get_clientsession(hass)
    async with session.get(
        url, timeout=_REQUEST_TIMEOUT, headers={"User-Agent": USER_AGENT}
    ) as response:
        response.raise_for_status()
        text = await response.text()
    parse_current_conditions(text)


class WeewxScrapeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = normalize_url(user_input[CONF_URL])
            await self.async_set_unique_id(url)
            self._abort_if_unique_id_configured()
            if await dt_util.async_get_time_zone(user_input[CONF_TIMEZONE]) is None:
                errors["base"] = "invalid_timezone"
            else:
                try:
                    await _validate_url(self.hass, url)
                except (aiohttp.ClientError, TimeoutError, WeewxParseError) as err:
                    _LOGGER.debug("Validation failed for %s: %s", url, err)
                    errors["base"] = "cannot_connect"
                else:
                    name = user_input.get(CONF_NAME) or DEFAULT_NAME
                    return self.async_create_entry(
                        title=name,
                        data={
                            CONF_NAME: name,
                            CONF_URL: url,
                            CONF_SCAN_INTERVAL_MINUTES: user_input[
                                CONF_SCAN_INTERVAL_MINUTES
                            ],
                            CONF_TIMEZONE: user_input[CONF_TIMEZONE],
                        },
                    )

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default=DEFAULT_NAME): str,
                vol.Required(CONF_URL, default=EXAMPLE_URL): str,
                vol.Required(
                    CONF_SCAN_INTERVAL_MINUTES, default=DEFAULT_SCAN_INTERVAL
                ): vol.All(vol.Coerce(int), vol.In(SCAN_INTERVAL_OPTIONS)),
                vol.Required(
                    CONF_TIMEZONE, default=self.hass.config.time_zone
                ): str,
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return WeewxScrapeOptionsFlow(config_entry)


class WeewxScrapeOptionsFlow(OptionsFlow):
    """Allow changing the update interval after setup."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            if await dt_util.async_get_time_zone(user_input[CONF_TIMEZONE]) is None:
                errors["base"] = "invalid_timezone"
            else:
                return self.async_create_entry(title="", data=user_input)

        current_interval = self._entry.options.get(
            CONF_SCAN_INTERVAL_MINUTES,
            self._entry.data.get(CONF_SCAN_INTERVAL_MINUTES, DEFAULT_SCAN_INTERVAL),
        )
        current_tz = self._entry.options.get(
            CONF_TIMEZONE,
            self._entry.data.get(
                CONF_TIMEZONE, self.hass.config.time_zone
            ),
        )
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_SCAN_INTERVAL_MINUTES, default=current_interval
                ): vol.All(vol.Coerce(int), vol.In(SCAN_INTERVAL_OPTIONS)),
                vol.Required(CONF_TIMEZONE, default=current_tz): str,
            }
        )
        return self.async_show_form(
            step_id="init", data_schema=schema, errors=errors
        )
