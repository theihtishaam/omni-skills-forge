import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { selectSkills, setSkillCategoryState, setSkillSelectionState } from '../src/skill-selection.js';
import {
  WORKSPACE_SKILL_LIMITS, composeWorkspaceSkill, createWorkspaceSkill, listWorkspaceSkills,
  previewWorkspaceSkill, removeWorkspaceSkill, renderWorkspaceSkill, setWorkspaceSkillEnabled,
} from '../src/workspace-skills.js';

const sourcePaths = [
  'web-dev/react/react-accessibility-a11y-best-practices-intermediate.md',
  'web-dev/react/react-accessibility-a11y-testing-intermediate.md',
];
const draft = {
  title: 'Checkout keyboard accessibility',
  useWhen: 'Review keyboard accessibility in React checkout forms',
  instructions: 'Verify keyboard focus returns to the checkout button.',
  sourcePaths,
};
const query = 'Review React checkout keyboard accessibility';

async function fixture(t) {
  const root = path.resolve(tmpdir());
  const scratch = await mkdtemp(path.join(root, 'osf-workspace-recipes-'));
  assert.equal(path.dirname(path.resolve(scratch)), root);
  assert.match(path.basename(scratch), /^osf-workspace-recipes-/u);
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = path.join(scratch, 'checkout');
  const other = path.join(scratch, 'other');
  await Promise.all([mkdir(project), mkdir(other)]);
  return { project, other };
}

