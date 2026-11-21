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
import { listWorkspaceSkills } from '../src/workspace-skills.js';

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

async function mcpTool(project, agent, name, args) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'category-delivery-test', version: '1.0.0' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ];
  const mcp = await runCli(['mcp', '--project', project, '--agent', agent], rpc.map(message => JSON.stringify(message)).join('\n') + '\n');
  const [initialized, response] = mcp.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal(response.id, 2);
  assert.equal(response.error, undefined);
  return response.result;
}

async function deliverContext(project, agent, query) {
  const event = { hook_event_name: 'UserPromptSubmit', cwd: project, prompt: query };
  const [hook, result] = await Promise.all([
    runCli(['hook', '--project', project, '--agent', agent], JSON.stringify(event)),
    mcpTool(project, agent, 'select_skills', { query }),
  ]);
  assert.equal(result.isError, undefined);
  if (!hook) {
    assert.deepEqual(result.content, []);
    return '';
  }
  const { hookEventName, additionalContext } = JSON.parse(hook).hookSpecificOutput;
  assert.equal(hookEventName, 'UserPromptSubmit');
  assert.deepEqual(result.content, [{ type: 'text', text: additionalContext }]);
  return additionalContext;
}

async function deliver(project, agent, query) {
  const context = await deliverContext(project, agent, query);
  if (!context) return [];
  const paths = [...context.matchAll(/^Catalog file `([^`]+)`$/gmu)].map(([, skillPath]) => skillPath);
  assert.ok(paths.length > 0, 'A nonempty delivery must identify its catalog skills.');
  return paths;
}

function assertCategory(paths, category) {
  assert.ok(paths.length > 0, `Expected guidance for ${category}.`);
  assert.ok(paths.every(skillPath => skillPath.startsWith(category + '/')));
}

async function dashboardPreference(url, route, options, expectedRevision) {
  const response = await fetch(url + route, {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...options, expectedRevision }),
  });
  const state = await response.json();
  assert.equal(response.status, 200, JSON.stringify(state));
  assert.equal(state.revision, expectedRevision + 1);
  return state.revision;
}

function dashboardCategory(url, category, agent, status, expectedRevision) {
  return dashboardPreference(url, '/api/category-preferences', { category, agent, status }, expectedRevision);
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

test('the three dashboard preference scopes govern hook delivery, MCP delivery, and workspace skill creation', async t => {
  const temporaryDirectory = path.resolve(tmpdir());
  const project = await mkdtemp(path.join(temporaryDirectory, 'osf-bulk-delivery-'));
  assert.equal(path.dirname(path.resolve(project)), temporaryDirectory);
  assert.match(path.basename(project), /^osf-bulk-delivery-/u);
  t.after(() => rm(project, { recursive: true, force: true }));
  const dashboard = await startManagementDashboard({ projectRoot: project });
  t.after(() => dashboard.close());
  const { url } = dashboard;
  const agent = 'codex';
  const reactSkill = 'web-dev/react/react-accessibility-a11y-advanced-intermediate.md';
  const vueSkill = 'web-dev/vue/vue-reactivity-system-advanced-intermediate.md';
  const sourcePaths = [reactSkill, vueSkill];
  const combinationTask = 'Review React accessibility and Vue reactivity for keyboard navigation';
  const instruction = `Make one workspace skill for this task. ${combinationTask}`;
  const make = options => mcpTool(project, agent, 'make_workspace_skill', { instruction, ...options });
  const all = (status, revision) => dashboardPreference(url, '/api/all-skills-preferences', { agent, status }, revision);
  const skill = (status, revision) => dashboardPreference(url, '/api/preferences', { agent, path: reactSkill, status }, revision);

  const made = await make({ sourcePaths });
  assert.equal(made.isError, undefined);
  assert.match(made.content[0].text, /^Created workspace skill/u);
  const saved = await listWorkspaceSkills({ project });
  assert.equal(saved.recipes.length, 1);
  const [recipe] = saved.recipes;
  assert.deepEqual(recipe.sourcePaths, sourcePaths);
  assert.deepEqual(await listSkillDeliveries({ project, agent }), []);
  const recipePath = `workspace/${recipe.id}.md`;
  const recipeHeading = `Workspace recipe ${recipe.title}`;
  const initialContext = await deliverContext(project, agent, combinationTask);
  assert.ok(initialContext.includes(recipeHeading));
  const initialReceipts = await listSkillDeliveries({ project, agent });
  assert.deepEqual(initialReceipts.map(receipt => receipt.method).sort(), ['hook', 'mcp']);
  assert.ok(initialReceipts.every(receipt => receipt.paths.includes(recipePath)));

  const disabled = await all('disabled', 0);
  const [blank, noMatch] = await Promise.all([
    deliverContext(project, agent, combinationTask), make({ instruction: react }),
  ]);
  assert.equal(blank, '');
  assert.match(noMatch.content[0].text, /No eligible catalog skill/u);
  assert.deepEqual(await listSkillDeliveries({ project, agent }), initialReceipts);

  const oneEnabled = await skill('enabled', disabled);
  const [onlyOne, blockedVue, blockedRecipe, blockedCreation] = await Promise.all([
    deliver(project, agent, react), deliverContext(project, agent, vue),
    deliverContext(project, agent, combinationTask), make({ sourcePaths }),
  ]);
  assert.deepEqual(onlyOne, [reactSkill]);
  assert.equal(blockedVue, '');
  assert.equal(blockedRecipe, '');
  assert.equal(blockedCreation.isError, true);
  assert.ok(blockedCreation.content[0].text.includes(vueSkill));
  const oneEnabledReceipts = await listSkillDeliveries({ project, agent });
  const singleDeliveries = oneEnabledReceipts.filter(receipt => !initialReceipts.some(prior => prior.id === receipt.id));
  assert.deepEqual(singleDeliveries.map(receipt => receipt.method).sort(), ['hook', 'mcp']);
  for (const delivery of singleDeliveries) assert.deepEqual(delivery.paths, [reactSkill]);
  assert.deepEqual(await listWorkspaceSkills({ project }), saved);

  const categoryEnabled = await dashboardCategory(url, 'web-dev/react', agent, 'enabled', oneEnabled);
  const [enabledReact, enabledSibling] = await Promise.all([
    deliver(project, agent, react), deliver(project, agent, 'Improve React form handling'),
  ]);
  assert.ok(enabledReact.includes(reactSkill));
  assertCategory(enabledSibling, 'web-dev/react');
  assert.ok(enabledSibling.some(source => source !== reactSkill));
  const oneDisabled = await skill('disabled', categoryEnabled);
  const [otherReact, siblingStillEnabled, rejectedFile] = await Promise.all([
    deliver(project, agent, react), deliver(project, agent, 'Improve React form handling'), make({ sourcePaths: [reactSkill] }),
  ]);
  assert.ok(otherReact.every(source => source !== reactSkill));
  assert.deepEqual(siblingStillEnabled, enabledSibling);
  assert.equal(rejectedFile.isError, true);
  assert.ok(rejectedFile.content[0].text.includes(reactSkill));

  await all('enabled', oneDisabled);
  const restoredContext = await deliverContext(project, agent, combinationTask);
  assert.ok(restoredContext.includes(recipeHeading));
  const afterRestore = await listSkillDeliveries({ project, agent });
  const restoredDeliveries = afterRestore.filter(receipt => receipt.paths.includes(recipePath) &&
    !initialReceipts.some(prior => prior.id === receipt.id));
  assert.deepEqual(restoredDeliveries.map(receipt => receipt.method).sort(), ['hook', 'mcp']);
  assert.deepEqual(await listWorkspaceSkills({ project }), saved);
});
