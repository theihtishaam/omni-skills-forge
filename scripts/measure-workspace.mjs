import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { recommendWorkspaceSkills, selectSkills } from '../src/skill-selection.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const task = 'Review keyboard accessibility in this form';
const project = await mkdtemp(path.join(tmpdir(), 'omni-workspace-comparison-'));

async function hookDelivery(directory, prompt) {
  const command = run(process.execPath, [cli, 'hook', '--project', project, '--agent', 'codex']);
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
  console.log(JSON.stringify({ task, agent: 'codex', standbySuggestions: standby.suggestions.length, cases }, null, 2));
} finally {
  await rm(project, { recursive: true, force: true });
}
