// What happens when the append to the Google Sheet fails. The stack runs with
// the two Google Sheets nodes switched on and a credential that cannot sign in
// (test/sheet-fail.env), so every append fails. No real Google Sheet is involved:
// a successful append is not tested anywhere in this repository.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const N8N = process.env.N8N_URL ?? 'http://localhost:55704';
const HEADERS = { 'x-log-key': process.env.GAME_LOG_KEY ?? 'test-log-key' };

async function call(path, options = {}) {
  const response = await fetch(`${N8N}/webhook/game-log/${path}`, { ...options, headers: { ...HEADERS, ...options.headers } });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON, for example n8n's "starting up" page */
  }
  return { status: response.status, json, text };
}
const upload = (text, device) => call(`intake?device=${encodeURIComponent(device)}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });

const CSV = ['Time,Battery,Temp,Frame drops,Note', '2026-10-28 10:00,90,36,1,a', '2026-10-28 10:10,88,37,2,b', '2026-10-28 10:20,86,38,3,c', ''].join('\n');

before(async () => {
  const deadline = Date.now() + 240_000;
  for (;;) {
    let ready = false;
    try {
      const answer = await call('comparison');
      ready = answer.status === 200 && answer.json?.ok === true;
    } catch {
      /* connection refused or reset while n8n starts */
    }
    if (ready) return;
    if (Date.now() > deadline) throw new Error('n8n did not come up');
    await sleep(1000);
  }
});

test('append fails: the phone gets 502 and the rows are taken out of the data table again', async () => {
  const first = await upload(CSV, 'Sheet Phone');
  assert.deepEqual([first.status, first.json?.ok, first.json?.error, first.json?.rows_in_file], [502, false, 'sheet_append_failed', 3], first.text);
  const after = await call('comparison');
  assert.deepEqual([after.json.rows_stored, after.json.comparison], [0, []], 'no row stayed behind');
});

test('the failed file is not remembered as imported: sending it again is a new try', async () => {
  const again = await upload(CSV, 'Sheet Phone');
  assert.deepEqual([again.status, again.json?.error], [502, 'sheet_append_failed'], again.text);
  assert.equal((await call('comparison')).json.rows_stored, 0);
});

test('a file that cannot be read is still answered with 422, before anything is sent to Google', async () => {
  const answer = await upload('no table here\n', 'Sheet Phone');
  assert.deepEqual([answer.status, answer.json?.error], [422, 'one_column']);
});
