// End-to-end tests: the real workflow on a real n8n, called over HTTP the way
// a phone shortcut would call it. Every CSV is posted for real, in the three
// upload forms. No phone and no Google Sheet is involved.
//
// The data table keeps its rows for the whole run, so every test uses its own
// device names and checks the numbers of those devices.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const N8N = process.env.N8N_URL ?? 'http://localhost:55704';
const KEY = process.env.GAME_LOG_KEY ?? 'test-log-key';
const INTAKE = `${N8N}/webhook/game-log/intake`;
const COMPARISON = `${N8N}/webhook/game-log/comparison`;

// --- helpers -------------------------------------------------------------------

const HEADER = ['Time', 'Battery %', 'Temp (C)', 'Frame drops', 'Note'];
const quote = (value, separator) => {
  const text = String(value);
  return text.includes(separator) || /["\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
// rows -> CSV text
const csv = (rows, { separator = ',', eol = '\n', header = HEADER, end = eol } = {}) =>
  [...(header ? [header] : []), ...rows].map((row) => row.map((value) => quote(value, separator)).join(separator)).join(eol) + end;

// What the workflow hashes: the text without byte order mark, with \n line ends, without trailing white space.
const hashOf = (text) =>
  createHash('sha256')
    .update(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, ''))
    .digest('hex');

async function answerOf(response) {
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON, for example n8n's "starting up" page */
  }
  return { status: response.status, json, text };
}

// Posts a CSV the way a phone would. form: 'file' (multipart upload), 'raw'
// (the text is the body), 'json' ({ csv: text }). content may be a string or bytes.
async function send(form, content, { device, key = KEY, type = 'text/csv', filename = 'log.csv', deviceVia = 'query' } = {}) {
  const headers = key ? { 'x-log-key': key } : {};
  let url = INTAKE;
  if (device && deviceVia === 'query') url += `?device=${encodeURIComponent(device)}`;
  if (device && deviceVia === 'header') headers['x-device'] = device;
  let body;
  if (form === 'file') {
    body = new FormData();
    if (device && deviceVia === 'field') body.set('device', device);
    body.set('upload', new Blob([content], { type: 'text/csv' }), filename);
  } else if (form === 'raw') {
    if (type) headers['content-type'] = type;
    body = content;
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ csv: content, ...(device && deviceVia === 'field' ? { device } : {}) });
  }
  return answerOf(await fetch(url, { method: 'POST', headers, body }));
}

async function comparison(key = KEY) {
  return answerOf(await fetch(COMPARISON, { headers: key ? { 'x-log-key': key } : {} }));
}
const phone = (answer, device) => answer.json.comparison.find((entry) => entry.device === device);
const stored = async () => (await comparison()).json.rows_stored;

async function until(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try {
      value = await check();
    } catch {
      /* connection refused or reset while n8n starts */
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(1000);
  }
}

