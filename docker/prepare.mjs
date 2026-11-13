// Used by bootstrap.sh inside the n8n container: writes the import files for
// the n8n CLI from the environment, so no secret is stored in the repository.
//   node prepare.mjs <workflows dir> <output dir>

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, out] = process.argv.slice(2);
const env = process.env;

const credentials = [{ id: 'phoneCsvKey', name: 'Game Log Key', type: 'httpHeaderAuth', data: { name: 'X-Log-Key', value: env.GAME_LOG_KEY } }];

mkdirSync(join(out, 'workflows'), { recursive: true });

// Settings that can come from the environment. Each is a `const NAME = value;`
// line in the Settings node.
const numbers = ['SESSION_GAP_MINUTES', 'MAX_ROWS'];

// With a spreadsheet id and a Google service account in the environment, the
// two Google Sheets nodes are switched on and pointed at that spreadsheet.
const sheets = env.GOOGLE_SHEET_ID && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY;
if (sheets) {
  credentials.push({
    id: 'phoneCsvGoogle',
    name: 'Game Log Google',
    type: 'googleApi',
    data: { region: 'us-central1', email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, privateKey: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') },
  });
}

writeFileSync(join(out, 'credentials.json'), JSON.stringify(credentials));

const ids = [];
for (const file of readdirSync(source).filter((name) => name.endsWith('.json')).sort()) {
  const workflow = JSON.parse(readFileSync(join(source, file), 'utf8'));
  for (const node of workflow.nodes) {
    if (sheets && node.type === 'n8n-nodes-base.googleSheets') {
      node.disabled = false;
      node.parameters.authentication = 'serviceAccount';
      node.parameters.documentId = { __rl: true, mode: 'id', value: env.GOOGLE_SHEET_ID };
      node.credentials = { googleApi: { id: 'phoneCsvGoogle', name: 'Game Log Google' } };
    }
    if (typeof node.parameters.jsCode !== 'string') continue;
    let code = node.parameters.jsCode;
    for (const name of numbers) {
      if (Number(env[name]) > 0) code = code.replace(new RegExp(`const ${name} = [0-9.]+;`), `const ${name} = ${Number(env[name])};`);
    }
    node.parameters.jsCode = code;
  }
  ids.push(workflow.id);
  writeFileSync(join(out, 'workflows', file), JSON.stringify(workflow));
}
writeFileSync(join(out, 'ids'), ids.join('\n'));
