import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listSkillDeliveries } from '../src/skill-delivery.js';
import { runSkillMcp } from '../src/skill-mcp.js';
import { setSkillSelectionState } from '../src/skill-selection.js';

const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const skill = 'web-dev/react/react-accessibility-a11y-best-practices-intermediate.md';
const query = 'Improve React accessibility a11y best practices';
const init = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'omni-test-client', version: '1.0.0' },
};
const baseline = [request(1, 'initialize', init), request(undefined, 'notifications/initialized')];

function request(id, method, params) {
  return { jsonrpc: '2.0', id, method, params };
}

function call(id, args) {
  return request(id, 'tools/call', { name: 'select_skills', arguments: args });
}

function runMcp(project, agent, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'mcp', '--project', project, '--agent', agent], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('The Omni MCP subprocess timed out.'));
    }, 20000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', reject);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || stderr) {
        reject(new Error(`Omni MCP exited with ${code}. ${stderr}`));
        return;
      }
      try {
        resolve(stdout.trim().split('\n').map(line => JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
    const frames = messages.flatMap(message => [
      Buffer.isBuffer(message) ? message : Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)),
      Buffer.from('\r\n'),
    ]);
    child.stdin.end(Buffer.concat(frames));
  });
}

test('Omni MCP negotiates stdio, pins project and agent, and returns only selected guidance', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'omni mcp test '));
  try {
    const focus = path.join(project, 'apps', 'web');
    await mkdir(focus, { recursive: true });
    await writeFile(path.join(focus, 'package.json'), JSON.stringify({ dependencies: { react: '19.0.0' } }));
    await setSkillSelectionState({ project, agent: 'codex', path: skill, status: 'disabled' });
    await setSkillSelectionState({ project, agent: 'claude-code', path: skill, status: 'enabled' });
    const [codex, claude] = await Promise.all([
      runMcp(project, 'codex', [
        request('discovery', 'server/discover'),
        request(0, 'tools/list'),
        baseline[0],
        request('init-ping', 'ping'),
        baseline[1],
        request(2, 'tools/list'),
        call(3, { query, maxSkills: 1 }),
        call(4, { query, agent: 'claude-code' }),
        call(5, { query, project: path.dirname(project) }),
        call(6, { query, tokenBudget: 1 }),
        call(7, { query: 'Thank you!' }),
        call(8, { query, maxSkills: 1.5 }),
        request(9, 'tools/call', { name: 'unknown_tool' }),
        call('absolute', { query, directory: focus }),
        call('drive', { query, directory: 'C:\\apps\\web' }),
        call('parent', { query, directory: 'apps/../apps/web' }),
        call('nonexistent', { query, directory: 'apps/missing' }),
        call('invalid-type', { query, directory: 3 }),
        'invalid json',
        Buffer.concat([Buffer.from('"'), Buffer.from([0xff]), Buffer.from('"')]),
        'x'.repeat(70 * 1024),
        request(10, 'ping'),
      ]),
      runMcp(project, 'claude-code', [
        request(1, 'initialize', { ...init, protocolVersion: '2024-11-05' }),
        baseline[1],
        call(3, { query, directory: 'apps/web', maxSkills: 1 }),
        call(4, { query: 'Thank you!', directory: 'apps/web' }),
      ]),
    ]);
    const byId = new Map(codex.map(message => [message.id, message]));
    assert.ok(codex.every(message => message.jsonrpc === '2.0'));
    assert.equal(codex.length, 21);
    assert.equal(byId.get('discovery').error.code, -32601);
    assert.equal(byId.get(0).error.code, -32002);
    assert.deepEqual(byId.get('init-ping').result, {});
    assert.equal(byId.get(1).result.protocolVersion, '2025-11-25');
    assert.equal(claude[0].result.protocolVersion, '2024-11-05');
    assert.ok(byId.get(1).result.capabilities.tools);
    assert.match(byId.get(1).result.instructions, /prompt hook/);
    for (const message of [byId.get(1), byId.get(2)]) {
      assert.ok(JSON.stringify(message).length < 2000);
      assert.ok(!JSON.stringify(message).includes(skill));
    }
    const [tool] = byId.get(2).result.tools;
    assert.equal(byId.get(2).result.tools.length, 1);
    assert.equal(tool.name, 'select_skills');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.properties.directory.type, 'string');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(byId.get(3).result.content.length, 1);
    assert.equal(byId.get(3).result.isError, undefined);
    assert.ok(!byId.get(3).result.content[0].text.includes(skill));
    assert.equal(byId.get(4).error.code, -32602);
    assert.equal(byId.get(5).error.code, -32602);
    assert.deepEqual(byId.get(6).result.content, []);
    assert.deepEqual(byId.get(7).result.content, []);
    assert.equal(byId.get(8).error.code, -32602);
    assert.equal(byId.get(9).error.code, -32602);
    for (const id of ['absolute', 'drive', 'parent', 'nonexistent', 'invalid-type']) {
      assert.equal(byId.get(id).error.code, -32602);
    }
    assert.deepEqual(codex.filter(message => message.id === null).map(message => message.error.code), [-32700, -32700, -32600]);
    assert.deepEqual(byId.get(10).result, {});

    const { content, structuredContent } = claude[1].result;
    assert.equal(content.length, 1);
    assert.equal(structuredContent, undefined);
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /Token counts are estimates/);
    const skillText = (await readFile(new URL(`../skills/${skill}`, import.meta.url), 'utf8')).trim();
    assert.equal(content[0].text.split(skillText).length, 2);
    assert.ok(content[0].text.includes(skill));
    assert.ok(Math.ceil(Buffer.byteLength(content[0].text) / 4) <= tool.inputSchema.properties.tokenBudget.default);
    assert.deepEqual(claude[2].result.content, []);

    const deliveries = await listSkillDeliveries({ project });
    assert.equal(deliveries.length, 2);
    const claudeDelivery = deliveries.find(delivery => delivery.agent === 'claude-code');
    assert.equal(claudeDelivery.method, 'mcp');
    assert.equal(claudeDelivery.directory, 'apps/web');
    assert.deepEqual(claudeDelivery.paths, [skill]);
    const codexDelivery = deliveries.find(delivery => delivery.agent === 'codex');
    assert.equal(codexDelivery.method, 'mcp');
    assert.equal(codexDelivery.directory, '.');
    assert.equal(codexDelivery.paths.length, 1);
    assert.ok(byId.get(3).result.content[0].text.includes(codexDelivery.paths[0]));
    assert.ok(!JSON.stringify(deliveries).includes(query));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('Omni MCP delivers selected guidance when local delivery recording is unavailable', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'omni mcp blocked receipt '));
  try {
    const settings = path.join(project, '.omni-skills-forge');
    await mkdir(settings);
    await writeFile(path.join(settings, 'deliveries'), 'placeholder');
    const messages = await runMcp(project, 'codex', [...baseline, call(2, { query, maxSkills: 1 })]);
    assert.equal(messages[1].result.content.length, 1);
    assert.match(messages[1].result.content[0].text, /Token counts are estimates/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('Omni MCP records no delivery when the selected response fails to write', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'omni mcp failed write '));
  try {
    const frames = [...baseline, call(2, { query, maxSkills: 1 })];
    const input = Readable.from(frames.map(frame => `${JSON.stringify(frame)}\n`));
    const output = new Writable({
      write(chunk, _encoding, done) {
        const message = JSON.parse(chunk.toString());
        if (message.id === 2) done(new Error('transport write failure'));
        else done();
      },
    });
    await assert.rejects(runSkillMcp({ project, agent: 'codex', input, output }), /transport write failure/);
    assert.deepEqual(await listSkillDeliveries({ project }), []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