// n minutes after 10:00 on a day, as "2026-10-DD HH:MM"
const at = (day, minutes) => `2026-10-${String(day).padStart(2, '0')} ${String(10 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
// A plain session: one reading every 10 minutes, battery falling 2 per reading.
const session = (day, count, startMinute = 0) => Array.from({ length: count }, (_, i) => [at(day, startMinute + i * 10), 90 - i * 2, 36 + i * 0.5, i, `reading ${i + 1}`]);

before(async () => {
  // The comparison answers 200 once n8n is up and the setup has made the data tables.
  await until(async () => {
    const answer = await comparison();
    return answer.status === 200 && answer.json?.ok === true;
  }, 240_000);
});

// --- tests -----------------------------------------------------------------------

test('both webhooks need the key', async () => {
  const rows = await stored();
  assert.equal((await send('raw', csv(session(1, 3)), { device: 'No Key', key: null })).status, 403);
  assert.equal((await send('file', csv(session(1, 3)), { device: 'No Key', key: 'wrong' })).status, 403);
  assert.equal((await comparison(null)).status, 403);
  assert.equal(await stored(), rows, 'nothing was stored');
});

test('one file in the three upload forms is stored once; quoted notes arrive whole', async () => {
  const device = 'Forms Phone';
  const notes = ['menu, loading; first map', 'boss fight\nsecond line of the note', 'tester said "hot", then paused'];
  const rows = [
    [at(1, 0), 90, 36.5, 2, notes[0]],
    [at(1, 20), 84, 39, 7, notes[1]],
    [at(1, 40), 78, 41.5, 12, notes[2]],
  ];
  const text = csv(rows);

  const first = await send('file', text, { device });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(
    { form: first.json.form, delimiter: first.json.delimiter, header: first.json.header, rows_in_file: first.json.rows_in_file, added: first.json.added, duplicate_file: first.json.duplicate_file },
    { form: 'file upload', delimiter: 'comma', header: true, rows_in_file: 3, added: 3, duplicate_file: false },
  );
  assert.equal(first.json.file_hash, hashOf(text), 'the hash written in JavaScript equals SHA-256 from node:crypto');

  const second = await send('raw', text, { device });
  assert.deepEqual([second.status, second.json.form, second.json.duplicate_file, second.json.added, second.json.already_stored], [200, 'raw body', true, 0, 3]);
  const third = await send('json', text, { device });
  assert.deepEqual([third.status, third.json.form, third.json.duplicate_file, third.json.added, third.json.already_stored], [200, 'text field', true, 0, 3]);
  // The same file saved with Windows line ends and a byte order mark is still the same file.
  const fourth = await send('raw', `﻿${text.replace(/\n/g, '\r\n')}`, { device });
  assert.deepEqual([fourth.status, fourth.json.duplicate_file, fourth.json.added], [200, true, 0]);

  assert.deepEqual(phone(third, device), {
    device,
    readings: 3,
    sessions: 1,
    avg_temperature: 39,
    max_temperature: 41.5,
    avg_battery_drain_per_session: 12,
    frame_drops_total: 21,
    frame_drops_per_hour: 31.5, // 21 drops in 40 minutes
    hours_logged: 0.67,
    first_reading: '2026-10-01T10:00:00',
    last_reading: '2026-10-01T10:40:00',
  });

  // What is stored: the same three readings with other notes come back as conflicts that show the stored values.
  const changed = await send('json', csv(rows.map((row) => [...row.slice(0, 4), 'changed'])), { device });
  assert.deepEqual([changed.status, changed.json.duplicate_file, changed.json.added, changed.json.conflict_count], [200, false, 0, 3]);
  assert.deepEqual(changed.json.conflicts.map((conflict) => conflict.stored.note).sort(), [...notes].sort(), 'commas, semicolons, line breaks and quotes inside notes survived');
  assert.deepEqual(changed.json.conflicts.map((conflict) => conflict.stored.temperature).sort(), [36.5, 39, 41.5]);
  assert.equal(phone(await comparison(), device).readings, 3, 'a conflict does not add or change a row');
});

test('each upload form stores a new file, and the phone can name itself in four ways', async () => {
  const cases = [
    ['file', { deviceVia: 'query' }, 'file upload'],
    ['file', { deviceVia: 'field' }, 'file upload'],
    ['raw', { deviceVia: 'query', type: 'text/csv' }, 'raw body'],
    ['raw', { deviceVia: 'header', type: 'text/plain' }, 'raw body'],
    ['raw', { deviceVia: 'query', type: 'application/octet-stream' }, 'raw body'],
    ['json', { deviceVia: 'field' }, 'text field'],
    ['json', { deviceVia: 'query' }, 'text field'],
  ];
  for (const [index, [form, options, name]] of cases.entries()) {
    const device = `Way ${index + 1}`;
    const answer = await send(form, csv(session(2, 4, index)), { device, ...options });
    assert.equal(answer.status, 200, `${form} ${JSON.stringify(options)}: ${answer.text}`);
    assert.deepEqual([answer.json.form, answer.json.added, answer.json.duplicate_file], [name, 4, false], `${form} ${JSON.stringify(options)}`);
    assert.equal(phone(answer, device).readings, 4);
  }
  // A device column in the file wins over the address.
  const answer = await send('raw', csv([['Column Phone', at(2, 0), 80, 35, 1, 'a']], { header: ['Device', ...HEADER] }), { device: 'Address Phone' });
  assert.equal(answer.json.added, 1);
  assert.equal(phone(answer, 'Column Phone').readings, 1);
  assert.equal(phone(answer, 'Address Phone'), undefined);
  // And such a file needs no device in the address at all; sent again, it is known.
  const plain = csv([['Column Phone 2', at(2, 0), 80, 35, 1, 'a']], { header: ['Device', ...HEADER] });
  assert.deepEqual([(await send('file', plain)).json.added, (await send('raw', plain)).json.duplicate_file], [1, true]);
});

test('overlapping exports add each reading once', async () => {
  const device = 'Overlap Phone';
  const all = session(3, 7);
  const a = await send('file', csv(all.slice(0, 4)), { device });
  assert.deepEqual([a.json.added, a.json.already_stored], [4, 0]);
  const b = await send('raw', csv(all.slice(2, 7)), { device }); // readings 3 to 7: two of them are stored already
  assert.deepEqual([b.json.duplicate_file, b.json.added, b.json.already_stored, b.json.conflict_count], [false, 3, 2, 0]);
  const full = await send('json', csv(all), { device }); // the whole history, a file never seen before
  assert.deepEqual([full.json.duplicate_file, full.json.added, full.json.already_stored], [false, 0, 7]);
  // The same readings again in another order, other separator, other column order.
  const shuffled = await send('raw', csv([...all].reverse().map(([time, battery, temp, drops, note]) => [note, drops, time, temp, battery]), { separator: ';', header: ['Note', 'Frame drops', 'Time', 'Temp (C)', 'Battery %'] }), { device });
  assert.deepEqual([shuffled.json.duplicate_file, shuffled.json.delimiter, shuffled.json.added, shuffled.json.already_stored, shuffled.json.conflict_count], [false, 'semicolon', 0, 7, 0]);
  assert.equal(phone(shuffled, device).readings, 7);

  // An "id" column of the app is the key when there is one, whatever else changes.
  const withId = (rows) => csv(rows, { header: ['id', ...HEADER] });
  const idPhone = 'Id Phone';
  const one = await send('raw', withId([['n-1', at(3, 0), 90, 36, 1, 'a'], ['n-2', at(3, 10), 88, 37, 2, 'b']]), { device: idPhone });
  assert.equal(one.json.added, 2);
  const two = await send('raw', withId([['n-2', at(3, 10), 88, 37, 2, 'b'], ['n-3', at(3, 10), 86, 38, 3, 'same minute as n-2']]), { device: idPhone });
  assert.deepEqual([two.json.added, two.json.already_stored, two.json.conflict_count], [1, 1, 0]);
});

test('semicolon, decimal comma, Windows line ends, byte order mark, columns in another order', async () => {
  const device = 'Semicolon Phone';
  const text =
    '﻿' +
    csv(
      [
        ['Lobby; idle', '36,5', '95%', 0, '28.10.2026 18:00'],
        ['Match 1, "ranked"', '39,25', '91 %', 14, '28.10.2026 18:15:30'],
        ['Match 2', '42,0 °C', '86', 30, '28.10.2026 18:30'],
      ],
      { separator: ';', eol: '\r\n', header: ['Note', 'Device temp (°C)', 'Battery', 'Dropped frames', 'Timestamp'] },
    );
  const answer = await send('file', text, { device });
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual([answer.json.delimiter, answer.json.header, answer.json.added, answer.json.rejected_count], ['semicolon', true, 3, 0]);
  const numbers = phone(answer, device);
  assert.deepEqual(
    [numbers.readings, numbers.avg_temperature, numbers.max_temperature, numbers.avg_battery_drain_per_session, numbers.frame_drops_total, numbers.frame_drops_per_hour],
    [3, 39.25, 42, 9, 44, 88], // (36.5 + 39.25 + 42) / 3; 95 - 86; 44 drops in half an hour
  );
  assert.deepEqual([numbers.first_reading, numbers.last_reading], ['2026-10-28T18:00:00', '2026-10-28T18:30:00'], 'day first, as DAY_FIRST says');

  // Excel's "sep=;" first line is followed too.
  const hinted = await send('raw', `sep=;\r\n${csv(session(4, 2), { separator: ';', eol: '\r\n' })}`, { device: 'Hint Phone' });
  assert.deepEqual([hinted.status, hinted.json.delimiter, hinted.json.added], [200, 'semicolon', 2]);
});

test('tab-separated, UTF-16 from a spreadsheet export, no header row, no time column', async () => {
  const tab = await send('raw', csv(session(5, 3).map((row) => [...row.slice(0, 4), 'note with, a comma']), { separator: '\t' }), { device: 'Tab Phone', type: 'text/tab-separated-values' });
  assert.deepEqual([tab.status, tab.json.delimiter, tab.json.added], [200, 'tab', 3]);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv(session(5, 3).map((row) => [...row.slice(0, 4), 'héllo – 发热']), { separator: '\t', eol: '\r\n' }), 'utf16le')]);
  const wide = await send('file', utf16, { device: 'Utf16 Phone' });
  assert.deepEqual([wide.status, wide.json.delimiter, wide.json.added], [200, 'tab', 3]);
  const again = await send('raw', csv(session(5, 3).map((row) => [...row.slice(0, 4), 'other note'])), { device: 'Utf16 Phone' });
  assert.deepEqual(again.json.conflicts.map((conflict) => conflict.stored.note), ['héllo – 发热', 'héllo – 发热', 'héllo – 发热'], 'the text was decoded, not stored as garbage');

  // No header: 5 columns are read as time, battery, temperature, frame drops, note.
  const bare = await send('json', csv(session(5, 4), { header: null }), { device: 'Bare Phone' });
  assert.deepEqual([bare.status, bare.json.header, bare.json.added], [200, false, 4]);
  assert.equal(phone(bare, 'Bare Phone').avg_battery_drain_per_session, 6);

  // No header and no time: 4 columns. The whole row is the key, and what needs a clock stays empty.
  const four = [
    [90, '37,5', 3, 'start'],
    [80, '40,5', 9, 'end'],
  ];
  const untimed = await send('raw', csv(four, { header: null, separator: ';' }), { device: 'Untimed Phone' });
  assert.deepEqual([untimed.status, untimed.json.header, untimed.json.added], [200, false, 2]);
  const more = await send('raw', csv([...four, [70, '41', 2, 'later']], { header: null, separator: ';' }), { device: 'Untimed Phone' });
  assert.deepEqual([more.json.added, more.json.already_stored], [1, 2]);
  const numbers = phone(more, 'Untimed Phone');
  assert.deepEqual(
    [numbers.readings, numbers.sessions, numbers.avg_temperature, numbers.max_temperature, numbers.avg_battery_drain_per_session, numbers.frame_drops_per_hour, numbers.first_reading],
    [3, 0, 39.67, 41, null, null, null],
  );
});

test('a file that still has one column is refused with a clear answer, and nothing is written', async () => {
  const rows = await stored();
  const refused = async (form, content, options, status, error) => {
    const answer = await send(form, content, { device: 'Garbage Phone', ...options });
    assert.deepEqual([answer.status, answer.json?.ok, answer.json?.error], [status, false, error], answer.text);
    assert.ok(answer.json.message.length > 20, 'the answer says what is wrong in words');
    return answer.json;
  };

  // Values separated by spaces: every line is one column.
  const spaces = await refused('raw', 'Time Battery Temp Drops Note\n2026-10-28 10:00 85 38.5 3 lag\n2026-10-28 10:10 83 39.0 4 lag\n', {}, 422, 'one_column');
  assert.equal(spaces.first_line, 'Time Battery Temp Drops Note');
  for (const form of ['file', 'json']) await refused(form, 'just my notes\nno table here\n', {}, 422, 'one_column');
  await refused('file', '<html><body><h1>404 Not Found</h1></body></html>', {}, 422, 'one_column');
  await refused('raw', 'battery\n85\n84\n', {}, 422, 'one_column');

  // Nothing usable in the request at all.
  await refused('raw', '', {}, 400, 'no_csv');
  await refused('json', '   \n ', {}, 400, 'no_csv');
  const noField = await answerOf(await fetch(INTAKE, { method: 'POST', headers: { 'x-log-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) }));
  assert.deepEqual([noField.status, noField.json.error], [400, 'no_csv']);

  // Columns found, but not the ones needed.
  const missing = await refused('raw', csv([[at(6, 0), 85, 38.5, 'lag']], { header: ['Time', 'Battery', 'Temp', 'Note'] }), {}, 422, 'missing_columns');
  assert.deepEqual(missing.missing, ['frame_drops']);
  await refused('raw', csv([[1, 2, 3]], { header: null }), {}, 422, 'no_header');
  await refused('raw', csv(session(6, 2)), { device: undefined }, 422, 'no_device');
  await refused('raw', csv([]), {}, 422, 'no_rows');

  assert.equal(await stored(), rows, 'none of these wrote a row');
});

test('values are checked per line: bad lines are named, good lines are stored', async () => {
  const device = 'Checked Phone';
  const text = csv([
    [at(7, 0), 90, 36, 1, 'good'], // line 2
    [at(7, 10), 140, 37, 1, 'battery too high'],
    [at(7, 20), 'full', 37, 1, 'battery not a number'],
    [at(7, 30), 80, 'hot', 1, 'temperature not a number'],
    [at(7, 40), 80, 250, 1, 'temperature out of range'],
    [at(7, 50), 80, 38, -1, 'negative drops'],
    [at(7, 60), 80, 38, 2.5, 'half a drop'],
    ['yesterday evening', 80, 38, 1, 'time not readable'],
    ['2026-02-30 10:00', 80, 38, 1, 'no such day'],
    [at(7, 70), 70, 39, 4, 'good, with a comma'], // line 11
    [at(7, 70), 70, 39, 4, 'good, with a comma'], // the same line again
    [at(7, 70), 60, 39, 4, 'same time, other values'], // line 13
    [at(7, 80), '', 39, 4, 'battery left empty'],
  ]);
  const answer = await send('file', text, { device });
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual([answer.json.rows_in_file, answer.json.added, answer.json.rejected_count], [13, 2, 10]);
  assert.deepEqual(answer.json.rejected.map((line) => line.line), [3, 4, 5, 6, 7, 8, 9, 10, 13, 14]);
  const reasons = answer.json.rejected.map((line) => line.reason).join('\n');
  for (const word of ['battery "140"', 'battery "full"', 'temperature "hot"', 'temperature "250"', 'frame drops "-1"', 'frame drops "2.5"', 'time "yesterday evening"', 'time "2026-02-30 10:00"', 'different values', 'battery ""']) {
    assert.ok(reasons.includes(word), `a reason names ${word}`);
  }
  assert.deepEqual([phone(answer, device).readings, phone(answer, device).avg_temperature], [2, 37.5]);

  // Every line bad: refused as a whole.
  const allBad = await send('raw', csv([[at(7, 0), 400, 36, 1, 'x']]), { device });
  assert.deepEqual([allBad.status, allBad.json.error, allBad.json.rejected_count], [422, 'no_rows', 1]);
});

test('a file read before the export was finished (cut off)', async () => {
  const device = 'Cut Phone';
  const rows = session(8, 6).map((row, i) => [...row.slice(0, 4), `note ${i + 1}, with "quotes" and a comma`]);
  const full = csv(rows);

  // Cut in the middle of the last line: one field too few.
  const cutMidRow = full.slice(0, full.lastIndexOf(at(8, 50)) + 19);
  const partial = await send('file', cutMidRow, { device });
  assert.equal(partial.status, 200, partial.text);
  assert.deepEqual([partial.json.added, partial.json.rejected_count, partial.json.rejected[0].line], [5, 1, 7]);
  assert.match(partial.json.rejected[0].reason, /of 5 columns.*cut off/);
  const resent = await send('file', full, { device });
  assert.deepEqual([resent.json.added, resent.json.already_stored, resent.json.conflict_count], [1, 5, 0], 'the complete file adds only the missing line');
  assert.equal(phone(resent, device).readings, 6);

  // Cut inside a quoted note: the whole file is refused, nothing is stored.
  const other = 'Cut Phone 2';
  const cutInQuote = full.slice(0, full.length - 12);
  const refused = await send('raw', cutInQuote, { device: other });
  assert.deepEqual([refused.status, refused.json.error], [422, 'cut_off']);
  assert.equal(phone(await comparison(), other), undefined);
  assert.equal((await send('raw', full, { device: other })).json.added, 6);

  // Cut inside an unquoted last note: it cannot be told from a short note, so
  // the short note is stored. The complete file reports it instead of adding a second row.
  const third = 'Cut Phone 3';
  const plain = csv(session(8, 3));
  const short = await send('json', plain.slice(0, plain.length - 5), { device: third });
  assert.deepEqual([short.json.added, short.json.rejected_count], [3, 0]);
  const whole = await send('json', plain, { device: third });
  assert.deepEqual([whole.json.added, whole.json.conflict_count], [0, 1]);
  assert.deepEqual([whole.json.conflicts[0].stored.note, whole.json.conflicts[0].in_this_file.note], ['readi', 'reading 3']);
  assert.equal(phone(whole, third).readings, 3);
});

test('an upload that breaks off on the way stores nothing', async () => {
  // The phone loses its connection after half of the body. Checked by hand in
  // the executions list: the cut JSON upload started no run, the cut raw
  // (text/csv) upload did start one, which stored nothing. This test only
  // asserts what matters to the data: no row and no file record.
  const device = 'Dropped Phone';
  const text = csv(session(8, 6));
  const { hostname, port } = new URL(N8N);
  for (const type of ['text/csv', 'application/json']) {
    const body = type === 'text/csv' ? text : JSON.stringify({ csv: text });
    await new Promise((resolve, reject) => {
      const socket = connect(Number(port), hostname, () => {
        socket.write(`POST /webhook/game-log/intake?device=${encodeURIComponent(device)} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nX-Log-Key: ${KEY}\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
        socket.write(body.slice(0, Math.floor(body.length / 2)), () => setTimeout(() => socket.destroy(), 300));
      });
      socket.on('close', resolve);
      socket.on('error', reject);
    });
  }
  await sleep(1500);
  assert.equal(phone(await comparison(), device), undefined, 'no row from the broken uploads');
  const whole = await send('raw', text, { device });
  assert.deepEqual([whole.json.duplicate_file, whole.json.added], [false, 6], 'and no file record either: the complete upload is new');
});

