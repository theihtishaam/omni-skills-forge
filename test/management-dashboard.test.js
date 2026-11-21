import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { startManagementDashboard } from '../src/management-dashboard.js';
import { runPromptHook } from '../src/skill-prompt-hook.js';

async function dashboardFixture(t) {
  const testRoot = path.resolve(tmpdir());
  const projectRoot = await mkdtemp(path.join(testRoot, 'osf-dashboard-'));
  assert.equal(path.dirname(path.resolve(projectRoot)), testRoot);
  assert.match(path.basename(projectRoot), /^osf-dashboard-/u);
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const dashboard = await startManagementDashboard({ projectRoot });
  t.after(() => dashboard.close());
  return { ...dashboard, projectRoot };
}

async function post(base, route, data, headers = {}) {
  return fetch(base + route, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
}

async function withHost(base, host) {
  return new Promise((resolve, reject) => {
    const req = request(base + '/api/project', { headers: { Host: host } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard pins loopback host and same-origin JSON requests', async t => {
  const { url, server } = await dashboardFixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.match(await home.text(), /Exactwork Skills/);
  assert.equal(await withHost(url, 'example.test'), 403);
  assert.equal((await fetch(url + '/api/project', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post(url, '/api/preferences', {}, { Origin: 'https://example.test' })).status, 403);
  assert.equal((await fetch(url + '/api/preferences', { method: 'POST' })).status, 403);
  assert.equal((await post(url, '/api/preferences', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(url, '/api/select', { query: 'z'.repeat(36000) })).status, 413);
  assert.equal((await fetch(url + '/missing')).status, 404);
});

test('dashboard paginates metadata and applies revision-checked project and agent preferences', async t => {
  const { url } = await dashboardFixture(t);
  const project = await (await fetch(url + '/api/project')).json();
  assert.ok(project.agents.includes('codex'));
  assert.ok(project.agents.includes('cursor'));
  const getPage = async (agent, params = '') => {
    const response = await fetch(url + '/api/catalog?agent=' + agent + '&query=react%20accessibility' + params);
    assert.equal(response.status, 200);
    return response.json();
  };
  const initialPage = await getPage('codex');
  assert.equal(initialPage.revision, 0);
  assert.equal(initialPage.items.length, initialPage.pageSize);
  assert.ok(initialPage.total > initialPage.items.length);
  const secondPage = await getPage('codex', '&page=2');
  assert.notEqual(secondPage.items[0].path, initialPage.items[0].path);
  assert.equal(initialPage.items[0].markdown, undefined);

  const task = { query: 'Improve React accessibility with keyboard navigation', maxSkills: 2, tokenBudget: 2400 };
  const select = async agent => {
    const response = await post(url, '/api/select', { ...task, agent });
    assert.equal(response.status, 200);
    return response.json();
  };
  const results = await select('codex');
  assert.equal(results.revision, 0);
  assert.ok(results.matches.length > 0 && results.matches.length <= task.maxSkills);
  assert.ok(results.estimatedTokens > 0 && results.estimatedTokens <= task.tokenBudget);
  assert.match(results.markdown, /# Omni Skills Forge task context/);
  const skillPath = results.matches[0].path;
  const mutation = { path: skillPath, agent: 'codex', status: 'disabled', expectedRevision: 0 };
  assert.equal((await post(url, '/api/preferences', mutation)).status, 200);
  assert.equal((await post(url, '/api/preferences', { ...mutation, status: 'enabled' })).status, 409);
  assert.ok(!(await select('codex')).matches.some(candidate => candidate.path === skillPath));
  assert.ok((await select('cursor')).matches.some(candidate => candidate.path === skillPath));
  const disabled = await getPage('codex', '&filter=disabled');
  assert.equal(disabled.items.length, 1);
  assert.equal(disabled.items[0].agentStatus, 'disabled');
  assert.equal(disabled.items[0].projectStatus, 'default');

  const globalMutation = { path: skillPath, status: 'disabled', expectedRevision: 1 };
  assert.equal((await post(url, '/api/preferences', globalMutation)).status, 200);
  assert.ok(!(await select('cursor')).matches.some(candidate => candidate.path === skillPath));
  const cursorDisabled = await getPage('cursor', '&filter=disabled');
  assert.equal(cursorDisabled.items[0].projectStatus, 'disabled');
  assert.equal(cursorDisabled.items[0].agentStatus, 'default');
  assert.equal(cursorDisabled.items[0].eligibility, 'disabled');
  assert.equal((await post(url, '/api/preferences', { ...globalMutation, status: 'default', expectedRevision: 2 })).status, 200);
  assert.equal((await post(url, '/api/preferences', { ...mutation, status: 'enabled', expectedRevision: 3 })).status, 200);
  assert.ok((await select('codex')).matches.some(candidate => candidate.path === skillPath));
});

test('dashboard distinguishes folder suggestions and task previews from deliveries', async t => {
  const { url, projectRoot } = await dashboardFixture(t);
  const directory = 'apps/storefront';
  const storefront = path.join(projectRoot, directory);
  await mkdir(storefront, { recursive: true });
  await writeFile(path.join(storefront, 'package.json'), JSON.stringify({
    dependencies: { react: '^19.0.0' },
    devDependencies: { typescript: '^5.0.0' },
    description: 'synthetic manifest content outside the profile',
  }));
  await writeFile(path.join(projectRoot, 'go.mod'), 'module example.test/workspace\n');

  const workspace = async (focus, agent = 'codex') => post(url, '/api/workspace', { directory: focus, agent });
  const response = await workspace(directory);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.workspace.directory, directory);
  assert.deepEqual(result.workspace.technologies, [
    { name: 'React', sources: [{ directory, file: 'package.json' }] },
    { name: 'TypeScript', sources: [{ directory, file: 'package.json' }] },
  ]);
  assert.ok(result.suggestions.length > 0 && result.suggestions.length <= 3);
  assert.equal(result.markdown, undefined);
  assert.ok(result.suggestions.every(skill => typeof skill.reason === 'string' && skill.eligibility !== 'disabled'));
  assert.ok(!JSON.stringify(result).includes('synthetic manifest content'));
  assert.equal((await workspace('../outside')).status, 400);
  const root = await (await workspace('.')).json();
  assert.deepEqual(root.workspace.technologies.map(item => item.name), ['Go']);

  const query = 'Improve React accessibility with keyboard navigation';
  const selected = await post(url, '/api/select', { query, directory, agent: 'codex' });
  assert.equal(selected.status, 200);
  const plan = await selected.json();
  assert.equal(plan.workspace.directory, directory);
  assert.ok(plan.matches.length > 0);
  const deliveries = async agent => {
    const response = await fetch(url + '/api/deliveries?' + new URLSearchParams({ agent }));
    assert.equal(response.status, 200);
    return (await response.json()).records;
  };
  assert.deepEqual(await deliveries('codex'), []);

  let outputBytes = '';
  const output = new Writable({ write(chunk, _, callback) { outputBytes += chunk.toString(); callback(); } });
  await runPromptHook({ project: projectRoot, agent: 'codex' }, {
    input: Readable.from([JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: query, cwd: storefront })]),
    output,
  });
  assert.match(outputBytes, /additionalContext/u);
  const [delivery, ...earlier] = await deliveries('codex');
  assert.equal(earlier.length, 0);
  assert.equal(delivery.agent, 'codex');
  assert.equal(delivery.directory, directory);
  assert.equal(delivery.method, 'hook');
  assert.ok(Number.isFinite(Date.parse(delivery.at)));
  assert.deepEqual(delivery.skills, plan.matches.map(({ path, name }) => ({ path, name })));
  assert.equal(delivery.markdown, undefined);
  assert.deepEqual(await deliveries('cursor'), []);
  const overview = await (await fetch(url + '/api/deliveries')).json();
  assert.deepEqual(overview.latestByAgent, [delivery]);
});

test('dashboard filters catalog pages and exposes inherited category exclusions for the chosen agent', async t => {
  const { url, projectRoot } = await dashboardFixture(t);
  await writeFile(path.join(projectRoot, 'package.json'), '{"dependencies":{"react":"^19.0.0"}}');
  const project = await (await fetch(url + '/api/project')).json();
  assert.equal(project.categoryGroups.length, 6);
  assert.equal(project.categoryGroups.flatMap(group => group.categories).length, 28);
  assert.ok(project.categoryGroups.find(group => group.family === 'web-dev').categories.includes('web-dev/react'));

  const getCatalog = async (args = {}) => {
    const response = await fetch(url + '/api/catalog?' + new URLSearchParams({ agent: 'codex', category: 'web-dev/react', ...args }));
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await fetch(url + '/api/catalog?category=unknown')).status, 404);
  const first = await getCatalog({ query: 'accessibility' });
  const second = await getCatalog({ query: 'accessibility', page: 2 });
  assert.ok(first.total > first.pageSize);
  assert.equal(first.total, second.total);
  assert.notEqual(first.items[0].path, second.items[0].path);
  assert.ok([...first.items, ...second.items].every(skill => skill.category === 'web-dev/react' && /accessibility/u.test(skill.name)));
  assert.ok(first.counts.category > first.total && first.counts.category < first.counts.catalog);

  const mutate = (category, status, expectedRevision, agent) =>
    post(url, '/api/category-preferences', { category, status, expectedRevision, agent });
  assert.equal((await mutate('unknown', 'disabled', 0, 'codex')).status, 404);
  assert.equal((await mutate('web-dev/react', 'enabled', 0, 'codex')).status, 200);
  assert.equal((await mutate('web-dev', 'disabled', 1, 'codex')).status, 200);
  assert.equal((await mutate('web-dev', 'enabled', 1, 'codex')).status, 409);
  const disabled = await getCatalog({ filter: 'disabled' });
  assert.equal(disabled.total, disabled.counts.category);
  assert.equal(disabled.counts.categoryDisabled, disabled.counts.category);
  assert.ok(disabled.counts.disabled > disabled.counts.categoryDisabled);
  assert.equal(disabled.categoryPreference.agentStatus, 'enabled');
  assert.equal(disabled.categoryPreference.projectBlock, null);
  assert.equal(disabled.categoryPreference.agentBlock.category, 'web-dev');
  assert.equal(disabled.categoryPreference.agentBlock.scope, 'agent');
  assert.ok(disabled.items.every(skill => skill.eligibility === 'disabled' && skill.agentBlock.category === 'web-dev'));

  const other = await getCatalog({ agent: 'cursor', filter: 'disabled' });
  assert.equal(other.total, 0);
  assert.equal(other.categoryPreference.agentBlock, null);
  const recommendations = await (await post(url, '/api/workspace', { directory: '.', agent: 'codex' })).json();
  assert.ok(recommendations.suggestions.every(skill => !skill.category.startsWith('web-dev/')));

  assert.equal((await mutate('web-dev', 'disabled', 2)).status, 200);
  const inherited = await getCatalog({ agent: 'cursor', filter: 'disabled' });
  assert.equal(inherited.categoryPreference.projectBlock.category, 'web-dev');
  assert.equal(inherited.categoryPreference.agentBlock.scope, 'project');
  assert.equal(inherited.counts.categoryDisabled, inherited.counts.category);
  assert.equal((await mutate('web-dev', 'default', 3)).status, 200);
  assert.equal((await mutate('web-dev', 'default', 4, 'codex')).status, 200);
  const reset = await getCatalog({ filter: 'eligible' });
  assert.equal(reset.total, reset.counts.category);
  assert.equal(reset.counts.categoryDisabled, 0);
  assert.equal(reset.categoryPreference.eligibility, 'enabled');
});

test('dashboard previews and downloads a composed skill, then saves and changes its status explicitly', async t => {
  const { url } = await dashboardFixture(t);
  const base = '/api/workspace-skills';
  const draft = {
    title: 'Review React forms',
    useWhen: 'Improve React accessibility and form validation.',
    instructions: 'Verify keyboard focus after validation.',
    agent: 'codex',
    sourcePaths: [
      'web-dev/react/react-accessibility-a11y-advanced-intermediate.md',
      'web-dev/react/react-form-handling-advanced-intermediate.md',
    ],
  };
  const preview = await post(url, base + '/compose', draft);
  assert.equal(preview.status, 200);
  const composed = await preview.json();
  assert.equal(composed.fitsBudget, true);
  assert.match(composed.portableMarkdown, /^---\nname: "review-react-forms"\n/u);
  assert.match(composed.portableMarkdown, /Verify keyboard focus after validation/u);
  assert.deepEqual(composed.sourcePaths, draft.sourcePaths);
  assert.deepEqual(await (await fetch(url + base)).json(), { revision: 0, recipes: [] });
  const overBudget = await (await post(url, base + '/compose', { ...draft, tokenBudget: 1 })).json();
  assert.equal(overBudget.fitsBudget, false);
  assert.equal(overBudget.portableMarkdown, composed.portableMarkdown);
  const saved = await post(url, base + '/create', draft);
  assert.equal(saved.status, 201);
  const { revision, recipe } = await saved.json();
  assert.equal(recipe.agent, 'codex');
  assert.equal(recipe.enabled, true);
  assert.equal((await post(url, base + '/compose', { id: recipe.id, agent: 'cursor' })).status, 409);
  assert.equal((await post(url, base + '/status', { id: recipe.id, enabled: false, expectedRevision: revision })).status, 200);
  assert.equal((await post(url, base + '/compose', { id: recipe.id, agent: 'codex' })).status, 409);
  assert.equal((await post(url, base + '/status', { id: recipe.id, enabled: true, expectedRevision: revision })).status, 409);
  assert.equal((await post(url, '/api/category-preferences', { category: 'web-dev', status: 'disabled', expectedRevision: 0 })).status, 200);
  const blocked = await post(url, base + '/compose', draft);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /disabled for this project or agent/u);
  assert.equal((await post(url, base + '/remove', { id: recipe.id, expectedRevision: revision })).status, 409);
  const removed = await post(url, base + '/remove', { id: recipe.id, expectedRevision: revision + 1 });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).recipes, []);
});
