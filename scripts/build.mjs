// Builds workflows/*.json.
//
// The workflows are plain n8n exports: import them and they run, no build
// needed. This script exists so the JavaScript of the Code nodes can live in
// readable files (src/*.js). After changing one, run:
//   node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, 'src', `${name}.js`), 'utf8').trimEnd();
const source = (name) => read(name).replace('__SHA256__', () => read('sha256'));

const ROWS = 'game_log_rows';
const FILES = 'game_log_files';
const table = (name) => ({ __rl: true, mode: 'name', value: name });

const IDS = { setup: 'phoneCsvSetup001', intake: 'phoneCsvIntake01' };

// The credential is matched by name on import: create it with exactly this
// name before importing and both webhooks pick it up.
const KEY = { httpHeaderAuth: { id: 'phoneCsvKey', name: 'Game Log Key' } };

const ROW_COLUMNS = [
  ['row_key', 'string'], // what makes a reading "the same reading": see "Parse and check"
  ['content_hash', 'string'], // changes when any value of the reading changes
  ['token', 'string'], // the run that stored the row
  ['file_hash', 'string'],
  ['device', 'string'],
  ['logged_at', 'string'], // 2026-10-28T14:05:00, as written on the phone, no time zone
  ['session', 'string'],
  ['battery', 'number'],
  ['temperature', 'number'],
  ['frame_drops', 'number'],
  ['note', 'string'],
  ['entry_id', 'string'],
];
const FILE_COLUMNS = [
  ['file_hash', 'string'], // SHA-256 of the text
  ['token', 'string'],
  ['status', 'string'], // received, done, duplicate, failed
  ['device', 'string'],
  ['filename', 'string'],
  ['form', 'string'], // file upload, raw body, text field
  ['rows_in_file', 'number'],
  ['rows_added', 'number'],
  ['received_at', 'date'],
];

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const mapped = (columns, values) => ({
  mappingMode: 'defineBelow',
  value: values,
  matchingColumns: [],
  schema: columns
    .filter(([column]) => column in values)
    .map(([column, type]) => ({
      id: column,
      displayName: column,
      required: false,
      defaultMatch: false,
      display: true,
      type: type === 'date' ? 'dateTime' : type,
      canBeUsedToMatch: true,
    })),
  attemptToConvertTypes: false,
  convertFieldsToString: false,
});
// where('a', 1, 'b', 2): rows with a = 1 and b = 2
const where = (...pairs) => ({
  matchType: 'allConditions',
  filters: { conditions: Array.from({ length: pairs.length / 2 }, (_, i) => ({ keyName: pairs[i * 2], condition: 'eq', keyValue: pairs[i * 2 + 1] })) },
});

function workflow(id, name, build) {
  const nodes = [];
  const connections = {};
  const w = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uuid(`${id}/${nodeName}`), name: nodeName, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra });
      return nodeName;
    },
    note(nodeName, lines, position, width, height, color = 4) {
      return w.node(nodeName, 'stickyNote', 1, position, { content: lines.join('\n'), width, height, color });
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
    chain(...names) {
      for (let i = 0; i < names.length - 1; i++) w.link(names[i], names[i + 1]);
    },
    hook(nodeName, method, path, position) {
      return w.node(
        nodeName,
        'webhook',
        2,
        position,
        { httpMethod: method, path: `game-log/${path}`, authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
        { webhookId: uuid(`${id}/webhook/${method}/${path}`), credentials: KEY },
      );
    },
    code(nodeName, position, file) {
      return w.node(nodeName, 'code', 2, position, { jsCode: source(file) });
    },
    // Data Table row operation. It always passes at least one item on (an
    // empty one when nothing came back), so the next node runs.
    rows(nodeName, position, tableName, operation, parameters, extra = {}) {
      return w.node(nodeName, 'dataTable', 1.1, position, { resource: 'row', operation, dataTableId: table(tableName), ...parameters }, { alwaysOutputData: true, ...extra });
    },
    when(nodeName, position, expression, extra = {}) {
      return w.node(
        nodeName,
        'if',
        2.2,
        position,
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
            conditions: [{ id: uuid(`${id}/${nodeName}/condition`), leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
            combinator: 'and',
          },
          options: { looseTypeValidation: true },
        },
        extra,
      );
    },
    createTable(nodeName, position, tableName, columns) {
      return w.node(nodeName, 'dataTable', 1.1, position, {
        resource: 'table',
        operation: 'create',
        tableName,
        columns: { column: columns.map(([name, type]) => ({ name, type })) },
        options: { createIfNotExists: true },
      });
    },
  };
  build(w);
  return { name, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, id };
}