test('the same file fired many times at the same moment adds its rows once', async (t) => {
  const forms = ['file', 'raw', 'json'];
  let duplicateAnswers = 0;
  for (let round = 0; round < 6; round++) {
    const device = `Burst Phone ${round}`;
    const text = csv(session(9, 12, round));
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => send(forms[i % 3], text, { device })));
    for (const answer of answers) assert.equal(answer.status, 200, answer.text);
    assert.equal(
      answers.reduce((sum, answer) => sum + answer.json.added, 0),
      12,
      `round ${round}: the 8 copies together added 12 rows, got ${answers.map((answer) => answer.json.added).join(',')}`,
    );
    duplicateAnswers += answers.filter((answer) => answer.json.duplicate_file).length;
    const after = await comparison();
    assert.equal(phone(after, device).readings, 12, `round ${round}: 12 readings are stored`);
    assert.equal(phone(after, device).frame_drops_total, 66);
    const late = await send('raw', text, { device });
    assert.deepEqual([late.json.duplicate_file, late.json.added], [true, 0]);
  }
  t.diagnostic(`48 simultaneous copies in 6 rounds: ${duplicateAnswers} were stopped by the file hash, the rest by the row keys`);
});

test('overlapping exports from one phone at the same moment', async () => {
  for (let round = 0; round < 4; round++) {
    const device = `Racing Phone ${round}`;
    const all = session(10, 15, round);
    const windows = [all.slice(0, 8), all.slice(4, 12), all.slice(7, 15), all];
    const answers = await Promise.all([...windows, ...windows].map((rows, i) => send(['raw', 'file', 'json'][i % 3], csv(rows), { device })));
    for (const answer of answers) assert.equal(answer.status, 200, answer.text);
    assert.equal(
      answers.reduce((sum, answer) => sum + answer.json.added, 0),
      15,
      `round ${round}: got ${answers.map((answer) => answer.json.added).join(',')}`,
    );
    assert.equal(
      answers.reduce((sum, answer) => sum + answer.json.conflict_count, 0),
      0,
    );
    const numbers = phone(await comparison(), device);
    assert.deepEqual([numbers.readings, numbers.frame_drops_total, numbers.avg_battery_drain_per_session], [15, 105, 28]);
  }
});

