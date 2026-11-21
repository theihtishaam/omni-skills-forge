import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  exportSkillContext, getSkillEligibility, loadSkillSelectionState, selectSkills, setSkillSelectionState,
} from '../src/skill-selection.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const task = 'Review React accessibility for keyboard navigation and focus in a form';
const anotherSkill = 'web-dev/react/react-accessibility-a11y-testing-advanced.md';

async function projectFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osf-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('real task matching is deterministic, deduplicated, bounded, and preview stays read-only', async t => {
  const project = await projectFixture(t);
  const first = await selectSkills({ project, query: task, tokenBudget: 1400, maxSkills: 1 });
  assert.equal(first.matches.length, 1);
  assert.match(first.matches[0].path, /^web-dev\/react\/react-accessibility-a11y-/u);
  assert.match(first.matches[0].reason, /accessibility/u);
  const skill = await readFile(new URL(`../skills/${first.matches[0].path}`, import.meta.url), 'utf8');
  assert.ok(first.markdown.includes(skill.replace(/\r\n/g, '\n').trim()));
  assert.equal(first.estimatedTokens, Math.ceil(Buffer.byteLength(first.markdown) / 4));
  assert.ok(first.estimatedTokens <= 1400);
  assert.deepEqual(await selectSkills({ project, query: task, tokenBudget: 1400, maxSkills: 1 }), first);

  const testing = await selectSkills({ project, query: 'React accessibility testing' });
  assert.equal(testing.matches.length, 1);
  assert.match(testing.matches[0].path, /react-accessibility-a11y-testing/u);
  for (const query of ['', 'please help with this', 'unknownflurgling quiddle in React', 'React']) {
    const result = await selectSkills({ project, query });
    assert.deepEqual(result.matches, []);
    assert.equal(result.markdown, '');
    assert.equal(result.estimatedTokens, 0);
  }
  assert.deepEqual((await selectSkills({ project, query: task, tokenBudget: 10 })).matches, []);
  assert.deepEqual(await readdir(project), []);
});

test('agent and project preferences are isolated, exact, and revision-safe across writers', async t => {
  const project = await projectFixture(t);
  const query = 'React accessibility testing';
  const top = (await selectSkills({ project, query, maxSkills: 1 })).matches[0].path;
  await assert.rejects(setSkillSelectionState({ project, path: '../private.md', status: 'enabled' }), { code: 'UNKNOWN_SKILL' });
  await assert.rejects(setSkillSelectionState({ project, path: top, status: 'enabled', agent: 'unknown' }), { code: 'INVALID_SELECTION_INPUT' });
  assert.deepEqual(await readdir(project), []);

  const [one, two] = await Promise.all([
    setSkillSelectionState({ project, agent: 'codex', path: top, status: 'disabled' }),
    setSkillSelectionState({ project, agent: 'claude-code', path: anotherSkill, status: 'enabled' }),
  ]);
  assert.deepEqual([one.revision, two.revision].sort(), [1, 2]);
  let saved = await loadSkillSelectionState({ project });
  assert.equal(saved.revision, 2);
  assert.equal(getSkillEligibility(saved, top, 'codex'), 'disabled');
  assert.equal(getSkillEligibility(saved, top, 'claude-code'), 'default');
  assert.equal(getSkillEligibility(saved, anotherSkill, 'claude-code'), 'enabled');
  assert.equal(getSkillEligibility(saved, anotherSkill, 'codex'), 'default');
  assert.equal((await selectSkills({ project, agent: 'claude-code', query, maxSkills: 1 })).matches[0].path, anotherSkill);
  assert.ok(!(await selectSkills({ project, agent: 'codex', query })).matches.some(match => match.path === top));

  const writes = await Promise.allSettled([
    setSkillSelectionState({ project, path: anotherSkill, status: 'disabled', expectedRevision: 2 }),
    setSkillSelectionState({ project, path: top, status: 'disabled', expectedRevision: 2 }),
  ]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find(result => result.status === 'rejected').reason.code, 'STALE_REVISION');
  saved = await setSkillSelectionState({ project, path: anotherSkill, status: 'disabled' });
  assert.equal(getSkillEligibility(saved, anotherSkill, 'claude-code'), 'disabled');
  saved = await setSkillSelectionState({ project, path: anotherSkill, status: 'default' });
  assert.equal(getSkillEligibility(saved, anotherSkill, 'claude-code'), 'enabled');
  assert.deepEqual((await selectSkills({ project, agent: 'claude-code', query: 'sunbeam orchard' })).matches, []);
});

