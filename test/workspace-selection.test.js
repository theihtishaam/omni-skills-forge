import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createWorkspaceSkill, selectSkills, setSkillCategoryState, setSkillSelectionState,
  setWorkspaceSkillEnabled,
} from '../src/index.js';

const accessibility = 'web-dev/react/react-accessibility-a11y-advanced-intermediate.md';
const formHandling = 'web-dev/react/react-form-handling-advanced-intermediate.md';
const task = 'Review keyboard accessibility in this form';
const instructions = 'Verify that error messages are announced after focus moves.';

async function fixture(t) {
  const project = await mkdtemp(path.join(tmpdir(), 'osf-workspace-selection-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(path.join(project, 'package.json'), '{"dependencies":{"react":"fixture"}}');
  return project;
}

function makeRecipe(project, agent) {
  return {
    project, agent, title: 'Keyboard Form Review',
    useWhen: 'Review keyboard accessibility and form submission behavior.',
    instructions, sourcePaths: [accessibility, formHandling],
  };
}

test('one matching combined skill occupies one slot and excludes duplicate catalog families', async t => {
  const project = await fixture(t);
  const { recipe } = await createWorkspaceSkill(makeRecipe(project, 'codex'));
  const options = { project, agent: 'codex', query: task, tokenBudget: 2400 };
  const result = await selectSkills({ ...options, maxSkills: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].kind, 'workspace');
  assert.equal(result.matches[0].recipeId, recipe.id);
  assert.equal(result.matches[0].path, `workspace/${recipe.id}.md`);
  assert.deepEqual(result.matches[0].sourcePaths, [accessibility, formHandling]);
  assert.ok(result.markdown.includes(accessibility));
  assert.ok(result.markdown.includes(formHandling));
  assert.ok(result.markdown.includes(instructions));
  assert.ok(result.markdown.includes('export function ContactEmailField'));
  assert.ok(result.markdown.includes('export function EmailForm'));
  assert.equal(result.estimatedTokens, Math.ceil(Buffer.byteLength(result.markdown) / 4));
  assert.ok(result.estimatedTokens <= 2400);

  const many = await selectSkills({ ...options, maxSkills: 3 });
  assert.equal(many.matches.filter(skill => skill.kind === 'workspace').length, 1);
  assert.ok(many.matches.filter(skill => skill.kind !== 'workspace').every(skill =>
    !/react-(accessibility-a11y|form-handling)/u.test(skill.path)));
  const cursor = await selectSkills({ ...options, agent: 'cursor', maxSkills: 1 });
  assert.equal(cursor.matches[0].path, accessibility);
  assert.deepEqual((await selectSkills({ ...options, query: 'What is the weather today?' })).matches, []);
  assert.ok(!(await selectSkills({ ...options, query: 'Review Vue keyboard accessibility in this form' }))
    .matches.some(skill => skill.kind === 'workspace'));
});

test('workspace guidance is skipped intact for budget, source exclusions, or a disabled recipe', async t => {
  const project = await fixture(t);
  const { recipe } = await createWorkspaceSkill(makeRecipe(project, null));
  const options = { project, agent: 'codex', query: task };

  const tooLarge = await selectSkills({ ...options, tokenBudget: 1000, maxSkills: 1 });
  assert.equal(tooLarge.matches[0].path, accessibility);
  assert.ok(!tooLarge.markdown.includes(instructions));
  await setSkillSelectionState({ project, path: formHandling, agent: 'codex', status: 'disabled' });
  const blocked = await selectSkills(options);
  assert.ok(!blocked.matches.some(skill => skill.kind === 'workspace'));
  assert.ok(!blocked.markdown.includes(instructions));
  assert.equal((await selectSkills({ ...options, agent: 'cursor', maxSkills: 1 })).matches[0].recipeId, recipe.id);

  await setSkillCategoryState({ project, category: 'web-dev/react', status: 'disabled' });
  assert.deepEqual((await selectSkills({ ...options, agent: 'cursor' })).matches, []);
  await setSkillCategoryState({ project, category: 'web-dev/react', status: 'default' });
  await setWorkspaceSkillEnabled({ project, id: recipe.id, enabled: false });
  const disabledRecipe = await selectSkills({ ...options, agent: 'cursor' });
  assert.equal(disabledRecipe.matches[0].path, accessibility);
  assert.ok(!disabledRecipe.matches.some(skill => skill.kind === 'workspace'));
});
