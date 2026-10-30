"""Persistent consumption accounting, independent of logical entity lifetimes."""
import asyncio
from collections import deque
from decimal import Decimal, InvalidOperation

from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import CONF_ENERGY, CONF_PRICE, DOMAIN, settings

SAVE_DELAY = 30


def accounting_store(hass, entry):
    """Use the same per-entry key for loading and permanent deletion."""
    return Store(hass, 1, f"{DOMAIN}.{entry.entry_id}", atomic_writes=True)


def number(value):
    """Accept finite numeric values only."""
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        return None
    return result if result.is_finite() else None


class Accounting:
    """Count each physical delta once and retain the last valid baseline."""

    def __init__(self, hass, entry):
        self.hass = hass
        self.source = settings(entry).get(CONF_ENERGY)
        self.price_source = settings(entry).get(CONF_PRICE)
        self.store = accounting_store(hass, entry)
        self.currency = hass.config.currency or "DKK"
        self.values = dict.fromkeys(("energy_total", "cost_total", "unpriced_energy"), Decimal(0))
        self.cost_calculations = deque(maxlen=10)
        self.last = None
        self._save_pending = False
        self.price_state = hass.states.get(self.price_source) if self.price_source else None
        self.listeners = set()
        self.unsubscribers = []
        self._stop_unsubscribe = None
        self._lifecycle_lock = asyncio.Lock()
        self._started = False
        self._closed = False

    def snapshot(self):
        return {"currency": self.currency, "source": self.source, "last": str(self.last) if self.last is not None else None,
                **{key: str(value) for key, value in self.values.items()}}

    @callback
    def _delayed_snapshot(self):
        self._save_pending = False
        return self.snapshot()

    async def async_start(self):
        async with self._lifecycle_lock:
            if self._started or self._closed:
                return
            saved = await self.store.async_load()
            if saved:
                # Stores written before currency support contain DKK totals.
                self.currency = saved.get("currency", "DKK")
                for key in self.values:
                    value = number(saved.get(key))
                    if value is not None:
                        self.values[key] = value
                if saved.get("source") == self.source:
                    self.last = number(saved.get("last"))
            self.price_state = self.hass.states.get(self.price_source) if self.price_source else None
            sources = {source for source in (self.source, self.price_source) if source}
            if sources:
                self.unsubscribers.append(async_track_state_change_event(
                    self.hass, sources, self._changed))
            self._stop_unsubscribe = self.hass.bus.async_listen_once(
                EVENT_HOMEASSISTANT_STOP, self._shutdown)
            self.read(self.hass.states.get(self.source) if self.source else None)
            # Commit startup recovery and assignment changes before exposing entities.
            await self.store.async_save(self.snapshot())
            self._save_pending = False
            self._started = True

    @callback
    def _changed(self, event):
        if event.data["entity_id"] == self.price_source:
            self.price_state = event.data.get("new_state")
        if event.data["entity_id"] != self.source:
            return
        # Use the event's reading: fetching current state can skip queued updates.
        if self.read(event.data.get("new_state")):
            if not self._save_pending:
                self._save_pending = True
                self.store.async_delay_save(self._delayed_snapshot, SAVE_DELAY)
            for listener in tuple(self.listeners):
                listener()

    @callback
    def read(self, state):
        if state is None or state.attributes.get("restored"):
            return False
        value = number(state.state)
        factor = {"Wh": Decimal("0.001"), "kWh": Decimal(1)}.get(
            state.attributes.get("unit_of_measurement"))
        if value is None or value < 0 or factor is None:
            return False
        value *= factor
        previous = self.last
        if previous == value:
            return False
        self.last = value
        if previous is None or value < previous:
            return True
        delta = value - previous
        self.values["energy_total"] += delta
        price_state = self.price_state
        price = number(price_state.state) if price_state else None
        units = {f"{self.currency}/kWh"}
        if self.currency == "DKK":
            units.add("kr/kWh")
        if price_state and (price_state.attributes.get("restored")
                            or price_state.attributes.get("unit_of_measurement") not in units):
            price = None
        increment = Decimal(0) if price is None else delta * price
        if price is None:
            self.values["unpriced_energy"] += delta
        else:
            self.values["cost_total"] += increment
        # Volatile diagnostics: capture the actual operands, never re-read sensors.
        self.cost_calculations.append({
            "timestamp": dt_util.utcnow().isoformat(),
            "energy_delta": str(delta),
            "price": str(price) if price is not None else None,
            "cost_increment": str(increment),
        })
        return True

    async def _shutdown(self, event):
        # HA removes a one-time listener before invoking its callback.
        self._stop_unsubscribe = None
        await self.async_close()

    async def async_close(self):
        """Stop callbacks before flushing; async_save cancels a delayed save."""
        async with self._lifecycle_lock:
            if self._closed:
                return
            if self._stop_unsubscribe is not None:
                unsubscribe, self._stop_unsubscribe = self._stop_unsubscribe, None
                unsubscribe()
            unsubscribers, self.unsubscribers = self.unsubscribers, []
            for unsubscribe in unsubscribers:
                unsubscribe()
            await self.store.async_save(self.snapshot())
            self._save_pending = False
            self._closed = True