// --- 0. Setup ----------------------------------------------------------------

const setup = workflow(IDS.setup, 'Phone CSV Intake · 0 Setup', (w) => {
  w.note(
    'About',
    [
      '## Phone CSV Intake · Setup',
      `Run this once: press **Execute workflow**. It creates two data tables: \`${ROWS}\` (one row per reading) and \`${FILES}\` (one row per upload). Running it again changes nothing.`,
      '',
      'The webhook does the same for scripted installs. You can delete it.',
    ],
    [-40, -260],
    560,
    200,
  );
  w.node('Run once', 'manualTrigger', 1, [0, 0], {});
  w.hook('Or call', 'POST', 'setup', [0, 180]);
  w.createTable('Create rows table', [240, 0], ROWS, ROW_COLUMNS);
  w.createTable('Create files table', [460, 0], FILES, FILE_COLUMNS);
  w.code('Done', [680, 0], 'setup-result');
  w.node('Answer', 'respondToWebhook', 1.1, [900, 0], { respondWith: 'json', responseBody: '={{ $json }}', options: { responseCode: 200 } });
  w.link('Run once', 'Create rows table');
  w.link('Or call', 'Create rows table');
  w.chain('Create rows table', 'Create files table', 'Done', 'Answer');
});

// --- 1. Intake ---------------------------------------------------------------

const settings = "$('Settings').first().json";
const sheet = (w, nodeName, position, operation, tab, matching, extra) =>
  w.node(
    nodeName,
    'googleSheets',
    4.7,
    position,
    {
      resource: 'sheet',
      operation,
      documentId: { __rl: true, mode: 'list', value: '' },
      sheetName: { __rl: true, mode: 'name', value: tab },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: matching, schema: [] },
      options: {},
    },
    // Switched off in the export: n8n does not publish a workflow with a node
    // that has no credential yet. A switched-off node passes its items on.
    { disabled: true, ...extra },
  );

