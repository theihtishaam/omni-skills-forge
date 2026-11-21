import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { listWorkspaceSkills } from '../src/workspace-skills.js';

const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const run = promisify(execFile);

async function projectFor(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'omni-simple-'));
  t?.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"react":"19"}}');
  return root;
}

test('dashboard opens the workspace by default and still exports HTML on request', { timeout: 25000 }, async t => {
  const project = await projectFor();
  const child = spawn(process.execPath, [cli, 'dashboard', '--no-open'], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && !child.signalCode) child.kill();
    await closed;
    await rm(project, { recursive: true, force: true });
  });
  const address = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Dashboard exited before serving (' + code + ')')));
    lines.on('line', line => {
      const match = /^Omni Skills Forge dashboard: (http:\/\/127\.0\.0\.1:\d+)$/u.exec(line);
      if (match) resolve(match[1]);
    });
  });
  const details = await (await fetch(address + '/api/project')).json();
  assert.equal(details.name, path.basename(project));
  const output = path.join(project, 'catalog.html');
  await run(process.execPath, [cli, 'dashboard', '--output', output, '--no-open'], { cwd: project });
  assert.match(await readFile(output, 'utf8'), /Omni Skills Forge/i);
});

test('make accepts one sentence and an identical request reuses the saved skill', async t => {
  const project = await projectFor(t);
  const args = [cli, 'make', 'Review keyboard accessibility and form submission in React', '--agent', 'codex'];
  const first = await run(process.execPath, args, { cwd: project });
  assert.match(first.stdout, /^Saved /u);
  assert.match(first.stdout, /web-dev\/react\/.*\.md/u);
  const again = await run(process.execPath, args, { cwd: project });
  assert.match(again.stdout, /^Found /u);
  const { recipes } = await listWorkspaceSkills({ project });
  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].agent, 'codex');
});
