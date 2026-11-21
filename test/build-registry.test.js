import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

test('registry builder keeps both newline formats and preserves the last valid index on bad input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'osf-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = join(root, 'skills', 'docs');
  await mkdir(catalog, { recursive: true });
  // The release script locates the package root one level above its own folder.
  const scripts = join(root, 'scripts');
  await mkdir(scripts);
  const script = join(scripts, 'build-registry.mjs');
  await copyFile(new URL('../scripts/build-registry.js', import.meta.url), script);
  const run = () => promisify(execFile)(process.execPath, [script], { cwd: root });
  const lines = ['---', 'name: Writing guide', 'category: docs', 'tags: [writing]', '---', 'Use a specific heading.'];
  await writeFile(join(catalog, 'windows.md'), lines.join('\r\n'));
  await writeFile(join(catalog, 'unix.md'), lines.join('\n'));
  await run();
  const index = join(root, 'registry', 'master-registry.json');
  const before = await readFile(index, 'utf8');
  const registered = JSON.parse(before);
  assert.equal(registered.totalSkills, 2);
  assert.deepEqual(registered.skills.map(skill => skill.file).sort(), ['docs/unix.md', 'docs/windows.md']);
  await writeFile(join(catalog, 'broken.md'), 'Missing frontmatter');
  await assert.rejects(run);
  assert.equal(await readFile(index, 'utf8'), before);
});