test('two phones posting at the same moment both arrive complete', async () => {
  for (let round = 0; round < 8; round++) {
    const a = `Phone A ${round}`;
    const b = `Phone B ${round}`;
    const [first, second] = await Promise.all([
      send('file', csv(session(11, 10, round)), { device: a }),
      send('raw', csv(session(11, 7, round).map(([time, battery, temp, drops, note]) => [note, time, `${temp}`.replace('.', ','), battery, drops * 2]), { separator: ';', header: ['Note', 'Time', 'Temp', 'Battery', 'Drops'] }), { device: b }),
    ]);
    assert.deepEqual([first.status, first.json.added, second.status, second.json.added], [200, 10, 200, 7], `round ${round}`);
    const after = await comparison();
    assert.deepEqual([phone(after, a).readings, phone(after, a).max_temperature, phone(after, a).frame_drops_total], [10, 40.5, 45]);
    assert.deepEqual([phone(after, b).readings, phone(after, b).max_temperature, phone(after, b).frame_drops_total], [7, 39, 42]);
  }
});

test('the comparison: sessions, drain per session, frame drops per hour', async () => {
  // Phone A: two sessions split by a pause of more than 30 minutes, and one lone reading in the evening.
  const a = 'Compare A';
  const first = await send(
    'file',
    csv([
      [at(12, 0), 90, 36, 2, 's1'],
      [at(12, 15), 86, 38, 5, 's1'],
      [at(12, 30), 80, 40, 9, 's1'], // 10 % in 0.5 h, 16 drops
      [at(12, 240), 70, 35, 0, 's2'],
      [at(12, 260), 64, 39.5, 4, 's2'],
      [at(12, 280), 55, 42.5, 10, 's2'], // 15 % in 0.667 h, 14 drops
      [at(12, 600), 50, 30, 1, 'alone'],
    ]),
    { device: a },
  );
  assert.equal(first.json.added, 7);
  // Phone B: the file names its sessions and has no time.
  const b = 'Compare B';
  const second = await send(
    'raw',
    csv(
      [
        ['run 1', 100, 33, 1, 'a'],
        ['run 1', 97, 34, 1, 'b'],
        ['run 1', 91, 35, 1, 'c'], // 9 %
        ['run 2', 80, 40, 3, 'd'],
        ['run 2', 70, 41, 4, 'e'], // 10 %
      ],
      { header: ['Session', 'Battery', 'Temp', 'Frame drops', 'Note'] },
    ),
    { device: b },
  );
  assert.equal(second.json.added, 5);

  const expectA = {
    device: a,
    readings: 7,
    sessions: 3,
    avg_temperature: 37.29, // 261 / 7
    max_temperature: 42.5,
    avg_battery_drain_per_session: 12.5, // (10 + 15) / 2; the lone reading has no drain
    frame_drops_total: 31,
    frame_drops_per_hour: 25.71, // 30 drops in 0.5 h + 0.667 h; the lone reading has no duration
    hours_logged: 1.17,
    first_reading: '2026-10-12T10:00:00',
    last_reading: '2026-10-12T20:00:00',
  };
  const expectB = {
    device: b,
    readings: 5,
    sessions: 2,
    avg_temperature: 36.6,
    max_temperature: 41,
    avg_battery_drain_per_session: 9.5,
    frame_drops_total: 10,
    frame_drops_per_hour: null, // no clock, no hours
    hours_logged: 0,
    first_reading: null,
    last_reading: null,
  };
  assert.deepEqual(phone(second, a), expectA, 'in the answer to the upload');
  assert.deepEqual(phone(second, b), expectB);
  const asked = await comparison();
  assert.deepEqual(phone(asked, a), expectA, 'and from the GET address');
  assert.deepEqual(phone(asked, b), expectB);
  assert.deepEqual(asked.json.comparison.map((entry) => entry.device), [...asked.json.comparison.map((entry) => entry.device)].sort((x, y) => x.localeCompare(y)), 'sorted by device');
  assert.ok(asked.json.summary.includes(`${a}: 7 readings, avg 37.29 °C, max 42.5 °C, drain 12.5 % per session, 25.71 frame drops per hour`), asked.json.summary);
  assert.equal(asked.json.rows_stored, asked.json.comparison.reduce((sum, entry) => sum + entry.readings, 0));

  // A later export with one more reading moves the numbers of that phone only.
  const third = await send('json', csv([[at(12, 290), 52, 43, 6, 's2 goes on']]), { device: a });
  assert.equal(third.json.added, 1);
  assert.deepEqual(
    [phone(third, a).readings, phone(third, a).max_temperature, phone(third, a).avg_battery_drain_per_session, phone(third, a).frame_drops_per_hour],
    [8, 43, 14, 27], // (10 + 18) / 2; 36 drops in 0.5 h + 0.833 h
  );
  assert.deepEqual(phone(third, b), expectB);
});

test('a long export: 300 rows, then the same export with one new row', async (t) => {
  const device = 'Long Phone';
  const rows = Array.from({ length: 300 }, (_, i) => [at(13 + Math.floor(i / 60), (i % 60) * 5), 100 - (i % 60), 30 + (i % 25) * 0.5, i % 7, `row ${i + 1}`]);
  let started = Date.now();
  const first = await send('file', csv(rows), { device });
  const firstSeconds = (Date.now() - started) / 1000;
  assert.deepEqual([first.status, first.json.added], [200, 300], first.text.slice(0, 300));
  started = Date.now();
  const second = await send('file', csv([...rows, [at(20, 0), 50, 33, 1, 'the new one']]), { device });
  assert.deepEqual([second.json.added, second.json.already_stored], [1, 300]);
  assert.equal(phone(second, device).readings, 301);
  t.diagnostic(`300 new rows: ${firstSeconds.toFixed(1)} s; 301 rows of which 1 new: ${((Date.now() - started) / 1000).toFixed(1)} s`);
});
