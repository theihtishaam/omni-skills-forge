import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createWorkspaceSkill, listWorkspaceSkills, makeWorkspaceSkill, selectSkills,
  setSkillCategoryState, setWorkspaceSkillEnabled,
} from '../src/index.js';

const accessibility = 'web-dev/react/react-accessibility-a11y-advanced-intermediate.md';
const forms = 'web-dev/react/react-form-handling-advanced-intermediate.md';
const task = 'Make one skill for reviewing keyboard accessibility in this form. Include a keyboard smoke check.';

async function fixture(t, directory = '.') {
  const project = await mkdtemp(path.join(tmpdir(), 'osf-make-skill-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const workspace = path.join(project, directory);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"dependencies":{"react":"fixture"}}');
  return project;
}

test('one-step creation finds catalog sources in the active folder and converges on one saved skill', async t => {
  const directory = 'packages/web';
  const project = await fixture(t, directory);
  const options = { project, directory, agent: 'codex', instruction: task };
  const previous = await createWorkspaceSkill({
    project, agent: 'codex', title: 'Keyboard Accessibility Review',
    useWhen: 'Review keyboard accessibility in this form', sourcePaths: [accessibility],
  });
  const legacy = await selectSkills({ project, directory, agent: 'codex', query: 'Review keyboard accessibility in this form' });
  assert.equal(legacy.matches[0].recipeId, previous.recipe.id);

  const simultaneous = await Promise.all([makeWorkspaceSkill(options), makeWorkspaceSkill(options), makeWorkspaceSkill(options)]);
  assert.equal(simultaneous.filter(result => result.created).length, 1);
  assert.equal(new Set(simultaneous.map(result => result.recipe.id)).size, 1);
  const result = simultaneous.find(item => item.created);
  assert.equal(result.recipe.title, 'React Accessibility and Form Handling');
  assert.match(result.recipe.useWhen, /keyboard accessibility/u);
  assert.match(result.recipe.instructions, /Include a keyboard smoke check/u);
  assert.doesNotMatch(result.recipe.instructions, /^Make one skill/u);
  assert.equal(result.recipe.agent, 'codex');
  assert.deepEqual(result.sources.map(source => source.path), [accessibility, forms]);
  assert.ok(result.markdown.includes('export function ContactEmailField'));
  assert.ok(result.markdown.includes('export function EmailForm'));
  assert.equal((await listWorkspaceSkills({ project })).recipes.length, 2);
  assert.deepEqual(await readdir(path.join(project, directory)), ['package.json']);

  const repeat = await makeWorkspaceSkill({ ...options, instruction: `  ${task}  ` });
  assert.equal(repeat.recipe.id, result.recipe.id);
  assert.equal(repeat.created, false);
  const other = await fixture(t, directory);
  const separate = await makeWorkspaceSkill({ ...options, project: other });
  assert.ok(separate.created);
  assert.notEqual(separate.recipe.id, result.recipe.id);
});

test('handpicked skills merge without fields and preserve the saved scope and toggle on reuse', async t => {
  const project = await fixture(t);
  const options = { project, scope: 'project', sourcePaths: [forms, accessibility] };
  const result = await makeWorkspaceSkill(options);
  assert.equal(result.recipe.agent, null);
  assert.equal(result.recipe.title, 'React Accessibility and Form Handling');
  assert.equal(result.recipe.instructions, '');
  assert.deepEqual(result.sources.map(source => source.path), options.sourcePaths);
  assert.ok(result.markdown.includes(accessibility));
  assert.ok(result.markdown.includes(forms));

  await setWorkspaceSkillEnabled({ project, id: result.recipe.id, enabled: false });
  const repeated = await makeWorkspaceSkill({ ...options, sourcePaths: [accessibility, forms] });
  assert.equal(repeated.recipe.id, result.recipe.id);
  assert.equal(repeated.created, false);
  assert.equal(repeated.recipe.enabled, false);
  assert.equal(repeated.markdown, '');
});

test('no match leaves disk unchanged and exclusions apply to handpicked shared recipes', async t => {
  const project = await fixture(t);
  const agent = 'codex';
  for (const instruction of ['', 'Make one skill from the 50k', 'What is the weather today?']) {
    const result = await makeWorkspaceSkill({ project, agent, instruction });
    assert.equal(result.recipe, null);
    assert.equal(result.created, false);
    assert.deepEqual(result.sources, []);
    assert.equal(result.markdown, '');
    assert.ok(result.reason);
  }
  await assert.rejects(makeWorkspaceSkill({ project, agent, sourcePaths: ['workspace/unavailable.md'] }), {
    code: 'UNKNOWN_WORKSPACE_RECIPE_SOURCE',
  });
  assert.deepEqual(await readdir(project), ['package.json']);

  await setSkillCategoryState({ project, agent, category: 'web-dev/react', status: 'disabled' });
  await assert.rejects(makeWorkspaceSkill({ project, agent, scope: 'project', sourcePaths: [accessibility] }), {
    code: 'BLOCKED_WORKSPACE_RECIPE_SOURCE',
  });
  const automatic = await makeWorkspaceSkill({ project, agent, instruction: task });
  assert.equal(automatic.recipe, null);
  assert.deepEqual((await listWorkspaceSkills({ project })).recipes, []);
  assert.ok((await makeWorkspaceSkill({ project, agent: 'cursor', sourcePaths: [accessibility] })).created);
});
