import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { listSkillDeliveries, recordSkillDelivery } from '../src/skill-delivery.js';

test('skill delivery history keeps 64 receipts with metadata scoped to each project and agent', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'osf-delivery-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = join(scratch, 'first');
  const other = join(scratch, 'second');
  await Promise.all([mkdir(project), mkdir(other)]);
  assert.deepEqual(await listSkillDeliveries({ project }), []);
  assert.deepEqual(await readdir(project), []);

  const oldestPath = 'web-dev/react/older-skill.md';
  await recordSkillDelivery({ project, agent: 'codex', method: 'mcp', paths: [oldestPath] });
  await delay(5);
  for (let index = 0; index < 66; index += 1) {
    const claude = index % 2 === 0;
    await recordSkillDelivery({
      project, agent: claude ? 'claude-code' : 'codex', method: claude ? 'hook' : 'mcp',
      directory: claude ? 'apps/web' : '.', paths: [`web-dev/react/skill-${index}.md`],
      prompt: 'Synthetic prompt text that must never be stored',
      markdown: 'Synthetic skill body that must never be stored',
    });
  }

  const otherSkill = 'web-dev/react/other-project-skill.md';
  await recordSkillDelivery({ project: other, agent: 'codex', method: 'hook', paths: [otherSkill] });
  const isolated = await listSkillDeliveries({ project: other });
  assert.equal(isolated.length, 1);
  assert.deepEqual(isolated[0].paths, [otherSkill]);

  const history = await listSkillDeliveries({ project });
  assert.equal(history.length, 64);
  assert.equal(new Set(history.map(row => row.id)).size, history.length);
  assert.ok(history.every((row, index) => index === 0 || row.at <= history[index - 1].at));
  assert.ok(history.every(row => !row.paths.includes(oldestPath) && !row.paths.includes(otherSkill)));
  const claudeHistory = await listSkillDeliveries({ project, agent: 'claude-code' });
  assert.ok(claudeHistory.length > 0 && claudeHistory.length < history.length);
  assert.deepEqual(claudeHistory, history.filter(row => row.agent === 'claude-code'));
  assert.ok(claudeHistory.every(row => row.method === 'hook' && row.directory === 'apps/web'));

  const folder = join(project, '.omni-skills-forge', 'deliveries');
  const files = (await readdir(folder)).sort();
  assert.equal(files.length, history.length);
  const [sample] = history;
  const raw = JSON.parse(await readFile(join(folder, `${Date.parse(sample.at)}-${sample.id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['agent', 'at', 'directory', 'id', 'method', 'paths']);
  assert.deepEqual(raw, sample);

  await assert.rejects(recordSkillDelivery({
    project, agent: 'codex', method: 'mcp', directory: '../second', paths: [otherSkill],
  }), /Invalid skill delivery metadata/);
  await assert.rejects(recordSkillDelivery({
    project, agent: 'codex', method: 'mcp', paths: ['../outside.md'],
  }), /Invalid skill delivery metadata/);
  assert.deepEqual((await readdir(folder)).sort(), files);
});
