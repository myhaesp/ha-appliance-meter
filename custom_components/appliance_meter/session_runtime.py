"""Optional HA observer: own Store/listeners; never writes totals, helpers or devices."""
import asyncio
from datetime import datetime, timedelta
import logging
import json
from pathlib import Path

from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import callback
from homeassistant.helpers.event import (
    async_track_state_change_event, async_track_state_report_event, async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, CONF_POWER, CONF_ENERGY, CONF_PRICE, settings
from .sessions import ALGORITHM, SessionEngine
from .session_pricing import decimal

_LOGGER = logging.getLogger(__name__)


def _check_session_file(filename):
    """Prevent HA Store's corrupt-JSON clean-slate recovery for this ledger.

    A missing first-install file is fine. An unreadable/future/corrupt existing
    ledger needs explicit recovery, not a new empty history. All I/O is read-only.
    """
    path = Path(filename)
    if not path.exists():
        if next(path.parent.glob(path.name + ".corrupt.*"), None) is not None:
            raise ValueError("A corrupt session ledger needs explicit recovery")
        return
    stored = json.loads(path.read_bytes())
    if (not isinstance(stored, dict) or not isinstance(stored.get("data"), dict)
            or not isinstance(stored["data"].get("engine"), dict)
            or stored["data"]["engine"].get("algorithm") != ALGORITHM):
        raise ValueError("Invalid or unsupported existing session ledger")


class SessionStore(Store):
    async def async_load(self):
        await self.hass.async_add_executor_job(_check_session_file, self.path)
        return await super().async_load()


def session_store(hass, entry):
    return SessionStore(hass, 1, f"{DOMAIN}.sessions.{entry.entry_id}", atomic_writes=True,
                        serialize_in_event_loop=False)


def timestamp(value):
    # HA state attributes may contain native datetimes; WebSocket/Recorder JSON
    # serializes those same values to ISO strings. Accept both representations.
    parsed = value if isinstance(value, datetime) else dt_util.parse_datetime(value) if isinstance(value, str) else None
    return parsed.timestamp() if parsed is not None and parsed.tzinfo is not None else None


class SessionObserver:
    """Opt-in shadow observation. It has no action/service/control interface."""

    def __init__(self, hass, entry, currency):
        self.hass, self.entry, self.currency = hass, entry, currency
        self.config = dict(settings(entry))
        self.store = session_store(hass, entry)
        self.engine = SessionEngine(self.config["session_profile"], energy_source=bool(self.config.get(CONF_ENERGY)),
                                    currency=currency, sources={key: self.config.get(key) for key in (CONF_POWER, CONF_ENERGY, CONF_PRICE)})
        self.context = {key: self.config.get(key) for key in (
            "session_profile", CONF_POWER, CONF_ENERGY, CONF_PRICE)}
        self.context["currency"] = currency
        self.listeners = set()
        self.unsubscribers = []
        self.closed = False
        self._pending = False
        self._lock = asyncio.Lock()
        self._last_energy_report = None
        self.error = None
        self._loaded = False

    def snapshot(self):
        return {"context": self.context, "currency": self.currency, "engine": self.engine.snapshot()}

    @callback
    def _saved_snapshot(self):
        self._pending = False
        return self.snapshot()

    async def async_start(self):
        try:
            await self._start()
        except Exception:
            # Observer failure must not take the established four accounting
            # sensors down or overwrite an unreadable/future session store.
            self.error = "session_storage_unavailable"
            self.closed = True
            for unsubscribe in self.unsubscribers:
                unsubscribe()
            self.unsubscribers.clear()
            _LOGGER.exception("Session observation disabled; existing accounting remains active")

    async def _start(self):
        saved = await self.store.async_load()
        now = dt_util.utcnow().timestamp()
        if saved:
            old = SessionEngine.restore(saved["engine"])
            if saved["context"] != self.context:
                old.interrupt(now, "configuration_changed")
                self.engine.records = old.records
            else:
                self.engine = old
                self.engine.resume(now)
        self._read_price(self._state(CONF_PRICE), now)
        self._read_energy(self._state(CONF_ENERGY), now)
        self._read_power(self._state(CONF_POWER), now)
        sources = [self.config[key] for key in (CONF_POWER, CONF_ENERGY, CONF_PRICE) if self.config.get(key)]
        self.unsubscribers.extend([
            async_track_state_change_event(self.hass, sources, self._changed),
            async_track_state_report_event(self.hass, sources, self._changed),
            async_track_time_interval(self.hass, self._tick, timedelta(seconds=5)),
            self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, self._shutdown),
        ])
        await self.store.async_save(self.snapshot())
        self._loaded = True

    def _state(self, key):
        return self.hass.states.get(self.config[key]) if self.config.get(key) else None

    def _valid(self, state, at):
        return (state is not None and not state.attributes.get("restored")
                and decimal(state.state) is not None
                and 0 <= at - state.last_reported.timestamp() <= 90)

    def _read_power(self, state, at):
        factor = {"W": 1, "kW": 1000}.get(state.attributes.get("unit_of_measurement")) if state else None
        value = decimal(state.state) * factor if factor and self._valid(state, at) else None
        self.engine.on_power(at, value)

    def _read_energy(self, state, at):
        if not self.config.get(CONF_ENERGY):
            return
        factor = {"Wh": decimal("0.001"), "kWh": decimal(1)}.get(state.attributes.get("unit_of_measurement")) if state else None
        value = decimal(state.state) * factor if factor and self._valid(state, at) else None
        # Tick settlement needs fresh reports, not repeated reads of a stale state.
        report = (state.last_reported.timestamp(), state.state, factor) if state else None
        if report != self._last_energy_report:
            self.engine.on_energy(at, value)
            self._last_energy_report = report

    def _read_price(self, state, at):
        if state is None or state.attributes.get("restored"):
            return
        units = {f"{self.currency}/kWh"}
        if self.currency == "DKK":
            units.add("kr/kWh")
        if state.attributes.get("unit_of_measurement") not in units:
            return
        # Only the selected sensor's actual interval rows. Forecast feeds and
        # explicitly forecast rows are never a historical accounting source.
        if state.attributes.get("forecast_data") or state.attributes.get("forecast"):
            return
        added = False
        rows = state.attributes.get("prices", [])
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict) or row.get("forecast") or row.get("forecast_data"):
                    continue
                start, end = timestamp(row.get("start")), timestamp(row.get("end"))
                if start is not None and end is not None:
                    added |= self.engine.prices.add(start, end, row.get("price"))
        if not added and self._valid(state, at):
            # Scalar fallback is a bounded observation from NOW, never an
            # inference about consumption before observer startup/recovery.
            end = (int(at // 900) + 1) * 900
            self.engine.prices.add(at, end, state.state, provenance="observed_scalar")

    @callback
    def _changed(self, event):
        if self.closed:
            return
        at = event.time_fired.timestamp()
        entity = event.data["entity_id"]
        state = event.data.get("new_state")
        if entity == self.config.get(CONF_PRICE):
            self._read_price(state, at)
        if entity == self.config.get(CONF_ENERGY):
            self._read_energy(state, at)
        if entity == self.config.get(CONF_POWER):
            self._read_power(state, at)
        self._schedule()

    @callback
    def _tick(self, now):
        if self.closed:
            return
        at = now.timestamp()
        self._read_energy(self._state(CONF_ENERGY), at)
        self._read_power(self._state(CONF_POWER), at)
        self._schedule()

    def _schedule(self):
        if not self._pending:
            self._pending = True
            self.store.async_delay_save(self._saved_snapshot, 30)
        for listener in tuple(self.listeners):
            listener()

    async def _shutdown(self, _event):
        await self.async_close()

    async def async_close(self):
        async with self._lock:
            if self.closed:
                return
            self.closed = True
            for unsubscribe in self.unsubscribers:
                unsubscribe()
            self.unsubscribers.clear()
            if self._loaded:
                await self.store.async_save(self.snapshot())
            self._pending = False

    def view(self, *, offset=0, limit=50):
        """Deep copied, paginated, administrator-only ledger projection."""
        from copy import deepcopy
        return {"mode": "shadow", "profile": self.engine.profile, "currency": self.currency,
                "state": "storage_error" if self.error else self.engine.state, "error": self.error, "active": deepcopy(self.engine.active),
                "total": len(self.engine.records), "offset": offset,
                "sessions": deepcopy(list(reversed(self.engine.records))[offset:offset + limit])}