test('explicit export creates one safe new file with the exact bounded content', async t => {
  const project = await projectFixture(t);
  const options = { project, query: task, output: 'context.md', maxSkills: 1 };
  const result = await exportSkillContext(options);
  assert.equal(await readFile(result.output, 'utf8'), result.markdown);
  await assert.rejects(exportSkillContext(options), { code: 'OUTPUT_EXISTS' });
  await assert.rejects(exportSkillContext({ ...options, output: '../outside.md' }), { code: 'INVALID_SELECTION_INPUT' });
  const empty = await exportSkillContext({ ...options, query: 'unknownstuff', output: 'missing.md' });
  assert.equal(empty.output, null);
  assert.deepEqual(await readdir(project), ['context.md']);
});

test('old snapshots leave occupied revision numbers after their contents are retired', async t => {
  const project = await projectFixture(t);
  for (let revision = 1; revision <= 12; revision += 1) {
    const status = revision % 2 ? 'enabled' : 'disabled';
    const saved = await setSkillSelectionState({ project, path: anotherSkill, status, expectedRevision: revision - 1 });
    assert.equal(saved.revision, revision);
  }
  const folder = path.join(project, '.omni-skills-forge');
  const files = await readdir(folder);
  assert.equal(files.length, 12);
  const sizes = await Promise.all(files.map(file => stat(path.join(folder, file)).then(item => item.size)));
  assert.equal(sizes.filter(size => size > 0).length, 8);
  const current = await loadSkillSelectionState({ project });
  assert.equal(current.revision, 12);
  assert.equal(getSkillEligibility(current, anotherSkill), 'disabled');
  await assert.rejects(setSkillSelectionState({
    project, path: anotherSkill, status: 'enabled', expectedRevision: 1,
  }), { code: 'STALE_REVISION' });
});

test('CLI previews, updates per-agent preferences and exports through normal entry points', async t => {
  const project = await projectFixture(t);
  await mkdir(path.join(project, 'nested'));
  await writeFile(path.join(project, 'nested', 'existing.md'), 'preserve this file\n');
  const osf = (...args) => run(process.execPath, [cli, ...args], { cwd: project });
  const options = ['--project', project, '--agent', 'codex', '--max-skills', '1', '--json'];
  const before = JSON.parse((await osf('select', task, ...options)).stdout);
  const skillPath = before.matches[0].path;
  assert.equal(Object.hasOwn(before, 'markdown'), false);
  assert.deepEqual(await readdir(project), ['nested']);
  await osf('disable', skillPath, '--project', project, '--agent', 'codex');
  const after = JSON.parse((await osf('select', task, ...options)).stdout);
  assert.ok(!after.matches.some(match => match.path === skillPath));
  await osf('reset-skill', skillPath, '--project', project, '--agent', 'codex');
  await osf('select', task, ...options, '--output', 'nested/context.md');
  assert.match(await readFile(path.join(project, 'nested', 'context.md'), 'utf8'), /Omni Skills Forge task context/u);
  await assert.rejects(osf('select', task, ...options, '--output', 'nested/existing.md'), /already exists/u);
  assert.equal(await readFile(path.join(project, 'nested', 'existing.md'), 'utf8'), 'preserve this file\n');
  const legacySearch = await osf('search', 'react-accessibility', '--limit', '2');
  assert.match(legacySearch.stdout, /react-accessibility/u);
});
