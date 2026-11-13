// The per-phone comparison, from every stored row. It is worked out again on
// each upload and on each GET, so it never drifts from the rows.
const { session_gap_minutes } = $('Settings').first().json;
const GAP_MS = session_gap_minutes * 60 * 1000;

// A row that lost the "first row per key" check may still be in the table for
// a moment while its run removes it. Count each key once.
const byKey = new Map();
for (const { json: row } of $input.all()) {
  if (row.row_key === undefined) continue;
  const known = byKey.get(row.row_key);
  if (!known || row.id < known.id) byKey.set(row.row_key, row);
}

const phones = new Map();
for (const row of byKey.values()) {
  if (!phones.has(row.device)) phones.set(row.device, []);
  phones.get(row.device).push({ ...row, at: row.logged_at ? Date.parse(`${row.logged_at}Z`) : null });
}

const round = (value, digits = 2) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const devices = [];
for (const [device, rows] of phones) {
  // Oldest first; rows without a time keep the order they were stored in, at the end.
  rows.sort((a, b) => (a.at === null) - (b.at === null) || (a.at ?? 0) - (b.at ?? 0) || a.id - b.id);

  // Sessions: the "session" column when the file has one; else a pause longer
  // than SESSION_GAP_MINUTES starts a new one. A row with neither a session
  // name nor a time belongs to no session.
  const sessions = new Map();
  let counter = 0;
  let last = null;
  for (const row of rows) {
    let name = null;
    if (row.session) name = `named:${row.session}`;
    else if (row.at !== null) {
      if (last === null || row.at - last > GAP_MS) counter++;
      last = row.at;
      name = `gap:${counter}`;
    }
    if (name === null) continue;
    if (!sessions.has(name)) sessions.set(name, []);
    sessions.get(name).push(row);
  }

  const drains = [];
  let hours = 0;
  let dropsInTimedSessions = 0;
  for (const session of sessions.values()) {
    if (session.length < 2) continue;
    drains.push(session[0].battery - session[session.length - 1].battery);
    const timed = session.filter((row) => row.at !== null);
    const length = timed.length < 2 ? 0 : (timed[timed.length - 1].at - timed[0].at) / 3600000;
    if (length > 0) {
      hours += length;
      dropsInTimedSessions += timed.reduce((sum, row) => sum + row.frame_drops, 0);
    }
  }

  const temperatures = rows.map((row) => row.temperature);
  const times = rows.filter((row) => row.at !== null).map((row) => row.logged_at);
  devices.push({
    device,
    readings: rows.length,
    sessions: sessions.size,
    avg_temperature: round(mean(temperatures)),
    max_temperature: Math.max(...temperatures),
    avg_battery_drain_per_session: round(mean(drains)), // first reading minus last reading of a session, in battery percent
    frame_drops_total: rows.reduce((sum, row) => sum + row.frame_drops, 0),
    frame_drops_per_hour: hours > 0 ? round(dropsInTimedSessions / hours) : null,
    hours_logged: round(hours),
    first_reading: times[0] ?? null,
    last_reading: times[times.length - 1] ?? null,
  });
}
devices.sort((a, b) => a.device.localeCompare(b.device));

const show = (value, unit) => (value === null ? 'n/a' : `${value}${unit}`);
const summary = devices
  .map(
    (d) =>
      `${d.device}: ${d.readings} readings, avg ${show(d.avg_temperature, ' °C')}, max ${show(d.max_temperature, ' °C')}, drain ${show(d.avg_battery_drain_per_session, ' % per session')}, ${show(d.frame_drops_per_hour, ' frame drops per hour')}`,
  )
  .join('\n');

return [{ json: { rows_stored: byKey.size, devices, summary } }];
