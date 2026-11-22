import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  describeCategoryEligibility, describeSkillEligibility, getCategoryEligibility,
  loadSkillSelectionCatalog, loadSkillSelectionState, recommendWorkspaceSkills,
  selectSkills, setAllSkillsState, setSkillCategoryState, setSkillSelectionState,
} from '../src/index.js';

const task = 'Review keyboard accessibility in this form';
const category = 'web-dev/react';
const family = 'web-dev';
const accessibility = 'web-dev/react/react-accessibility-a11y-advanced-intermediate.md';
const forms = 'web-dev/react/react-form-handling-advanced-intermediate.md';
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const run = promisify(execFile);

async function projectFixture(t) {
  const project = await mkdtemp(path.join(tmpdir(), 'osf-category-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(path.join(project, 'package.json'), '{"dependencies":{"react":"fixture"}}');
  return project;
}

test('category policies expose exact paths and family exclusions without altering relevance', async t => {
  const project = await projectFixture(t);
  const { categories, families } = await loadSkillSelectionCatalog();
  assert.equal(categories.length, 30);
  assert.deepEqual(families, ['ai-ml', 'backend', 'cloud', 'database', 'devops', 'web-dev', 'work']);
  await assert.rejects(setSkillCategoryState({ project, category: 'web-dev/invalid', status: 'enabled' }), {
    code: 'UNKNOWN_CATEGORY',
  });
  assert.deepEqual(await readdir(project), ['package.json']);

  const options = { project, query: task, agent: 'codex', maxSkills: 1 };
  const baseline = await selectSkills(options);
  const pick = baseline.matches[0].path;
  const allowed = await setSkillCategoryState({ project, category, agent: 'codex', status: 'enabled' });
  assert.equal(getCategoryEligibility(allowed, category, 'codex'), 'enabled');
  assert.equal(getCategoryEligibility(allowed, category, 'cursor'), 'default');
  assert.deepEqual((await selectSkills(options)).matches, baseline.matches);
  assert.deepEqual((await selectSkills({ ...options, query: 'What is the weather today?' })).matches, []);

  await setSkillSelectionState({ project, path: pick, agent: 'codex', status: 'enabled' });
  const agentDenied = await setSkillCategoryState({ project, category, agent: 'codex', status: 'disabled' });
  assert.deepEqual(describeSkillEligibility(agentDenied, pick, 'codex'), {
    status: 'disabled', scope: 'agent', type: 'category', category,
  });
  assert.deepEqual((await selectSkills(options)).matches, []);
  assert.deepEqual((await recommendWorkspaceSkills({ project, agent: 'codex' })).suggestions, []);
  assert.equal((await selectSkills({ ...options, agent: 'cursor' })).matches[0].path, pick);

  const allDenied = await setSkillCategoryState({ project, category: family, status: 'disabled' });
  assert.deepEqual(allDenied.categoryOverrides, { [family]: 'disabled' });
  assert.equal(Object.keys(allDenied.overrides).length, 0);
  assert.deepEqual(describeCategoryEligibility(allDenied, category, 'codex'), {
    status: 'disabled', scope: 'project', type: 'category', category: family,
  });
  assert.equal(getCategoryEligibility(allDenied, 'web-dev/vue', 'cursor'), 'disabled');
  assert.equal(getCategoryEligibility(allDenied, 'backend/python', 'codex'), 'default');

  const individualAllow = await setSkillCategoryState({ project, category, agent: 'cursor', status: 'enabled' });
  assert.equal(getCategoryEligibility(individualAllow, category, 'cursor'), 'disabled');
  assert.deepEqual((await selectSkills({ ...options, agent: 'cursor' })).matches, []);
  await setSkillCategoryState({ project, category: family, status: 'default' });
  assert.equal((await selectSkills({ ...options, agent: 'cursor' })).matches[0].path, pick);
  assert.deepEqual((await selectSkills(options)).matches, []);
});

test('existing snapshots migrate in memory, and category and file updates share atomic revisions', async t => {
  const project = await projectFixture(t);
  const pick = (await selectSkills({ project, query: task, maxSkills: 1 })).matches[0].path;
  const settings = path.join(project, '.omni-skills-forge');
  await mkdir(settings);
  await writeFile(path.join(settings, 'preferences-1.json'), JSON.stringify({
    revision: 1, overrides: { [pick]: 'disabled' }, agentOverrides: {},
  }));
  const old = await loadSkillSelectionState({ project });
  assert.deepEqual(old.categoryOverrides, {});
  assert.deepEqual(old.agentCategoryOverrides, {});
  assert.equal(old.allSkillsStatus, 'default');
  assert.deepEqual(old.agentAllSkillsStatus, {});
  assert.equal(old.overrides[pick], 'disabled');

  const competition = await Promise.allSettled([
    setSkillCategoryState({ project, category, status: 'disabled', expectedRevision: 1 }),
    setSkillSelectionState({ project, path: pick, status: 'enabled', expectedRevision: 1 }),
  ]);
  assert.equal(competition.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competition.find(result => result.status === 'rejected').reason.code, 'STALE_REVISION');

  await Promise.all([
    setSkillCategoryState({ project, category, agent: 'codex', status: 'disabled' }),
    setSkillSelectionState({ project, path: pick, agent: 'cursor', status: 'enabled' }),
  ]);
  const saved = await loadSkillSelectionState({ project });
  assert.equal(saved.revision, 4);
  assert.deepEqual(saved.agentCategoryOverrides.codex, { [category]: 'disabled' });
  assert.deepEqual(saved.agentOverrides.cursor, { [pick]: 'enabled' });
});

test('turning off the project catalog uses one compact write and accepts new exceptions at the same scope', async t => {
  const project = await projectFixture(t);
  await setSkillCategoryState({ project, category, status: 'enabled' });
  await setSkillSelectionState({ project, path: forms, status: 'enabled' });
  await setAllSkillsState({ project, agent: 'cursor', status: 'disabled' });
  await setSkillSelectionState({ project, agent: 'codex', path: accessibility, status: 'enabled' });
  const before = await loadSkillSelectionState({ project });
  const directory = path.join(project, '.omni-skills-forge');
  const oldFiles = await readdir(directory);
  const bulk = await setAllSkillsState({ project, status: 'disabled', expectedRevision: before.revision });
  assert.equal(bulk.revision, before.revision + 1);
  assert.equal((await readdir(directory)).length, oldFiles.length + 1);
  const persisted = await readFile(path.join(directory, `preferences-${bulk.revision}.json`), 'utf8');
  assert.ok(Buffer.byteLength(persisted) < 1000);
  assert.deepEqual(bulk.overrides, {});
  assert.deepEqual(bulk.categoryOverrides, {});
  assert.deepEqual(bulk.agentAllSkillsStatus, { cursor: 'disabled' });
  assert.equal(bulk.agentOverrides.codex[accessibility], 'enabled');
  assert.deepEqual(describeSkillEligibility(bulk, accessibility, 'codex'), {
    status: 'disabled', scope: 'project', type: 'all',
  });
  assert.deepEqual((await selectSkills({ project, agent: 'codex', query: task })).matches, []);

  await setSkillCategoryState({ project, category, status: 'enabled' });
  const exception = await setSkillSelectionState({ project, path: forms, status: 'disabled' });
  const reopening = await loadSkillSelectionState({ project });
  assert.deepEqual(reopening, exception);
  assert.equal(getCategoryEligibility(reopening, 'backend/python', 'codex'), 'disabled');
  assert.deepEqual(describeSkillEligibility(reopening, forms, 'codex'), {
    status: 'disabled', scope: 'project', type: 'skill',
  });
  assert.deepEqual(describeSkillEligibility(reopening, accessibility, 'cursor'), {
    status: 'disabled', scope: 'agent', type: 'all',
  });
  const selected = await selectSkills({ project, agent: 'codex', query: task });
  assert.equal(selected.matches[0].path, accessibility);
  assert.ok(selected.matches.every(match => match.path !== forms));

  const reset = await setAllSkillsState({ project, status: 'disabled', expectedRevision: exception.revision });
  assert.equal(reset.revision, exception.revision + 1);
  assert.equal((await setAllSkillsState({ project, status: 'disabled' })).revision, reset.revision);
  await assert.rejects(setAllSkillsState({
    project, status: 'enabled', expectedRevision: exception.revision,
  }), { code: 'STALE_REVISION' });
  const competing = await Promise.allSettled([
    setAllSkillsState({ project, status: 'enabled', expectedRevision: reset.revision }),
    setSkillCategoryState({ project, category, status: 'enabled', expectedRevision: reset.revision }),
  ]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'STALE_REVISION');
  assert.equal((await loadSkillSelectionState({ project })).revision, reset.revision + 1);
});

test('agent bulk category changes replace same-scope child overrides and can be adjusted afterward', async t => {
  const project = await projectFixture(t);
  const agent = 'codex';
  await setAllSkillsState({ project, agent, status: 'disabled' });
  const categoryEnabled = await setSkillCategoryState({ project, agent, category, status: 'enabled' });
  assert.equal(getCategoryEligibility(categoryEnabled, category, agent), 'enabled');
  assert.equal(getCategoryEligibility(categoryEnabled, 'web-dev/vue', agent), 'disabled');
  assert.equal(getCategoryEligibility(categoryEnabled, 'web-dev/vue', 'cursor'), 'default');

  const localDeny = await setSkillSelectionState({ project, agent, path: accessibility, status: 'disabled' });
  assert.equal(describeSkillEligibility(localDeny, accessibility, agent).status, 'disabled');
  const categoryRestored = await setSkillCategoryState({ project, agent, category, status: 'enabled' });
  assert.equal(categoryRestored.revision, localDeny.revision + 1);
  assert.deepEqual(categoryRestored.agentOverrides, {});
  assert.equal(describeSkillEligibility(categoryRestored, accessibility, agent).status, 'enabled');

  const familyOff = await setSkillCategoryState({ project, agent, category: family, status: 'disabled' });
  assert.deepEqual(familyOff.agentCategoryOverrides, { [agent]: { [family]: 'disabled' } });
  assert.equal(getCategoryEligibility(familyOff, category, agent), 'disabled');
  const oneFile = await setSkillSelectionState({ project, agent, path: accessibility, status: 'enabled' });
  assert.deepEqual(describeSkillEligibility(oneFile, accessibility, agent), {
    status: 'enabled', scope: 'agent', type: 'skill',
  });
  assert.equal(describeSkillEligibility(oneFile, forms, agent).status, 'disabled');
  assert.deepEqual((await selectSkills({ project, agent, query: task })).matches.map(match => match.path), [accessibility]);

  const on = await setAllSkillsState({ project, agent, status: 'enabled' });
  assert.deepEqual(on.agentOverrides, {});
  assert.deepEqual(on.agentCategoryOverrides, {});
  assert.equal(on.agentAllSkillsStatus[agent], 'enabled');
  assert.equal(on.allSkillsStatus, 'default');
});

test('previously blocked legacy allows stay off until a new explicit same-scope action', async t => {
  const project = await projectFixture(t);
  const settings = path.join(project, '.omni-skills-forge');
  await mkdir(settings);
  await writeFile(path.join(settings, 'preferences-1.json'), JSON.stringify({
    revision: 1,
    overrides: { [accessibility]: 'enabled' },
    categoryOverrides: { [category]: 'enabled', [family]: 'disabled' },
    agentOverrides: { codex: { [accessibility]: 'enabled' } },
    agentCategoryOverrides: { codex: { [category]: 'disabled' } },
  }));
  const old = await loadSkillSelectionState({ project });
  assert.equal(describeSkillEligibility(old, accessibility, 'codex').status, 'disabled');
  assert.equal(describeSkillEligibility(old, accessibility, 'cursor').status, 'disabled');
  const now = await setSkillSelectionState({
    project, path: accessibility, status: 'enabled', expectedRevision: old.revision,
  });
  assert.equal(now.revision, 2);
  assert.equal(describeSkillEligibility(now, accessibility, 'cursor').status, 'enabled');
  assert.equal(describeSkillEligibility(now, accessibility, 'codex').status, 'disabled');
  assert.equal(describeSkillEligibility(now, forms, 'cursor').status, 'disabled');
});

test('CLI can change category scopes and still accepts individual file paths', async t => {
  const project = await projectFixture(t);
  const osf = (...options) => run(process.execPath, [cli, ...options], { cwd: project });
  const baseline = await selectSkills({ project, query: task, maxSkills: 1 });
  const pick = baseline.matches[0].path;
  await osf('disable', '--category', category, '--agent', 'cursor');
  const cliResult = await osf('select', task, '--agent', 'cursor', '--json');
  assert.deepEqual(JSON.parse(cliResult.stdout).matches, []);
  await osf('reset-skill', '--category', category, '--agent', 'cursor');
  await osf('disable', pick, '--agent', 'cursor');
  const state = await loadSkillSelectionState({ project });
  assert.equal(state.agentOverrides.cursor[pick], 'disabled');
  assert.deepEqual(state.agentCategoryOverrides, {});
  await assert.rejects(osf('disable', pick, '--category', category), /Choose one skill path/u);
  await osf('disable', '--all', '--agent', 'cursor');
  const disabled = await loadSkillSelectionState({ project });
  assert.equal(disabled.agentAllSkillsStatus.cursor, 'disabled');
  assert.deepEqual(disabled.agentOverrides, {});
  await osf('enable', pick, '--agent', 'cursor');
  assert.equal(describeSkillEligibility(await loadSkillSelectionState({ project }), pick, 'cursor').status, 'enabled');
});