const intake = workflow(IDS.intake, 'Phone CSV Intake · 1 Intake', (w) => {
  w.note(
    'About',
    [
      '## Phone CSV Intake',
      'A shortcut on the phone posts the exported CSV to **Phone posts CSV**. The rows are checked, stored once, and the answer carries a comparison per phone. **Ask for comparison** (GET) returns the comparison alone.',
      '',
      'The phone can send the CSV in three ways, all to the same address: as a **file upload** (form, any field name), as the **raw text** in the body, or as **JSON** `{ "csv": "..." }`. Add `?device=NAME` to the address so each phone says which one it is (not needed when the file has a device column).',
      '',
      '1. **Parse and check** finds the separator (comma, semicolon, tab), reads quoted notes with commas and line breaks, reads `38,5` as 38.5, and maps the columns by their header in any order. A file that still has one column is refused with an answer that says so. Nothing is written.',
      '2. **The same file twice**: the hash of the text is looked up in `game_log_files`. A file that was fully imported before (for the same `?device=`) stops here.',
      '3. **The same reading twice** (overlapping exports, two copies at the same moment): every row is inserted with a key, then the row with the lowest id per key stays and the others are removed. See the note on the right.',
      '4. **Google Sheet**: the two Google Sheets nodes are switched off until you set them up. See the note below them.',
      '5. **Compare devices** is worked out again from all stored rows.',
      '',
      'Start with **Settings**.',
    ],
    [-60, -700],
    860,
    460,
  );

  w.hook('Phone posts CSV', 'POST', 'intake', [0, 0]);
  w.hook('Ask for comparison', 'GET', 'comparison', [0, 200]);
  w.code('Settings', [240, 0], 'settings');
  w.when('An upload?', [460, 0], "$('Phone posts CSV').isExecuted");
  w.code('Read the upload', [680, -100], 'read-upload');
  w.code('Parse and check', [900, -100], 'parse');
  w.when('Understood?', [1120, -100], '$json.ok');

  // The same file twice
  w.rows('Note the file', [1340, -200], FILES, 'insert', {
    columns: mapped(FILE_COLUMNS, {
      file_hash: '={{ $json.file_hash }}',
      token: `={{ ${settings}.token }}`,
      status: 'received',
      device: '={{ $json.device }}',
      filename: '={{ $json.filename }}',
      form: '={{ $json.form }}',
      rows_in_file: '={{ $json.rows_in_file }}',
      received_at: '={{ $now.toISO() }}',
    }),
    options: {},
  });
  w.rows('Same file before', [1560, -200], FILES, 'get', {
    // The same text from another phone is another file: the device from the address is part of what it means.
    ...where('file_hash', "={{ $('Parse and check').first().json.file_hash }}", 'device', "={{ $('Parse and check').first().json.device }}"),
    returnAll: true,
  });
  w.code('Seen this file?', [1780, -200], 'file-check');
  w.when('New file?', [2000, -200], '!$json.duplicate_file');
  const fileStatus = (nodeName, position, status, values = {}) =>
    w.rows(nodeName, position, FILES, 'update', { ...where('token', `={{ ${settings}.token }}`), columns: mapped(FILE_COLUMNS, { status, ...values }), options: {} }, { executeOnce: true });
  fileStatus('File was a duplicate', [2220, 0], 'duplicate', { rows_added: 0 });

  // The same reading twice
  w.code('Rows of the file', [2220, -300], 'rows-to-claim');
  w.rows('Claim rows', [2440, -300], ROWS, 'insert', {
    columns: mapped(
      ROW_COLUMNS,
      Object.fromEntries(ROW_COLUMNS.map(([column]) => [column, `={{ $json.${column} }}`])),
    ),
    options: {},
  });
  w.rows('Rows with the same key', [2660, -300], ROWS, 'get', { ...where('row_key', '={{ $json.row_key }}'), returnAll: true });
  w.code('Keep the first', [2880, -300], 'keep-first');
  w.when('Any duplicate rows?', [3100, -300], '$json.remove.length > 0');
  w.code('Duplicate rows', [3320, -400], 'duplicates');
  w.rows('Remove duplicate rows', [3540, -400], ROWS, 'deleteRows', { ...where('id', '={{ $json.id }}'), options: {} });

  // Google Sheet
  w.when('Any new rows?', [3760, -300], "$('Keep the first').first().json.added.length > 0", { executeOnce: true });
  w.code('New rows for the sheet', [3980, -420], 'sheet-rows');
  sheet(w, 'Append to Log tab', [4200, -420], 'append', 'Log', [], { onError: 'continueErrorOutput' });
  w.rows('Take the rows back', [4440, -240], ROWS, 'deleteRows', { ...where('token', `={{ ${settings}.token }}`), options: {} }, { executeOnce: true });
  fileStatus('File failed', [4660, -240], 'failed', { rows_added: 0 });
  fileStatus('File done', [4660, -420], 'done', { rows_added: "={{ $('Keep the first').first().json.added.length }}" });

  // Comparison
  w.rows('All rows', [4900, 0], ROWS, 'get', { matchType: 'allConditions', filters: {}, returnAll: true }, { executeOnce: true });
  w.code('Compare devices', [5120, 0], 'compare');
  w.when('After an upload?', [5340, 0], "$('Phone posts CSV').isExecuted");
  w.code('Comparison rows', [5560, -100], 'comparison-rows');
  sheet(w, 'Update Comparison tab', [5780, -100], 'appendOrUpdate', 'Comparison', ['device'], { onError: 'continueRegularOutput', alwaysOutputData: true });
  w.code('Result', [6020, 0], 'result');
  w.node('Answer', 'respondToWebhook', 1.1, [6240, 0], { respondWith: 'json', responseBody: '={{ $json.body }}', options: { responseCode: '={{ $json.code }}' } });

  w.link('Phone posts CSV', 'Settings');
  w.link('Ask for comparison', 'Settings');
  w.chain('Settings', 'An upload?');
  w.link('An upload?', 'Read the upload', 0);
  w.link('An upload?', 'All rows', 1);
  w.chain('Read the upload', 'Parse and check', 'Understood?');
  w.link('Understood?', 'Note the file', 0);
  w.link('Understood?', 'Result', 1);
  w.chain('Note the file', 'Same file before', 'Seen this file?', 'New file?');
  w.link('New file?', 'Rows of the file', 0);
  w.link('New file?', 'File was a duplicate', 1);
  w.link('File was a duplicate', 'All rows');
  w.chain('Rows of the file', 'Claim rows', 'Rows with the same key', 'Keep the first', 'Any duplicate rows?');
  w.link('Any duplicate rows?', 'Duplicate rows', 0);
  w.link('Any duplicate rows?', 'Any new rows?', 1);
  w.chain('Duplicate rows', 'Remove duplicate rows', 'Any new rows?');
  w.link('Any new rows?', 'New rows for the sheet', 0);
  w.link('Any new rows?', 'File done', 1);
  w.chain('New rows for the sheet', 'Append to Log tab');
  w.link('Append to Log tab', 'File done', 0);
  w.link('Append to Log tab', 'Take the rows back', 1);
  w.chain('Take the rows back', 'File failed', 'Result');
  w.chain('File done', 'All rows', 'Compare devices', 'After an upload?');
  w.link('After an upload?', 'Comparison rows', 0);
  w.link('After an upload?', 'Result', 1);
  w.chain('Comparison rows', 'Update Comparison tab', 'Result', 'Answer');

  w.note(
    'Duplicates note',
    [
      '### Why insert first, then look',
      'Data tables have no unique column. "Look whether the row exists, then insert" lets two runs that start together both insert. So each run inserts first and then reads the rows for its keys: the lowest id per key stays, and a run removes its own row when another one was first. Every run sees the same order, so they agree.',
      '',
      'What counts as the same reading: the `id` column of the file when it has one; else phone + time; else the whole row. A reading that is already stored with other values is not overwritten. It is listed under `conflicts` in the answer.',
    ],
    [2400, -100],
    640,
    230,
    5,
  );
  w.note(
    'Sheets note',
    [
      '### Google Sheet: set up, then switch on',
      '1. In your spreadsheet make a tab **Log** with this header row: `logged_at`, `device`, `battery`, `temperature`, `frame_drops`, `note`, `session`, `row_key`. Make a tab **Comparison** with: `device`, `readings`, `sessions`, `avg_temperature`, `max_temperature`, `avg_battery_drain_per_session`, `frame_drops_total`, `frame_drops_per_hour`, `hours_logged`, `first_reading`, `last_reading`.',
      '2. Open **Append to Log tab** and **Update Comparison tab**: pick your Google credential and the spreadsheet.',
      '3. Switch both nodes on (select the node, press **D**), save and publish. Until then they pass the rows through and nothing goes to Google.',
      '',
      'If the append fails, the rows of this run are taken out of the data table again and the phone gets a 502, so sending the file again adds them. Only new rows reach the sheet.',
      '',
      '**Do not put a Google Sheets Trigger on the Log or Comparison tab.** This workflow writes to both, and every write would fire that trigger again. If another workflow should react to new rows, let it watch a different tab, or call it from here after **File done**.',
    ],
    [3940, -160],
    460,
    470,
    5,
  );
});

// --- write -------------------------------------------------------------------

export const workflows = {
  '0-setup.json': setup,
  '1-intake.json': intake,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(root, 'workflows');
  mkdirSync(out, { recursive: true });
  for (const [file, definition] of Object.entries(workflows)) {
    writeFileSync(join(out, file), `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`workflows/${file}: ${definition.nodes.length} nodes`);
  }
}
