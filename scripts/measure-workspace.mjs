import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { recommendWorkspaceSkills, selectSkills, setSkillCategoryState } from '../src/skill-selection.js';
import { makeWorkspaceSkill } from '../src/make-workspace-skill.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const task = 'Review keyboard accessibility in this form';
const project = await mkdtemp(path.join(tmpdir(), 'omni-workspace-comparison-'));

async function hookDelivery(directory, prompt, agent = 'codex', options = []) {
  const command = run(process.execPath, [cli, 'hook', '--project', project, '--agent', agent, ...options]);
  command.child.stdin.end(JSON.stringify({
    hook_event_name: 'UserPromptSubmit', cwd: path.join(project, directory), prompt,
  }));
  const { stdout } = await command;
  return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '';
}

async function measure(label, directory, prompt) {
  const selection = await selectSkills({ project, directory, agent: 'codex', query: prompt });
  const delivered = await hookDelivery(directory, prompt);
  if (delivered !== selection.markdown) throw new Error('The hook response differs from the preview.');
  return { label, directory, prompt, skills: selection.matches.map(skill => skill.path),
    technologies: selection.workspace.technologies.map(tech => tech.name),
    deliveredBytes: Buffer.byteLength(delivered) };
}

try {
  await mkdir(path.join(project, 'storefront'));
  await writeFile(path.join(project, 'storefront', 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
  const standby = await recommendWorkspaceSkills({ project, directory: 'storefront', agent: 'codex' });
  const cases = [
    await measure('Empty workspace', '.', task),
    await measure('React storefront', 'storefront', task),
    await measure('Unrelated request', 'storefront', 'What is the weather like today?'),
  ];
  const useWhen = 'Review checkout keyboard accessibility and form submission';
  const instructions = 'Confirm that a failed checkout submission preserves the customer input.';
  const made = await makeWorkspaceSkill({ project, directory: 'storefront', agent: 'codex',
    instruction: 'Make one skill for reviewing keyboard accessibility and form submission in React checkout. ' + instructions });
  assert.ok(made.created);
  const title = made.recipe.title;
  const sourcePaths = made.sources.map(source => source.path);
  const options = { directory: 'storefront', agent: 'codex', project, query: useWhen, maxSkills: 1 };
  const recipe = await selectSkills(options);
  assert.equal(recipe.matches.length, 1);
  assert.equal(recipe.matches[0].kind, 'workspace');
  const delivered = await hookDelivery('storefront', useWhen, 'codex', ['--max-skills', '1']);
  assert.equal(delivered, recipe.markdown);
  assert.ok(delivered.includes(instructions));

  const other = await hookDelivery('storefront', useWhen, 'claude-code', ['--max-skills', '1']);
  assert.ok(!other.includes(instructions));
  await setSkillCategoryState({ project, agent: 'codex', category: 'web-dev/react', status: 'disabled' });
  const blocked = await hookDelivery('storefront', useWhen, 'codex', ['--max-skills', '1']);
  assert.ok(!blocked.includes(instructions));
  const workspaceSkill = { title, sourcePaths, deliveredAs: recipe.matches.length,
    guidanceReachedCodex: true, guidanceReachedClaude: false, guidanceReachedCodexAfterCategoryDisabled: false };
  console.log(JSON.stringify({ task, agent: 'codex', standbySuggestions: standby.suggestions.length, cases, workspaceSkill }, null, 2));
} finally {
  await rm(project, { recursive: true, force: true });
}
