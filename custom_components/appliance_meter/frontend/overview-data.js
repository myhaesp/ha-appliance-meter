/** Hourly-statistics projections; no raw history requests. Prices and accounting are never recalculated. */
import { localMidnight, numeric, costCoverage } from "./consumption-data.js";
const HOUR = 3600000;
const KEYS = ["energy_total", "cost_total", "unpriced_energy"];
const missing = (reason) => ({ value: null, status: "unavailable", reason, since: null });

// Six previous local calendar dates and today, ready for a future period selector.
export function overviewDays(now, timeZone, count = 7) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - count + 1 + i));
    const start = localMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
    date.setUTCDate(date.getUTCDate() + 1);
    const next = localMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
    return { start, end: Math.min(next, now), today: i === count - 1 };
  });
}

export const OVERVIEW_LIMITS = Object.freeze({ members: 64, nodes: 512, edges: 2048, days: 7, rowsPerSeries: 171 });

// A path set detects cycles; a finished set permits shared subgroups/leaf members
// without exponential expansion or double counting. Fail closed on missing nodes.
export function resolveOverviewMembers(metadata, entry) {
  const byId = new Map(metadata.entries.map(e => [e.entry_id, e]));
  const active = new Set(), finished = new Set(), members = new Map();
  const stack = [{ entry, exit: false }]; let edges = 0;
  while (stack.length) {
    const item = stack.pop(), node = item.entry;
    if (!node?.entry_id) return { members: [], error: "A current member is missing." };
    if (item.exit) { active.delete(node.entry_id); finished.add(node.entry_id); continue; }
    if (active.has(node.entry_id)) return { members: [], error: "Custom Total membership contains a cycle." };
    if (finished.has(node.entry_id)) continue;
    if (finished.size + active.size >= OVERVIEW_LIMITS.nodes) return { members: [], error: "Custom Total membership exceeds the safe graph limit." };
    if (node.type === "physical") {
      members.set(node.entry_id, node); finished.add(node.entry_id);
      if (members.size > OVERVIEW_LIMITS.members) return { members: [], error: "Overview supports at most 64 distinct Physical members." };
    } else if (node.type === "aggregate" && node.members?.length) {
      edges += node.members.length;
      if (edges > OVERVIEW_LIMITS.edges) return { members: [], error: "Custom Total membership exceeds the safe graph limit." };
      active.add(node.entry_id); stack.push({ entry: node, exit: true });
      for (const member of node.members) stack.push({ entry: byId.get(member.entry_id), exit: false });
    } else return { members: [], error: "A current member is missing or has no Physical members." };
  }
  return { members: [...members.values()].sort((a, b) => a.entry_id.localeCompare(b.entry_id)), error: null };
}
export const overviewMembers = (metadata, entry) => resolveOverviewMembers(metadata, entry).members;

// Per-connection, bounded, short-lived memory only; shared metadata and in-flight
// reads prevent repeated Recorder bursts when reopening/switching appliances.
const connectionCaches = new WeakMap();
const CACHE_MS = 60000, MAX_CACHED_VIEWS = 8;
function cacheFor(hass) {
  const connection = hass.connection || hass;
  let cache = connectionCaches.get(connection);
  if (!cache) {
    cache = { views: new Map(), inFlight: new Map(), metadata: new Map(), active: 0, waiting: [] };
    connectionCaches.set(connection, cache);
  }
  return cache;
}
async function limited(cache, work) {
  if (cache.active >= 2) await new Promise(resolve => cache.waiting.push(resolve));
  else cache.active++;
  try { return await work(); }
  finally {
    if (cache.waiting.length) cache.waiting.shift()();
    else cache.active--;
  }
}
export async function loadOverviewData(hass, metadata, entry, now = Date.now(), count = 7, force = false) {
  const cache = cacheFor(hass), zone = hass.config?.time_zone || "UTC";
  if (count !== OVERVIEW_LIMITS.days) return { hourly: {}, statisticsMetadata: {}, created: {}, warnings: ["Only the seven-day Overview is supported."] };
  const resolution = resolveOverviewMembers(metadata, entry), members = resolution.members;
  if (resolution.error) return { hourly: {}, statisticsMetadata: {}, created: {}, warnings: [resolution.error] };
  const ids = [...new Set(members.flatMap(e => KEYS.map(k => e.sensors?.[k])).filter(Boolean))].sort();
  const key = JSON.stringify([zone, overviewDays(now, zone, count)[0].start, ids]);
  // Pending work must not be evicted with completed results, even when rapid
  // switching opens more selections than the result-cache capacity.
  if (cache.inFlight.has(key)) return cache.inFlight.get(key).promise;
  const existing = cache.views.get(key);
  if (!force && existing && now - existing.time >= 0 && now - existing.time < CACHE_MS) return existing.promise;
  cache.views.delete(key);
  const record = { time: now };
  record.promise = limited(cache, async () => {
    const data = await readOverviewData(hass, metadata, entry, now, count, cache, force);
    if (!data.warnings.length) {
      cache.views.delete(key); cache.views.set(key, record);
      while (cache.views.size > MAX_CACHED_VIEWS) cache.views.delete(cache.views.keys().next().value);
    }
    return data;
  }).finally(() => { if (cache.inFlight.get(key) === record) cache.inFlight.delete(key); });
  cache.inFlight.set(key, record);
  return record.promise;
}

