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

from .const import (
    CONF_SCAN_INTERVAL_MINUTES,
    DEFAULT_NAME,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    EXAMPLE_URL,
    SCAN_INTERVAL_OPTIONS,
)
from .parser import WeewxParseError, normalize_url, parse_current_conditions

_LOGGER = logging.getLogger(__name__)

_REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)


async def _validate_url(hass, url: str) -> None:
    """Fetch and parse the URL once; raise on failure."""
    session = async_get_clientsession(hass)
    async with session.get(url, timeout=_REQUEST_TIMEOUT) as response:
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
                    },
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default=DEFAULT_NAME): str,
                vol.Required(CONF_URL, default=EXAMPLE_URL): str,
                vol.Required(
                    CONF_SCAN_INTERVAL_MINUTES, default=DEFAULT_SCAN_INTERVAL
                ): vol.In(SCAN_INTERVAL_OPTIONS),
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
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = self._entry.options.get(
            CONF_SCAN_INTERVAL_MINUTES,
            self._entry.data.get(CONF_SCAN_INTERVAL_MINUTES, DEFAULT_SCAN_INTERVAL),
        )
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_SCAN_INTERVAL_MINUTES, default=current
                ): vol.In(SCAN_INTERVAL_OPTIONS),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
