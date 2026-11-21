import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { detectWorkspaceProfile } from '../src/workspace-profile.js';
import {
  loadSkillSelectionState, recommendWorkspaceSkills, selectSkills, setSkillSelectionState,
} from '../src/skill-selection.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const task = 'Review keyboard accessibility in this form';
const appScope = 'apps/web';

async function fixture(t) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'osf-workspace-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

async function createReactManifest(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'synthetic-demo',
    dependencies: { react: 'synthetic-value-omit-in-evidence' },
    scripts: { probe: 'exit 97' },
  }));
}

test('detected workspace signals guide a task with no explicit technology and yield to explicit intent', async t => {
  const react = await fixture(t);
  const python = await fixture(t);
  const empty = await fixture(t);
  await createReactManifest(react);
  await writeFile(path.join(python, 'pyproject.toml'), 'This fixture content is irrelevant to filename detection.');

  const workspace = await detectWorkspaceProfile({ project: react });
  assert.deepEqual(workspace, {
    directory: '.', technologies: [{ name: 'React', sources: [{ directory: '.', file: 'package.json' }] }],
  });
  const result = await selectSkills({ project: react, query: task, maxSkills: 1 });
  assert.deepEqual(result.workspace, workspace);
  assert.match(result.matches[0].path, /^web-dev\/react\/react-accessibility-a11y-/u);
  assert.match(result.matches[0].reason, /React in package\.json/u);
  assert.equal(result.estimatedTokens, Math.ceil(Buffer.byteLength(result.markdown) / 4));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-value|exit 97/u);

  assert.deepEqual((await selectSkills({ project: python, query: task })).matches, []);
  assert.deepEqual((await selectSkills({ project: empty, query: task })).matches, []);
  const explicit = await selectSkills({ project: python, query: 'React accessibility testing', maxSkills: 1 });
  assert.match(explicit.matches[0].path, /react-accessibility-a11y-testing/u);
  assert.doesNotMatch(explicit.matches[0].reason, /Workspace signals/u);
  const pythonTask = await selectSkills({ project: python, query: 'Create fixtures for pytest unit tests', maxSkills: 1 });
  assert.match(pythonTask.matches[0].path, /^backend\/python\/python-testing-pytest-/u);
  const nextTask = await selectSkills({ project: react, query: 'Next.js server components', maxSkills: 1 });
  assert.match(nextTask.matches[0].path, /^web-dev\/nextjs\/nextjs-server-components/u);
  const goVerb = await selectSkills({ project: react, query: 'Go review keyboard accessibility in this form', maxSkills: 1 });
  assert.match(goVerb.matches[0].path, /^web-dev\/react\/react-accessibility-a11y-/u);
  for (const query of ['', 'What is the weather like today?', 'Tell me a joke', 'What is the state of the weather?']) {
    assert.deepEqual((await selectSkills({ project: react, query })).matches, []);
  }
  assert.deepEqual(await readdir(react), ['package.json']);
  assert.deepEqual(await readdir(python), ['pyproject.toml']);
  assert.deepEqual(await readdir(empty), []);
});

