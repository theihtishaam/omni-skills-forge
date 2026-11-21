import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { listSkillDeliveries } from '../src/skill-delivery.js';
import { runPromptHook } from '../src/skill-prompt-hook.js';
import { selectSkills, setSkillSelectionState } from '../src/skill-selection.js';
import { listWorkspaceSkills } from '../src/workspace-skills.js';

async function invoke(project, agent, event, tokenBudget = 1400) {
  let text = '';
  const input = Readable.from([typeof event === 'string' ? event : JSON.stringify(event)]);
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  await runPromptHook({ project, agent, tokenBudget, maxSkills: 1 }, { input, output });
  return text;
}

test('prompt hooks emit one selected pack, respect agent settings, and ignore unrelated or out-of-project events', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'osf-hook-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = join(scratch, 'checkout');
  const child = join(project, 'ui');
  await mkdir(child, { recursive: true });
  const query = 'Review React accessibility for keyboard navigation and focus in a form';
  const event = { hook_event_name: 'UserPromptSubmit', cwd: child, prompt: query };
  const select = agent => selectSkills({ project, directory: 'ui', agent, query, tokenBudget: 1400, maxSkills: 1 });
  for (const agent of ['claude-code', 'codex']) {
    const picked = await select(agent);
    assert.equal(picked.matches.length, 1);
    assert.deepEqual(JSON.parse(await invoke(project, agent, event)), {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: picked.markdown }
    });
    const [receipt] = await listSkillDeliveries({ project, agent });
    assert.equal(receipt.method, 'hook');
    assert.equal(receipt.directory, 'ui');
    assert.deepEqual(receipt.paths, [picked.matches[0].path]);
  }
  const before = await select('claude-code');
  await setSkillSelectionState({ project, agent: 'claude-code', path: before.matches[0].path,
    status: 'disabled', expectedRevision: before.revision });
  const claudeAfter = await invoke(project, 'claude-code', event);
  assert.ok(!claudeAfter || JSON.parse(claudeAfter).hookSpecificOutput.additionalContext !== before.markdown);
  assert.equal(JSON.parse(await invoke(project, 'codex', event)).hookSpecificOutput.additionalContext, before.markdown);
  const receipts = await listSkillDeliveries({ project });
  for (const invalid of ['malformed json', { ...event, cwd: scratch }, { ...event, hook_event_name: 'SessionStart' },
    { ...event, prompt: 'count turquoise marmalade teacups' }, { ...event, prompt: 'a'.repeat(140_000) }]) {
    assert.equal(await invoke(project, 'codex', invalid), '');
  }
  assert.deepEqual(await listSkillDeliveries({ project }), receipts);
});

test('prompt hooks fail open when stdout or receipt storage is unavailable', async t => {
  const project = await mkdtemp(join(tmpdir(), 'osf-hook-output-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const event = {
    hook_event_name: 'UserPromptSubmit', cwd: project, prompt: 'Review React accessibility for keyboard navigation',
  };
  let attemptedWrite = false;
  const output = new Writable({
    write(_chunk, _encoding, done) {
      attemptedWrite = true;
      done(new Error('stdout unavailable'));
    },
  });
  await runPromptHook({ project, agent: 'codex' }, { input: Readable.from([JSON.stringify(event)]), output });
  assert.equal(attemptedWrite, true);
  assert.deepEqual(await listSkillDeliveries({ project }), []);

  const settings = join(project, '.omni-skills-forge');
  await mkdir(settings);
  await writeFile(join(settings, 'deliveries'), 'receipt directory unavailable');
  const context = JSON.parse(await invoke(project, 'codex', event)).hookSpecificOutput;
  assert.equal(context.hookEventName, 'UserPromptSubmit');
  assert.match(context.additionalContext, /Token counts are estimates/);
});

test('native prompt hooks save explicit skill requests and attach the saved skill on a later task', async t => {
  const temporaryDirectory = resolve(tmpdir());
  const scratch = await mkdtemp(join(temporaryDirectory, 'osf-hook-create-'));
  assert.equal(dirname(resolve(scratch)), temporaryDirectory);
  assert.match(basename(scratch), /^osf-hook-create-/u);
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = join(scratch, 'checkout');
  const child = join(project, 'ui');
  await mkdir(child, { recursive: true });
  const task = 'reviewing React accessibility for keyboard navigation in a form without losing input. Confirm keyboard focus. For example, inspect the first invalid field.';
  const event = { hook_event_name: 'UserPromptSubmit', cwd: child };
  const query = 'Review React accessibility for keyboard navigation and focus in a form';
  const example = `Make one skill for ${task}`;
  for (const prompt of [
    query, `“${example}”`, `Example: ${example}`, `\`\`\`\n${example}\n\`\`\``, `${example}?`,
    `Can you make a workspace skill for ${task}?`, `Do not ${example.toLowerCase()}`,
    `${example} Without actually saving it.`, `${example} But don't save it.`, `${example} Just show a preview.`,
    `${example} as a simulation`, `${example} Simulate the creation.`, `${example} as a dry run`, `${example}, preview only`,
    `${example} if I confirm`, `Pretend I said: ${example}`,
  ]) {
    const output = await invoke(project, 'codex', { ...event, prompt });
    assert.doesNotMatch(output, /Saved the Omni workspace skill/u);
  }
  await invoke(project, 'codex', { ...event, cwd: scratch, prompt: example });
  assert.deepEqual(await listWorkspaceSkills({ project }), { revision: 0, recipes: [] });
  const baseline = await listSkillDeliveries({ project });

  for (const agent of ['codex', 'claude-code']) {
    const attempt = async prompt => JSON.parse(await invoke(project, agent, { ...event, prompt })).hookSpecificOutput;
    const unmatched = await attempt('Make one skill for turquoise marmalade teacups');
    assert.match(unmatched.additionalContext, /No eligible catalog skill/u);
    const created = await attempt(example);
    assert.equal(created.hookEventName, 'UserPromptSubmit');
    assert.match(created.additionalContext, /^Saved the Omni workspace skill/u);
    const { recipes, revision } = await listWorkspaceSkills({ project });
    const recipe = recipes.find(item => item.agent === agent);
    assert.ok(recipe);
    for (const value of [recipe.title, recipe.id, ...recipe.sourcePaths]) assert.ok(created.additionalContext.includes(value));
    assert.doesNotMatch(created.additionalContext, /###? Role|Token counts are estimates/u);
    for (const verb of ['Create a workspace skill', 'Save a skill']) {
      const reused = await attempt(`${verb} for ${task}`);
      assert.match(reused.additionalContext, /^Reused the Omni workspace skill/u);
      assert.ok(reused.additionalContext.includes(recipe.id));
    }
    assert.deepEqual(await listWorkspaceSkills({ project }), { recipes, revision });
  }
  assert.deepEqual(await listSkillDeliveries({ project }), baseline);
  const { recipes, revision } = await listWorkspaceSkills({ project });
  assert.equal(revision, 2);
  assert.equal(recipes.length, 2);

  for (const recipe of recipes) {
    const selected = await invoke(project, recipe.agent, { ...event, prompt: query }, 2400);
    const context = JSON.parse(selected).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`Workspace recipe ${recipe.title}`));
    const deliveries = await listSkillDeliveries({ project, agent: recipe.agent });
    const virtualPath = `workspace/${recipe.id}.md`;
    assert.ok(deliveries.some(delivery => delivery.method === 'hook' && delivery.directory === 'ui' && delivery.paths.includes(virtualPath)));
  }
  assert.deepEqual(await listWorkspaceSkills({ project }), { recipes, revision });
});
