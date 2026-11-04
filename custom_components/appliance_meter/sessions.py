"""Read-only session detection; pure deterministic engine, separate from accounting.

Times are UTC Unix seconds. Public records use Decimal strings. Detection profiles
are reference-calibrated hypotheses, not appliance firmware program signals.
"""
from bisect import bisect_right
from copy import deepcopy
from decimal import Decimal
from uuid import uuid4

from .session_pricing import PriceBook, decimal

PROFILES = ("washing_machine", "tumble_dryer", "dishwasher")
ALGORITHM = 1
MAX_SAMPLES = 100_000
SETTLE_SECONDS = 90


def segments(points, start, end):
    """Left sample hold, including explicit unknown spans. No implicit zero fill."""
    if end <= start:
        return
    previous = None
    cursor = start
    anchor = max(0, bisect_right(points, start, key=lambda point: point[0]) - 1)
    for at, value in points[anchor:]:
        if at <= start:
            previous = value
            continue
        if at >= end:
            break
        yield cursor, at, previous
        cursor, previous = at, value
    yield cursor, end, previous


def integral(points, start, end):
    known = Decimal(0)
    unknown = 0.0
    for left, right, value in segments(points, start, end):
        if value is None:
            unknown += right - left
        else:
            known += max(Decimal(0), decimal(value)) * Decimal(str(right - left)) / Decimal(3_600_000)
    return known, unknown


def trim(points, earliest):
    """Keep the anchor preceding a window as well as the points in the window."""
    index = 0
    while index + 1 < len(points) and points[index + 1][0] <= earliest:
        index += 1
    return points[index:]


