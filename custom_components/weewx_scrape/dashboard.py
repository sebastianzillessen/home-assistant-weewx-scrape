"""Register the WeeWX dashboard-strategy JS module with the frontend.

The strategy lets users create a weather dashboard with just::

    strategy:
      type: custom:weewx-seasons

Shipping it with the integration (rather than as a separate HACS plugin) means
it is available as soon as the integration is installed — no Lovelace resource
to register by hand. We serve the file statically and load it as a frontend ES
module so its strategy element registers itself.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

STRATEGY_FILENAME = "weewx-seasons-strategy.js"
STRATEGY_URL = f"/{DOMAIN}/{STRATEGY_FILENAME}"
_REGISTERED_KEY = f"{DOMAIN}_frontend_registered"


async def async_register_strategy(hass: HomeAssistant) -> None:
    """Serve and load the dashboard-strategy module once per HA instance."""
    if hass.data.get(_REGISTERED_KEY):
        return
    # Set the flag up front so a failure does not leave a half-registered static
    # path that a retry would reject; the strategy is non-essential to the
    # integration's core function.
    hass.data[_REGISTERED_KEY] = True

    source = Path(__file__).parent / "frontend" / STRATEGY_FILENAME
    try:
        # Prefer the async API (HA 2024.7+); fall back to the sync one on older
        # cores.
        try:
            from homeassistant.components.http import StaticPathConfig

            await hass.http.async_register_static_paths(
                [StaticPathConfig(STRATEGY_URL, str(source), False)]
            )
        except ImportError:
            hass.http.register_static_path(
                STRATEGY_URL, str(source), cache_headers=False
            )

        # Cache-bust on version bumps so browsers pick up an updated strategy.
        integration = await async_get_integration(hass, DOMAIN)
        versioned_url = f"{STRATEGY_URL}?v={integration.version}"
        add_extra_js_url(hass, versioned_url)
        _LOGGER.debug("Registered WeeWX dashboard strategy at %s", versioned_url)
    except Exception:  # noqa: BLE001 - never block setup over the dashboard helper
        _LOGGER.warning(
            "Could not register the WeeWX dashboard strategy", exc_info=True
        )
