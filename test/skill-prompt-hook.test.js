import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { listSkillDeliveries } from '../src/skill-delivery.js';
import { runPromptHook } from '../src/skill-prompt-hook.js';
import { selectSkills, setSkillSelectionState } from '../src/skill-selection.js';

async function invoke(project, agent, event) {
  let text = '';
  const input = Readable.from([typeof event === 'string' ? event : JSON.stringify(event)]);
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  await runPromptHook({ project, agent, tokenBudget: 1400, maxSkills: 1 }, { input, output });
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