class SessionEngine:
    """Three individual detectors, persisted independently of legacy counters.

    Completed dishwasher records always retain candidate confidence. They never
    command a device, change helpers or declare a firmware-confirmed completion.
    """

    def __init__(self, profile, *, energy_source=True, origin="shadow_observation", currency="DKK", sources=None):
        if profile not in PROFILES:
            raise ValueError("Unsupported session profile")
        if origin not in {"shadow_observation", "historical_reconstruction"}:
            raise ValueError("Unsupported origin")
        self.currency = currency
        self.sources = deepcopy(sources or {})
        self.profile = profile
        self.energy_source = energy_source
        self.origin = origin
        self.prices = PriceBook()
        self.records = []
        self.active = None
        self.power = []
        self.energy = []
        self.at = None
        self.power_seen = None
        self.state = "idle"
        self.block = None
        self.block_low = None
        self.previous_block_end = None
        self.idle_since = None
        self.high_since = None
        self.high_end = None
        self.auxiliary = None
        self.last_electrical_activity = None

    def snapshot(self):
        return {"algorithm": ALGORITHM, "profile": self.profile,
                "energy_source": self.energy_source, "origin": self.origin,
                "currency": self.currency, "sources": deepcopy(self.sources),
                "prices": deepcopy(self.prices.rows), "records": deepcopy(self.records),
                **{key: deepcopy(getattr(self, key)) for key in (
                    "active", "power", "energy", "at", "power_seen", "state", "block",
                    "block_low", "previous_block_end", "idle_since", "high_since", "high_end",
                    "auxiliary", "last_electrical_activity")}}

    @classmethod
    def restore(cls, saved):
        if saved.get("algorithm") != ALGORITHM:
            raise ValueError("Unsupported session store algorithm; preserve store for recovery")
        engine = cls(saved["profile"], energy_source=saved["energy_source"], origin=saved["origin"],
                     currency=saved["currency"], sources=saved["sources"])
        engine.prices = PriceBook(saved["prices"])
        for key in ("records", "active", "power", "energy", "at", "power_seen", "state", "block",
                    "block_low", "previous_block_end", "idle_since", "high_since", "high_end",
                    "auxiliary", "last_electrical_activity"):
            setattr(engine, key, deepcopy(saved[key]))
        return engine

    def _flag(self, flag):
        if self.active and flag not in self.active["quality"]:
            self.active["quality"].append(flag)

    def _transition(self, state, at):
        if self.active and state != self.state:
            self.active["phases"].append({"state": state, "at": at})
        self.state = state

    def _append(self, target, at, value):
        points = getattr(self, target)
        if points and at < points[-1][0]:
            self._flag("out_of_order_data")
            return False
        # Power needs only transition points; energy also records unchanged reports
        # so settlement can distinguish a fresh counter from an old restored value.
        if target == "power" and points and points[-1][1] == value:
            return True
        points.append([at, value])
        if len(points) > MAX_SAMPLES:
            self._flag("sample_limit")
            del points[1]  # retain the original anchor; mark lost timing explicitly
        return True

    def resume(self, at):
        """A restart is an observation gap, never a fabricated quiet interval."""
        if self.at is not None and at > self.at:
            if self.active:
                self._flag("restart_gap")
                self.active["end"] = None
                self.active["finish_evidence"] = None
                self._transition("measurement_gap", at)
            self._append("power", self.at, None)
            self.block = self.block_low = self.high_since = self.high_end = None
            self.previous_block_end = self.idle_since = None
            self.auxiliary = None
            self.at = at

    def interrupt(self, at, reason):
        """Archive an incomplete observation without inventing its end or totals."""
        if self.active:
            row = deepcopy(self.active)
            row.update(status="interrupted", end=None, duration_seconds=None,
                       observed_until=at, kwh=None, cost=None, known_cost=None,
                       unpriced_kwh=None, energy_complete=False)
            row["quality"] = sorted(set(row["quality"] + [reason]))
            self.records.append(row)
            self.active = None
        self.state = "idle"

    def on_energy(self, at, value):
        value = decimal(value)
        if value is not None and value < 0:
            value = None
        if value is None:
            self._flag("counter_unavailable")
        self._append("energy", at, str(value) if value is not None else None)
        if not self.active:
            self.energy = trim(self.energy, at - (360 if self.profile == "dishwasher" else 180))

    def on_power(self, at, value):
        if self.at is not None and at < self.at:
            self._flag("out_of_order_data")
            return
        value = decimal(value)
        value = float(value) if value is not None else None
        if value is not None:
            self.advance(at)
        else:
            self.at = at
        previous = self.power[-1][1] if self.power else None
        self._append("power", at, value)
        self.power_seen = at
        if value is None:
            self._flag("power_gap")
            if self.active:
                self.active["end"] = self.active["finish_evidence"] = None
                self._transition("measurement_gap", at)
            self.block = self.block_low = self.high_since = self.high_end = None
            self.previous_block_end = self.idle_since = None
            return
        if previous is None and self.active:
            self._transition("running", at)
        if value <= 5:
            if self.idle_since is None:
                self.idle_since = at
            if self.block and self.block_low is None:
                self.block_low = at
        else:
            self.idle_since = None
            if not self.block:
                self.block = {"start": at, "peak": value,
                              "preceding_end": self.previous_block_end}
            elif self.block_low is not None and at - self.block_low <= 3.1:
                self.block_low = None
            self.block["peak"] = max(self.block["peak"], value)
            # A gap before a confirmed end invalidates that end candidate.
            if self.active and self.active["end"] is not None:
                self.active["end"] = self.active["finish_evidence"] = None
                self._transition("running", at)
        if value > 200:
            if self.high_since is None:
                self.high_since = at
        elif previous is not None and previous > 200:
            if self.high_since is not None and at - self.high_since >= 60:
                self.high_end = at
            self.high_since = None
        self.advance(at)

    def _start(self, at):
        window = 90 if self.profile == "tumble_dryer" else 300 if self.profile == "dishwasher" else 120
        threshold = 200 if self.profile == "tumble_dryer" else 5
        required = 60 if self.profile == "tumble_dryer" else 30
        floor = self.records[-1].get("end") if self.records else None
        spans = list(segments(self.power, max(at - window, floor) if floor is not None else at - window, at))
        above = [(left, right, value) for left, right, value in spans
                 if value is not None and value > threshold]
        if sum(right - left for left, right, _ in above) < required:
            return
        if max((v for _, _, v in above), default=0) < (30 if self.profile == "tumble_dryer" else 50):
            return
        onset = above[0][0]
        if self.profile == "tumble_dryer":
            # Confirm with the compressor load, but retain its weaker startup
            # activity rather than discarding preparation energy. A quiet gap
            # over 30 s separates earlier unrelated activity from this onset.
            lower = max(at - 180, floor) if floor is not None else at - 180
            intro = [(left, right) for left, right, value in segments(self.power, lower, onset)
                     if value is not None and value > 5]
            for left, right in reversed(intro):
                if onset - right > 30:
                    break
                onset = left
        # Save the pre-candidate samples, not the counter at confirmation time.
        self.active = {"id": uuid4().hex, "algorithm": ALGORITHM, "profile": self.profile,
                       "origin": self.origin, "currency": self.currency, "sources": deepcopy(self.sources),
                       "start": onset, "start_confirmed": at,
                       "end": None, "main_end": None, "aftercare_start": None,
                       "last_activity": at, "finish_evidence": None, "quality": [],
                       "phases": [{"state": "running", "at": onset}],
                       "heating_seen": False}
        prior = [(l, r, v) for l, r, v in segments(self.power, onset - 60, onset)
                 if v is not None and v <= 5]
        if sum(r - l for l, r, _ in prior) < 50:
            self._flag("start_uncertain")
        # Weak activity before a newly confirmed start belongs to that new
        # candidate, not to the previous program's post-session mechanism.
        if self.records:
            self.records[-1]["auxiliary_events"] = [
                event for event in self.records[-1].get("auxiliary_events", [])
                if event["end"] < onset]
        self.auxiliary = None
        self.high_end = None  # never reuse a previous program's main-phase boundary
        self.power = trim(self.power, onset - 180)
        self.energy = trim(self.energy, onset)
        self._transition("running", at)

    def _end_block(self, at):
        if not self.block or self.block_low is None or at - self.block_low <= 3.1:
            return
        block, end = self.block, self.block_low
        self.block = self.block_low = None
        self.previous_block_end = end
        if not self.active or self.profile != "dishwasher":
            return
        gap = (block["start"] - block["preceding_end"]
               if block["preceding_end"] is not None else None)
        duration = end - block["start"]
        if (self.active["heating_seen"] and gap is not None and 90 <= gap <= 180
                and 35 <= duration <= 65 and 25 <= block["peak"] <= 45):
            self.active["end"] = end
            self.active["main_end"] = end
            self.active["finish_evidence"] = {"kind": "door_opening_candidate",
                "motor_start": block["start"], "motor_end": end, "peak_w": block["peak"],
                "quiet_before_seconds": gap, "confidence": "unverified_candidate"}
            self._flag("end_candidate_unverified")
            self._transition("finish_candidate", at)

    def advance(self, at):
        """Evaluate timers using only known observations; HA adapter enforces freshness."""
        if self.at is not None and at < self.at:
            return
        self.at = at
        self._end_block(at)
        value = self.power[-1][1] if self.power else None
        if value is None:
            return
        if value > 5:
            self.last_electrical_activity = at
        if not self.active:
            self._start(at)
        if not self.active:
            self._observe_auxiliary(at, value)
        if self.active:
            row = self.active
            if value > 5 and row["end"] is None:
                row["last_activity"] = at
            if value > 1000:
                row["heating_seen"] = True
            if self.profile == "tumble_dryer":
                mean, unknown = integral(self.power, at - 300, at)
                if (row["aftercare_start"] is None and self.high_end is not None
                        and at - self.high_end >= 120 and not unknown and mean * 12 < Decimal("0.05")):
                    row["main_end"] = self.high_end
                    row["aftercare_start"] = self.high_end
                    self._transition("aftercare", at)
            if self.profile == "dishwasher" and row["end"] is None:
                spans = list(segments(self.power, at - 300, at))
                quiet = value < 100 and all(v is not None and v < 100 for _, _, v in spans)
                self._transition("low_load_hold" if quiet else "running", at)
            if self.profile != "dishwasher" and value <= 5 and self.idle_since is not None and at - self.idle_since >= 600:
                row["end"] = self.idle_since
                if self.idle_since - row["last_activity"] > 1:
                    self._flag("end_uncertain")
                if row["main_end"] is None:
                    row["main_end"] = row["end"]
                row["finish_evidence"] = {"kind": "activity_then_standby", "confidence": "inferred"}
            if row["end"] is not None and at >= row["end"] + SETTLE_SECONDS:
                self._finish(at)
        if not self.active:
            self.power = trim(self.power, at - (360 if self.profile == "dishwasher" else 180))
            self.energy = trim(self.energy, at - (360 if self.profile == "dishwasher" else 180))
        self.prices.prune(min(at - 14 * 86400, self.active["start"] if self.active else at))

    def _observe_auxiliary(self, at, value):
        if self.profile != "dishwasher" or not self.records:
            return
        row = self.records[-1]
        if row.get("end") is None:
            return
        if 5 < value < 20:
            if self.auxiliary is None:
                self.auxiliary = {"start": at, "peak_w": value}
            self.auxiliary["peak_w"] = max(self.auxiliary["peak_w"], value)
        elif value >= 20:
            self.auxiliary = None
        elif self.auxiliary is not None:
            event = {**self.auxiliary, "end": at,
                     "kind": "post_session_activity", "confidence": "unverified_mechanism",
                     "method": "power_integration", "currency": self.currency}
            energy, unknown = integral(self.power, event["start"], at)
            parts = []
            for left, right, power in segments(self.power, event["start"], at):
                if power is not None and power > 0:
                    delta = decimal(power) * Decimal(str(right - left)) / Decimal(3_600_000)
                    parts.extend(self.prices.allocate(left, right, delta))
            unpriced = sum((Decimal(p["kwh"]) for p in parts if p["cost"] is None), Decimal(0))
            cost = sum((Decimal(p["cost"]) for p in parts if p["cost"] is not None), Decimal(0))
            event.update(kwh=str(energy) if not unknown else None, known_kwh=str(energy),
                         energy_complete=not unknown, unknown_power_seconds=unknown,
                         known_cost=str(cost), unpriced_kwh=str(unpriced),
                         cost=str(cost) if not unpriced and not unknown else None,
                         quality=["auxiliary_classification_unverified", "power_integration"])
            if unknown:
                event["quality"].append("energy_gap")
            row.setdefault("auxiliary_events", []).append(event)
            row["auxiliary_last_activity"] = at
            self.auxiliary = None

    def _measure(self, row):
        start, end = row["start"], row["end"]
        flags = set(row["quality"])
        allocations = []
        def allocate(left, right, energy):
            boundary = row.get("aftercare_start")
            cuts = [left, right]
            if boundary is not None and left < boundary < right:
                cuts.insert(1, boundary)
            remaining = energy
            for i, (a, b) in enumerate(zip(cuts, cuts[1:])):
                part = remaining if i == len(cuts) - 2 else energy * Decimal(str(b - a)) / Decimal(str(right - left))
                remaining -= part
                for allocation in self.prices.allocate(a, b, part):
                    allocation["phase"] = "aftercare" if boundary is not None and a >= boundary else "main"
                    allocations.append(allocation)

        known = Decimal(0)
        unknown_seconds = 0
        counter_before = counter_after = None
        energy_complete = True
        if self.energy_source:
            readings = [(t, decimal(v)) for t, v in self.energy if v is not None]
            before = [(t, v) for t, v in readings if t <= start]
            after = [(t, v) for t, v in readings if end <= t <= end + SETTLE_SECONDS]
            if not before or not after:
                flags.add("counter_boundary_missing")
                energy_complete = False
                selected = [(t, v) for t, v in readings if start <= t <= end + SETTLE_SECONDS]
            else:
                counter_before, counter_after = before[-1], after[-1]
                selected = [(t, v) for t, v in readings if counter_before[0] <= t <= counter_after[0]]
                flags.add("counter_boundary_window")
            for (left, previous), (right, current) in zip(selected, selected[1:]):
                if current < previous:
                    flags.add("counter_reset")
                    energy_complete = False
                    continue
                delta = current - previous
                known += delta
                if not delta:
                    continue
                # The meter fixes kWh. W determines its distribution across prices.
                left = max(left, start)
                if right <= left:
                    flags.add("energy_timing_unknown")
                    allocations.append({"start": left, "end": right, "kwh": str(delta),
                                        "price": None, "cost": None, "provenance": [],
                                        "reason": "energy_timing_unknown", "phase": "main"})
                    continue
                weights = []
                for a, b, power in segments(self.power, left, right):
                    if power is not None and power > 0:
                        weights.append((a, b, Decimal(str(power)) * Decimal(str(b - a))))
                _, gap = integral(self.power, left, right)
                unknown_seconds += gap
                total_weight = sum((w for _, _, w in weights), Decimal(0))
                if gap or not total_weight:
                    allocate(left, right, delta)
                    flags.add("energy_timing_estimated")
                else:
                    remaining = delta
                    for i, (a, b, weight) in enumerate(weights):
                        portion = remaining if i == len(weights) - 1 else delta * weight / total_weight
                        remaining -= portion
                        allocate(a, b, portion)
        else:
            known, unknown_seconds = integral(self.power, start, end)
            flags.add("power_integration")
            if unknown_seconds:
                flags.add("energy_gap")
                energy_complete = False
            for left, right, power in segments(self.power, start, end):
                if power is not None:
                    delta = max(Decimal(0), decimal(power)) * Decimal(str(right - left)) / Decimal(3_600_000)
                    if delta:
                        allocate(left, right, delta)
        if "sample_limit" in flags:
            energy_complete = False
        unpriced = sum((Decimal(a["kwh"]) for a in allocations if a["price"] is None), Decimal(0))
        cost = sum((Decimal(a["cost"]) for a in allocations if a["cost"] is not None), Decimal(0))
        flags.update(a["reason"] for a in allocations if a["reason"])
        # Consolidate segments by price and provenance instead of persisting a
        # large per-second trace for every closed session.
        summary = {}
        for a in allocations:
            key = (a["price"], int(a["start"] // 900), tuple(a["provenance"]), a["reason"], a["phase"])
            if key not in summary:
                summary[key] = {**a, "kwh": "0", "cost": "0" if a["cost"] is not None else None}
            s = summary[key]
            s["start"] = min(s["start"], a["start"])
            s["end"] = max(s["end"], a["end"])
            s["kwh"] = str(Decimal(s["kwh"]) + Decimal(a["kwh"]))
            if s["cost"] is not None:
                s["cost"] = str(Decimal(s["cost"]) + Decimal(a["cost"]))
        return {"kwh": str(known) if energy_complete else None, "known_kwh": str(known), "energy_complete": energy_complete,
                "main_kwh": str(sum((Decimal(a["kwh"]) for a in allocations if a["phase"] == "main"), Decimal(0))),
                "aftercare_kwh": str(sum((Decimal(a["kwh"]) for a in allocations if a["phase"] == "aftercare"), Decimal(0))),
                "aftercare_known_cost": str(sum((Decimal(a["cost"]) for a in allocations if a["phase"] == "aftercare" and a["cost"] is not None), Decimal(0))),
                "known_cost": str(cost), "cost": str(cost) if not unpriced and energy_complete else None,
                "unpriced_kwh": str(unpriced), "unknown_power_seconds": unknown_seconds,
                "counter_before": [counter_before[0], str(counter_before[1])] if counter_before else None,
                "counter_after": [counter_after[0], str(counter_after[1])] if counter_after else None,
                "price_allocations": list(summary.values()), "quality": sorted(flags)}

    def _finish(self, at):
        row = deepcopy(self.active)
        row.update(self._measure(row))
        row.update(status="candidate_completed" if self.profile == "dishwasher" else "completed",
                   end_confirmed=at, duration_seconds=row["end"] - row["start"],
                   main_duration_seconds=row["main_end"] - row["start"] if row["main_end"] is not None else None,
                   aftercare_seconds=row["end"] - row["aftercare_start"] if row["aftercare_start"] else 0)
        self.records.append(row)
        self.active = None
        self.state = row["status"]