async function readOverviewData(hass, metadata, entry, now, count, cache, force) {
  const days = overviewDays(now, hass.config?.time_zone || "UTC", count);
  const members = overviewMembers(metadata, entry);
  const ids = [...new Set(members.flatMap(e => KEYS.map(k => e.sensors?.[k])).filter(Boolean))];
  const data = { hourly: {}, statisticsMetadata: {}, created: {}, warnings: [], fetchedAt: now };
  if (!ids.length) return data;
  const safe = async (message, label, shared = false) => {
    try {
      if (!shared) return await hass.callWS(message);
      const key = message.type, existing = cache.metadata.get(key);
      if (!force && existing && now - existing.time >= 0 && now - existing.time < CACHE_MS) return await existing.promise;
      const record = { time: now, promise: Promise.resolve().then(() => hass.callWS(message)) };
      cache.metadata.set(key, record);
      try { return await record.promise; }
      catch (error) { if (cache.metadata.get(key) === record) cache.metadata.delete(key); throw error; }
    } catch { data.warnings.push(`${label} unavailable; coverage may be incomplete.`); return {}; }
  };
  const start = days[0].start;
  const [hourly, statistics, entries] = await Promise.all([
    safe({ type: "recorder/statistics_during_period", start_time: new Date(start - HOUR).toISOString(),
      end_time: new Date(now).toISOString(), statistic_ids: ids, period: "hour",
      types: ["state", "sum", "last_reset"], units: { energy: "kWh" } }, "Hourly statistics"),
    safe({ type: "recorder/list_statistic_ids", statistic_type: "sum" }, "Statistics metadata", true),
    safe({ type: "config_entries/get", domain: "appliance_meter" }, "Appliance creation metadata", true),
  ]);
  // The period and member count bound server work. Reject malformed/oversized
  // responses before retaining/indexing them; never fall back to raw history.
  let totalRows = 0;
  for (const id of ids) {
    const rows = hourly?.[id] || [];
    if (!Array.isArray(rows) || rows.length > OVERVIEW_LIMITS.rowsPerSeries) {
      data.warnings.push("Hourly statistics exceeded the safe response limit."); return data;
    }
    totalRows += rows.length;
  }
  if (totalRows > OVERVIEW_LIMITS.members * 3 * OVERVIEW_LIMITS.rowsPerSeries) {
    data.warnings.push("Hourly statistics exceeded the safe response limit."); return data;
  }
  data.hourly = Object.fromEntries(ids.map(id => [id, hourly?.[id] || []]));
  if (Array.isArray(statistics)) data.statisticsMetadata = Object.fromEntries(
    statistics.filter(s => ids.includes(s.statistic_id)).map(s => [s.statistic_id, s]));
  if (Array.isArray(entries)) data.created = Object.fromEntries(entries.map(e => [e.entry_id, e.created_at * 1000]));
  return data;
}

const near = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Number.EPSILON * 64 * Math.max(1, Math.abs(a), Math.abs(b)));
const snapshots = new WeakMap();
function prepared(data) {
  let cached = snapshots.get(data);
  if (!cached) { cached = { series: new Map(), days: new Map(), live: new Map() }; snapshots.set(data, cached); }
  return cached;
}
function series(data, id) {
  const cache = prepared(data).series;
  if (cache.has(id)) return cache.get(id);
  const source = data.hourly[id] || [];
  const malformed = !Array.isArray(source) || source.length > OVERVIEW_LIMITS.rowsPerSeries ||
    source.some(r => !r || typeof r !== "object");
  const rows = malformed ? [] : [...source].sort((a, b) => a.end - b.end);
  const invalid = malformed || rows.some((r, i) =>
    !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end - r.start !== HOUR ||
    (r.last_reset != null && (!Number.isFinite(r.last_reset) || r.last_reset > r.end)) ||
    (i > 0 && r.start < rows[i - 1].end));
  const result = { rows, invalid }; cache.set(id, result); return result;
}
const discontinuity = reason => ({ ...missing(reason), status: "discontinuity" });
const reset = row => row.last_reset ?? null;

