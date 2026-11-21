import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startManagementDashboard } from '../src/management-dashboard.js';
import { listSkillDeliveries } from '../src/skill-delivery.js';
import { setSkillCategoryState } from '../src/skill-selection.js';

const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const react = 'Review React accessibility with keyboard navigation';
const vue = 'Improve Vue reactivity system';

function runCli(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...args], { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) return reject(error);
      if (stderr) return reject(new Error(stderr));
      resolve(stdout);
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}

async function deliver(project, agent, query) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'category-delivery-test', version: '1.0.0' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'select_skills', arguments: { query } } },
  ];
  const options = ['--project', project, '--agent', agent];
  const [hook, mcp] = await Promise.all([
    runCli(['hook', ...options], JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: project, prompt: query })),
    runCli(['mcp', ...options], rpc.map(message => JSON.stringify(message)).join('\n') + '\n'),
  ]);
  const [initialized, response] = mcp.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal(response.id, 2);
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, undefined);
  if (!hook) {
    assert.deepEqual(response.result.content, []);
    return [];
  }
  const { hookEventName, additionalContext } = JSON.parse(hook).hookSpecificOutput;
  assert.equal(hookEventName, 'UserPromptSubmit');
  assert.deepEqual(response.result.content, [{ type: 'text', text: additionalContext }]);
  const paths = [...additionalContext.matchAll(/^Catalog file `([^`]+)`$/gmu)].map(([, skillPath]) => skillPath);
  assert.ok(paths.length > 0, 'A nonempty delivery must identify its catalog skills.');
  return paths;
}

function assertCategory(paths, category) {
  assert.ok(paths.length > 0, `Expected guidance for ${category}.`);
  assert.ok(paths.every(skillPath => skillPath.startsWith(category + '/')));
}

async function dashboardCategory(url, category, agent, status, expectedRevision) {
  const response = await fetch(url + '/api/category-preferences', {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, agent, status, expectedRevision }),
  });
  const state = await response.json();
  assert.equal(response.status, 200, JSON.stringify(state));
  assert.equal(state.revision, expectedRevision + 1);
  return state.revision;
}

test('dashboard and CLI category preferences gate actual hook and MCP delivery per project and agent', async t => {
  const temporaryDirectory = path.resolve(tmpdir());
  const scratch = await mkdtemp(path.join(temporaryDirectory, 'osf-category-delivery-'));
  assert.equal(path.dirname(path.resolve(scratch)), temporaryDirectory);
  assert.match(path.basename(scratch), /^osf-category-delivery-/u);
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = path.join(scratch, 'configured');
  const other = path.join(scratch, 'independent');
  await Promise.all([mkdir(project), mkdir(other)]);
  const dashboard = await startManagementDashboard({ projectRoot: project });
  t.after(() => dashboard.close());
  const agent = 'codex';
  const otherAgent = 'claude-code';

  const childPreference = await setSkillCategoryState({
    project, category: 'web-dev/react', agent, status: 'enabled', expectedRevision: 0,
  });
  const disabledFamily = await dashboardCategory(dashboard.url, 'web-dev', agent, 'disabled', childPreference.revision);
  const [deniedReact, deniedVue, otherAgentPaths, otherProjectPaths] = await Promise.all([
    deliver(project, agent, react),
    deliver(project, agent, vue),
    deliver(project, otherAgent, react),
    deliver(other, agent, react),
  ]);
  assert.deepEqual(deniedReact, []);
  assert.deepEqual(deniedVue, []);
  assertCategory(otherAgentPaths, 'web-dev/react');
  assertCategory(otherProjectPaths, 'web-dev/react');
  assert.deepEqual(await listSkillDeliveries({ project, agent }), []);
  for (const [root, actingAgent, paths] of [[project, otherAgent, otherAgentPaths], [other, agent, otherProjectPaths]]) {
    const receipts = await listSkillDeliveries({ project: root });
    assert.deepEqual(receipts.map(row => row.method).sort(), ['hook', 'mcp']);
    assert.ok(receipts.every(row => row.agent === actingAgent));
    for (const receipt of receipts) assert.deepEqual(receipt.paths, paths);
  }

  await dashboardCategory(dashboard.url, 'web-dev', agent, 'enabled', disabledFamily);
  const categoryOptions = ['--category', 'web-dev/react', '--project', project, '--agent', agent];
  await runCli(['disable', ...categoryOptions]);
  const [disabledReact, allowedVue] = await Promise.all([deliver(project, agent, react), deliver(project, agent, vue)]);
  assert.deepEqual(disabledReact, []);
  assertCategory(allowedVue, 'web-dev/vue');
  const afterSubcategoryDisable = await listSkillDeliveries({ project, agent });
  assert.deepEqual(afterSubcategoryDisable.map(row => row.method).sort(), ['hook', 'mcp']);
  for (const receipt of afterSubcategoryDisable) assert.deepEqual(receipt.paths, allowedVue);

  await runCli(['enable', ...categoryOptions]);
  const restored = await deliver(project, agent, react);
  assertCategory(restored, 'web-dev/react');
  const history = await listSkillDeliveries({ project, agent });
  assert.equal(history.length, 4);
  const previousIds = new Set(afterSubcategoryDisable.map(row => row.id));
  const restoredReceipts = history.filter(row => !previousIds.has(row.id));
  assert.deepEqual(restoredReceipts.map(row => row.method).sort(), ['hook', 'mcp']);
  for (const receipt of restoredReceipts) assert.deepEqual(receipt.paths, restored);
});
