import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  describeCategoryEligibility, describeSkillEligibility, getCategoryEligibility,
  loadSkillSelectionCatalog, loadSkillSelectionState, recommendWorkspaceSkills,
  selectSkills, setSkillCategoryState, setSkillSelectionState,
} from '../src/index.js';

const task = 'Review keyboard accessibility in this form';
const category = 'web-dev/react';
const family = 'web-dev';
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
  assert.equal(categories.length, 28);
  assert.deepEqual(families, ['ai-ml', 'backend', 'cloud', 'database', 'devops', 'web-dev']);
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
});