// A day is derived from cumulative sums, not a price multiplication. State deltas
// are only continuity checks and the anchor for today's not-yet-compiled tail.
function recordedDay(entry, key, day, data, unit) {
  const id = entry.sensors?.[key], cache = prepared(data).days;
  const signature = JSON.stringify([entry.entry_id, id, unit, data.created[entry.entry_id], day.start, day.today ? "today" : day.end]);
  if (cache.has(signature)) return cache.get(signature);
  const finish = value => { cache.set(signature, value); return value; };
  const meta = data.statisticsMetadata[id], created = data.created[entry.entry_id];
  if (!id || !meta?.has_sum || !unit || meta.statistics_unit_of_measurement !== unit)
    return finish(missing("Compatible cumulative statistics are unavailable."));
  if (!Number.isFinite(created)) return finish(missing("Appliance creation metadata is unavailable."));
  const source = series(data, id);
  if (source.invalid) return finish(discontinuity("Malformed, overlapping or duplicate hourly statistics."));
  const rows = source.rows.filter(r => r.end >= Math.max(day.start, created) && r.end <= day.end);
  if (!rows.length) return finish(missing("No statistics boundary is available for this date."));
  const first = rows[0], last = rows.at(-1);
  if (rows.some(r => numeric(r.sum) === null || numeric(r.state) === null))
    return finish(missing("Hourly statistics contain missing cumulative readings."));
  let negative = false;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (b.start !== a.end) return finish(missing("Hourly statistics have a gap; consumption is not assumed zero."));
    const delta = b.sum - a.sum, stateDelta = b.state - a.state;
    if (reset(a) !== reset(b) || !near(delta, stateDelta) ||
        (key !== "cost_total" && (stateDelta < -1e-8 || delta < -1e-8 || b.state < 0)))
      return finish(discontinuity("A statistics reset, counter decrease or correction interrupts this date."));
    if (key === "cost_total" && delta < -1e-8) negative = true;
  }
  if (key !== "cost_total" && first.state < 0) return finish(discontinuity("A consumption counter is negative."));
  const partial = first.end !== day.start || (!day.today && last.end !== day.end);
  const base = { value: last.sum - first.sum, since: first.end, end: last.end,
    status: partial ? "partial" : "complete", anchor: last, negative,
    reason: partial ? "Missing calendar boundary or mid-day creation; only the observed statistical interval is shown." : "Difference of recorded hourly cumulative sums; hourly coverage verified." };
  return finish(base);
}

function metric(entry, key, day, data, states, now, unit) {
  const base = recordedDay(entry, key, day, data, unit);
  if (base.value === null) return base;
  let result = { ...base };
  if (day.today) {
    const id = entry.sensors?.[key], live = states[id], value = numeric(live?.state);
    const watermark = base.anchor.end;
    const liveKey = JSON.stringify([entry.entry_id, id, day.start]), remembered = prepared(data).live;
    const previous = remembered.get(liveKey);
    const valid = value !== null && !live?.attributes?.restored && live?.attributes?.unit_of_measurement === unit;
    if (valid) {
      const lastReset = live.attributes.last_reset;
      const resetTime = typeof lastReset === "number" ? lastReset : Date.parse(lastReset);
      const decrease = key !== "cost_total" && (value < base.anchor.state - 1e-8 || (previous && value < previous.value - 1e-8));
      const broken = previous?.broken || decrease || (Number.isFinite(resetTime) && resetTime > day.start);
      const negative = base.negative || previous?.negative || (key === "cost_total" && value < (previous?.value ?? base.anchor.state) - 1e-8);
      remembered.set(liveKey, { value, broken, negative });
      if (broken) return discontinuity("The live counter decreased or reset after the statistical baseline.");
      if (now >= watermark && now - watermark <= 2 * HOUR) {
        // Prefix sum ends at watermark. Only its counter-to-live tail is added.
        result = { ...base, value: base.value + value - base.anchor.state, end: now, negative };
      } else result.reason += " Statistics are stale; no live tail was inferred.";
    } else result.reason += " Live counter unavailable, restored or incompatible; value stops at the recorded cutoff.";
    result.status = "partial";
    result.reason += " Today so far; the live tail starts at the latest compiled hourly state, without counting that hour twice.";
  } else if (base.end === base.since) return missing("No observed interval is available for this date.");
  if (result.negative) {
    result.status = "partial";
    result.reason += " Negative recorded cost is retained; an unmarked cost reset cannot be distinguished from negative-price accounting.";
  }
  if (result.end === result.since) return missing("No observed interval is available for this date.");
  const { anchor, negative, ...publicMetric } = result;
  return publicMetric;
}
function physicalDay(entry, day, data, states, now) {
  const energy = metric(entry, "energy_total", day, data, states, now, "kWh");
  const currency = data.statisticsMetadata[entry.sensors?.cost_total]?.statistics_unit_of_measurement;
  const cost = metric(entry, "cost_total", day, data, states, now, currency);
  const unpriced = metric(entry, "unpriced_energy", day, data, states, now, "kWh");
  let coveredCost = costCoverage(cost, energy, unpriced);
  if (energy.value === null && coveredCost.value !== null)
    coveredCost = { ...coveredCost, status: "partial", reason: `${coveredCost.reason} Energy coverage is unavailable.` };
  return { energy, cost: coveredCost };
}