test('nested workspace recommendations use local evidence and keep agent preferences at the project root', async t => {
  const project = await fixture(t);
  await writeFile(path.join(project, 'pyproject.toml'), '[project]\n');
  const web = path.join(project, appScope);
  await createReactManifest(web);
  await mkdir(path.join(web, 'src', 'forms'), { recursive: true });

  const root = await recommendWorkspaceSkills({ project, maxSkills: 2 });
  assert.equal(root.workspace.technologies[0].name, 'Python');
  assert.ok(root.suggestions.every(skill => skill.category === 'backend/python'));
  const options = { project, directory: 'apps/web/src/forms', agent: 'codex' };
  const initial = await recommendWorkspaceSkills({ ...options, maxSkills: 2 });
  assert.equal(initial.workspace.directory, 'apps/web/src/forms');
  assert.deepEqual(initial.workspace.technologies, [{
    name: 'React', sources: [{ directory: appScope, file: 'package.json' }],
  }]);
  assert.equal(initial.suggestions.length, 2);
  assert.ok(initial.suggestions.every(skill => skill.category === 'web-dev/react'));
  assert.equal(Object.hasOwn(initial, 'markdown'), false);

  const chosen = (await selectSkills({ ...options, query: task, maxSkills: 1 })).matches[0].path;
  await setSkillSelectionState({ project, agent: 'codex', path: chosen, status: 'disabled' });
  const excluded = await selectSkills({ ...options, query: task });
  assert.ok(!excluded.matches.some(skill => skill.path === chosen));
  assert.ok(!(await recommendWorkspaceSkills(options)).suggestions.some(skill => skill.path === chosen));
  assert.equal((await selectSkills({ ...options, agent: 'cursor', query: task, maxSkills: 1 })).matches[0].path, chosen);
  assert.equal((await loadSkillSelectionState({ project })).agentOverrides.codex[chosen], 'disabled');
  assert.equal((await readdir(web)).includes('.omni-skills-forge'), false);

  const cliResult = await run(process.execPath, [
    cli, 'select', task, '--project', project, '--directory', appScope, '--agent', 'cursor', '--max-skills', '1', '--json',
  ]);
  const preview = JSON.parse(cliResult.stdout);
  assert.equal(preview.workspace.directory, appScope);
  assert.equal(preview.matches[0].path, chosen);
});

test('workspace inspection rejects escapes and ignores linked, oversized and unsupported manifests', async t => {
  const project = await fixture(t);
  const external = await fixture(t);
  await createReactManifest(external);
  await t.test('linked directories cannot change workspace scope', async t => {
    try {
      await symlink(external, path.join(project, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      return t.skip('This execution environment cannot create a directory link.');
    }
    await assert.rejects(detectWorkspaceProfile({ project, directory: 'linked-directory' }), {
      code: 'INVALID_SELECTION_INPUT',
    });
  });
  for (const directory of ['..', 'foo/../bar', external, 'C:\\projects', '.ssh', 'bad\nfolder']) {
    await assert.rejects(detectWorkspaceProfile({ project, directory }), { code: 'INVALID_SELECTION_INPUT' });
  }
  await link(path.join(external, 'package.json'), path.join(project, 'package.json'));
  assert.deepEqual((await detectWorkspaceProfile({ project })).technologies, []);

  const oversized = await fixture(t);
  await writeFile(path.join(oversized, 'package.json'), JSON.stringify({
    dependencies: { react: 'x', 'not-a-recognized-package': 'x' },
    description: 'x'.repeat(64 * 1024),
  }));
  assert.deepEqual((await detectWorkspaceProfile({ project: oversized })).technologies, []);

  const unsupported = await fixture(t);
  await writeFile(path.join(unsupported, 'package.json'), '{"scripts":{"react":"exit 97"},"name":"react"}');
  assert.deepEqual((await detectWorkspaceProfile({ project: unsupported })).technologies, []);
});

test('fixed Go, Rust, and .NET manifests map to real catalog recommendations by filename alone', async t => {
  const project = await fixture(t);
  await Promise.all(['go.mod', 'Cargo.toml', 'Directory.Build.props'].map(file =>
    writeFile(path.join(project, file), 'synthetic contents unavailable to the detector')));
  const response = await recommendWorkspaceSkills({ project });
  assert.deepEqual(response.workspace.technologies, [
    { name: 'C#', sources: [{ directory: '.', file: 'Directory.Build.props' }] },
    { name: 'Go', sources: [{ directory: '.', file: 'go.mod' }] },
    { name: 'Rust', sources: [{ directory: '.', file: 'Cargo.toml' }] },
  ]);
  assert.deepEqual(response.suggestions.map(skill => skill.category), ['backend/csharp', 'backend/go', 'backend/rust']);
});
