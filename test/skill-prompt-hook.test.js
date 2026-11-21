import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runPromptHook } from '../src/skill-prompt-hook.js';
import { selectSkills, setSkillSelectionState } from '../src/skill-selection.js';

async function invoke(project, agent, event) {
  let text = '';
  const input = Readable.from([typeof event === 'string' ? event : JSON.stringify(event)]);
  await runPromptHook({ project, agent, tokenBudget: 1400, maxSkills: 1 }, {
    input, output: { write(chunk) { text += chunk; } }
  });
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
  const select = agent => selectSkills({ project, agent, query, tokenBudget: 1400, maxSkills: 1 });
  for (const agent of ['claude-code', 'codex']) {
    const picked = await select(agent);
    assert.equal(picked.matches.length, 1);
    assert.deepEqual(JSON.parse(await invoke(project, agent, event)), {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: picked.markdown }
    });
  }
  const before = await select('claude-code');
  await setSkillSelectionState({ project, agent: 'claude-code', path: before.matches[0].path,
    status: 'disabled', expectedRevision: before.revision });
  const claudeAfter = await invoke(project, 'claude-code', event);
  assert.ok(!claudeAfter || JSON.parse(claudeAfter).hookSpecificOutput.additionalContext !== before.markdown);
  assert.equal(JSON.parse(await invoke(project, 'codex', event)).hookSpecificOutput.additionalContext, before.markdown);
  for (const invalid of ['malformed json', { ...event, cwd: scratch }, { ...event, hook_event_name: 'SessionStart' },
    { ...event, prompt: 'count turquoise marmalade teacups' }, { ...event, prompt: 'a'.repeat(140_000) }]) {
    assert.equal(await invoke(project, 'codex', invalid), '');
  }
});