/** Precompute closed member/days once per immutable statistics snapshot. */
export async function prepareOverviewData(metadata, entry, data, states, now = Date.now(), timeZone = "UTC", current = () => true) {
  if (!current()) return false;
  const days = overviewDays(now, timeZone), members = overviewMembers(metadata, entry);
  let slice = performance.now();
  for (const day of days) for (const member of members) {
    if (!current()) return false;
    physicalDay(member, day, data, states, now);
    if (performance.now() - slice >= 8) {
      await new Promise(resolve => setTimeout(resolve, 0)); slice = performance.now();
    }
  }
  return current();
}

function combine(parts, currencyOK) {
  if (!parts.length || !currencyOK || parts.some(p => p.value === null))
    return missing("A current member is missing or lacks compatible history/currency.");
  return { value: parts.reduce((s, p) => s + p.value, 0),
    status: parts.every(p => p.status === "complete") ? "complete" : "partial",
    reason: "Sum of current members; historical membership is not reconstructed.",
    // For an aggregate, only show an average if member observation intervals match.
    since: parts.every(p => p.since === parts[0].since) ? parts[0].since : null,
    end: parts.every(p => p.end === parts[0].end) ? parts[0].end : null };
}

function total(days, key) {
  const parts = days.map(d => d[key]).filter(p => p.value !== null);
  if (!parts.length) return missing("No usable history in this period.");
  return { value: parts.reduce((s, p) => s + p.value, 0),
    status: parts.length === days.length && parts.every(p => p.status === "complete") ? "complete" : "partial",
    reason: "Sum of the daily recorded values; missing days are excluded, never assumed zero." };
}

export function overviewModel(metadata, entry, data, states, now = Date.now(), timeZone = "UTC", count = 7) {
  const members = overviewMembers(metadata, entry);
  const currencies = new Set(members.map(e => {
    const id = e.sensors.cost_total;
    return data.statisticsMetadata[id]?.statistics_unit_of_measurement || states[id]?.attributes?.unit_of_measurement;
  }));
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const days = overviewDays(now, timeZone, count).map(day => {
    const parts = members.map(e => physicalDay(e, day, data, states, now));
    return { ...day,
      energy: entry.type === "physical" ? parts[0]?.energy || missing("No appliance history.") : combine(parts.map(p => p.energy), true),
      cost: entry.type === "physical" ? parts[0]?.cost || missing("No cost history.") : combine(parts.map(p => p.cost), Boolean(currency)) };
  });
  const energy = total(days, "energy"), cost = total(days, "cost");
  const observed = days.filter(d => d.energy.value !== null);
  const duration = observed.reduce((sum, d) => sum + (d.energy.since === null ? 0 : Math.max(0, (d.energy.end ?? d.end) - d.energy.since)), 0);
  const average = energy.value === null || !duration || observed.some(d => d.energy.since === null || d.energy.end === null)
    ? missing("Average needs a known observed interval for every displayed energy value.")
    : { ...energy, value: energy.value * 3.6e9 / duration,
      reason: "Recorded kWh divided by covered elapsed hours, including idle time; not a sample-average of live power." };
  return { days, energy, cost, average, currency, warnings: data.warnings || [], aggregate: entry.type === "aggregate" };
}
