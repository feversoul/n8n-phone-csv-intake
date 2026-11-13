// npm run test:e2e
// Starts the test stack (a real n8n with the workflows imported), runs
// test/e2e.test.mjs against it and removes the stack again. Then starts it
// once more with a Google credential that cannot work and runs
// test/sheet-fail.test.mjs. Set KEEP_STACK=1 to leave the last stack running,
// for example to open the n8n editor on http://localhost:55704.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status ?? 1;

function phase(envFile, testFile, last) {
  const compose = ['compose', '--env-file', envFile, '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-p', 'csvintake-test'];
  run('docker', [...compose, 'down', '-v']);
  let status = run('docker', [...compose, 'up', '-d']);
  if (status === 0) status = run(process.execPath, ['--test', '--test-reporter=spec', testFile]);
  if (status !== 0) run('docker', [...compose, 'logs', '--tail', '60', 'n8n']);
  if (!(last && process.env.KEEP_STACK)) run('docker', [...compose, 'down', '-v']);
  return status;
}

let status = phase('test/test.env', 'test/e2e.test.mjs', false);
if (status === 0) status = phase('test/sheet-fail.env', 'test/sheet-fail.test.mjs', true);
process.exit(status);
