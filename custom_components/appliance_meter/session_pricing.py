"""Explicit historical price intervals; no access to accounting totals or HA."""
from decimal import Decimal, InvalidOperation


def decimal(value):
    """Reject booleans, NaN and infinities at every ingestion boundary."""
    if isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() else None


class PriceBook:
    """Persist published actual prices, never extrapolate a startup price backwards.

    Overlapping contradictory prices are unpriced, not silently overwritten.
    No currency conversion, VAT addition or forecast fallback is performed.
    """

    def __init__(self, rows=()):
        self.rows = [dict(row) for row in rows]

    def add(self, start, end, price, *, provenance="published_actual"):
        price = decimal(price)
        if (price is None or not isinstance(start, (int, float))
                or not isinstance(end, (int, float)) or decimal(start) is None
                or decimal(end) is None or end <= start):
            return False
        row = {"start": start, "end": end, "price": str(price), "provenance": provenance}
        if row not in self.rows:
            self.rows.append(row)
        return True

    def prune(self, earliest):
        self.rows = [row for row in self.rows if row["end"] >= earliest]

    def allocate(self, start, end, kwh):
        """Split an energy interval at every tariff boundary (time allocation).

        Caller may submit finer power-weighted intervals. Uncovered and conflicting
        spans remain explicitly unpriced; partial cost never means a full cost.
        """
        energy = decimal(kwh)
        if energy is None or energy < 0 or end <= start:
            return []
        rows = [r for r in self.rows if r["start"] < end and r["end"] > start]
        bounds = sorted({start, end, *(max(start, r["start"]) for r in rows),
                         *(min(end, r["end"]) for r in rows)})
        result = []
        remaining = energy
        for index, (left, right) in enumerate(zip(bounds, bounds[1:])):
            portion = (remaining if index == len(bounds) - 2 else
                       energy * Decimal(str(right - left)) / Decimal(str(end - start)))
            remaining -= portion
            matches = [r for r in rows if r["start"] <= left and r["end"] >= right]
            prices = {Decimal(r["price"]) for r in matches}
            price = next(iter(prices)) if len(prices) == 1 else None
            result.append({"start": left, "end": right, "kwh": str(portion),
                           "price": str(price) if price is not None else None,
                           "cost": str(portion * price) if price is not None else None,
                           "provenance": sorted({r["provenance"] for r in matches}),
                           "reason": "price_conflict" if len(prices) > 1 else
                                     "price_missing" if not prices else None})
        return result