test('workspace recipes compose current catalog sources and respect live project and agent exclusions', async t => {
  const { project, other } = await fixture(t);
  const preview = await previewWorkspaceSkill({ project, ...draft, agent: 'codex' });
  assert.equal(preview.recipe.id, null);
  assert.equal(preview.revision, 0);
  assert.deepEqual(preview.sourcePaths, sourcePaths);
  assert.match(preview.markdown, /Workspace recipe Checkout keyboard accessibility/u);
  assert.match(preview.markdown, /Verify keyboard focus returns/u);
  for (const source of sourcePaths) assert.ok(preview.markdown.includes(source));
  assert.equal(preview.markdown.match(/^#### Role$/gmu).length, 1);
  assert.doesNotMatch(preview.markdown, /^name:|^difficulty:|^---$/mu);
  assert.equal(preview.estimatedTokens, Math.ceil(Buffer.byteLength(preview.markdown) / 4));
  const largePreview = await previewWorkspaceSkill({ project, ...draft, tokenBudget: 50 });
  assert.equal(largePreview.markdown, preview.markdown);
  assert.equal(largePreview.estimatedTokens, preview.estimatedTokens);
  assert.equal(largePreview.tokenBudget, 50);
  assert.equal(largePreview.fitsBudget, false);
  assert.deepEqual(await listWorkspaceSkills({ project }), { revision: 0, recipes: [] });
  assert.deepEqual(await readdir(project), []);

  const { recipe, revision } = await createWorkspaceSkill({ project, ...draft });
  assert.equal(revision, 1);
  assert.equal(recipe.agent, null);
  assert.equal(recipe.enabled, true);
  assert.match(recipe.id, /^[0-9a-f-]{36}$/u);
  const compose = (agent, options) => composeWorkspaceSkill({ project, id: recipe.id, agent, ...options });
  assert.equal((await compose('codex')).markdown, preview.markdown);
  await assert.rejects(composeWorkspaceSkill({ project: other, id: recipe.id }), { status: 404 });
  const select = async (agent, options) => selectSkills({ project, agent, query, maxSkills: 1, ...options });
  const recipePath = `workspace/${recipe.id}.md`;
  const picked = (await select('codex')).matches;
  assert.deepEqual(picked.map(match => match.path), [recipePath]);
  assert.deepEqual(picked[0].sourcePaths, sourcePaths);
  assert.ok(!(await select('codex', { query: 'Count turquoise teacups' })).matches.some(match => match.path === recipePath));
  assert.ok(!(await select('codex', { tokenBudget: 50 })).matches.some(match => match.path === recipePath));
  assert.ok(!(await select('codex', { project: other })).matches.some(match => match.path === recipePath));

  await setSkillSelectionState({ project, agent: 'codex', path: sourcePaths[1], status: 'disabled' });
  await assert.rejects(compose('codex'), error => error.status === 409 && error.message.includes(sourcePaths[1]));
  await assert.rejects(previewWorkspaceSkill({ project, ...draft, agent: 'codex' }), { code: 'BLOCKED_WORKSPACE_RECIPE_SOURCE' });
  assert.ok(!(await select('codex')).matches.some(match => match.path === recipePath));
  assert.equal((await compose('claude-code')).markdown, preview.markdown);
  assert.equal((await select('claude-code')).matches[0].path, recipePath);

  await setSkillCategoryState({ project, category: 'web-dev', status: 'disabled' });
  await assert.rejects(compose('claude-code'), { code: 'BLOCKED_WORKSPACE_RECIPE_SOURCE' });
  assert.ok(!(await select('claude-code')).matches.some(match => match.path === recipePath));
  await setSkillCategoryState({ project, category: 'web-dev', status: 'enabled' });
  await setSkillSelectionState({ project, agent: 'codex', path: sourcePaths[1], status: 'enabled' });
  assert.equal((await select('codex')).matches[0].path, recipePath);
  await setWorkspaceSkillEnabled({ project, id: recipe.id, enabled: false, expectedRevision: revision });
  await assert.rejects(compose('codex'), { code: 'BLOCKED_WORKSPACE_RECIPE' });
  assert.ok(!(await select('codex')).matches.some(match => match.path === recipePath));
});

test('workspace recipe snapshots preserve concurrent edits and retain only two payloads', async t => {
  const { project, other } = await fixture(t);
  const added = await Promise.all(Array.from({ length: 8 }, (_, index) => createWorkspaceSkill({
    project, ...draft, agent: 'codex', title: `${draft.title} ${index}`,
  })));
  const state = await listWorkspaceSkills({ project });
  assert.equal(state.revision, added.length);
  assert.deepEqual(new Set(state.recipes.map(item => item.id)), new Set(added.map(({ recipe }) => recipe.id)));
  assert.deepEqual(await listWorkspaceSkills({ project: other }), { revision: 0, recipes: [] });
  await assert.rejects(composeWorkspaceSkill({ project, id: state.recipes[0].id, agent: 'claude-code' }), { status: 409 });

  const updates = await Promise.allSettled(state.recipes.slice(0, 2).map(({ id }) => setWorkspaceSkillEnabled({
    project, id, enabled: false, expectedRevision: state.revision,
  })));
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(updates.find(result => result.status === 'rejected').reason.code, 'STALE_RECIPE_REVISION');
  const changed = await listWorkspaceSkills({ project });
  const disabled = changed.recipes.filter(item => !item.enabled);
  assert.equal(disabled.length, 1);
  assert.equal((await setWorkspaceSkillEnabled({ project, id: disabled[0].id, enabled: false })).revision, changed.revision);

  const store = path.join(project, '.omni-skills-forge', 'workspace-recipes');
  const data = JSON.parse(await readFile(path.join(store, `recipes-${changed.revision}.json`), 'utf8'));
  assert.deepEqual(data, changed);
  assert.deepEqual(Object.keys(data.recipes[0]).sort(), ['agent', 'enabled', 'id', 'instructions', 'sourcePaths', 'title', 'useWhen']);
  const files = await Promise.all((await readdir(store)).map(name => stat(path.join(store, name))));
  assert.equal(files.filter(file => file.size > 0).length, 2);
});

test('workspace recipes reject unsafe inputs, retain source provenance, and keep fenced text intact', async t => {
  const { project } = await fixture(t);
  for (const sourcePaths of [['../outside.md'], [draft.sourcePaths[0], draft.sourcePaths[0]], Array(6).fill(draft.sourcePaths[0])]) {
    await assert.rejects(createWorkspaceSkill({ project, ...draft, sourcePaths }), { status: 400 });
  }
  await assert.rejects(createWorkspaceSkill({ project, ...draft, sourcePaths: ['web-dev/react/not-in-registry.md'] }), { status: 422 });
  await assert.rejects(createWorkspaceSkill({ project, ...draft, title: 'x'.repeat(WORKSPACE_SKILL_LIMITS.title + 1) }), { status: 400 });
  await assert.rejects(composeWorkspaceSkill({ project, id: '../outside.json' }), { status: 400 });
  assert.deepEqual(await readdir(project), []);

  const example = '---\nname: fixture\n---\n# Summary\n\n## Shared steps\n\n```sh\n# Comment inside code\necho ok\n```\n';
  const sources = sourcePaths.map(path => ({ path, markdown: example }));
  const recipe = { ...draft, enabled: true };
  const markdown = renderWorkspaceSkill({ recipe, sources });
  assert.match(markdown, /```sh\n# Comment inside code\necho ok\n```/u);
  assert.equal(markdown.match(/^#### Shared steps$/gmu).length, 1);
  for (const source of sourcePaths) assert.ok(markdown.includes(source));
  assert.equal(renderWorkspaceSkill({ recipe, sources: sources.slice(0, 1) }), '');
});

test('revision-checked removal frees a slot without touching catalog skills', async t => {
  const { project } = await fixture(t);
  const create = title => createWorkspaceSkill({ project, ...draft, sourcePaths: [sourcePaths[0]], title });
  let state;
  for (let index = 0; index < WORKSPACE_SKILL_LIMITS.recipes; index += 1) state = await create(`Recipe ${index}`);
  const { revision, recipe } = state;
  assert.equal(state.recipes.length, WORKSPACE_SKILL_LIMITS.recipes);
  await assert.rejects(create('Capacity overflow'), { code: 'WORKSPACE_RECIPE_LIMIT', status: 422 });
  await assert.rejects(removeWorkspaceSkill({ project, id: recipe.id, expectedRevision: revision - 1 }), { status: 409 });
  const removed = await removeWorkspaceSkill({ project, id: recipe.id, expectedRevision: revision });
  assert.equal(removed.revision, revision + 1);
  assert.ok(!removed.recipes.some(item => item.id === recipe.id));
  await assert.rejects(composeWorkspaceSkill({ project, id: recipe.id }), { status: 404 });
  assert.equal((await create('Replacement')).recipes.length, WORKSPACE_SKILL_LIMITS.recipes);
  assert.match((await previewWorkspaceSkill({ project, ...draft })).markdown, /Catalog source/u);
});
