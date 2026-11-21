import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startManagementDashboard } from '../src/management-dashboard.js';

async function dashboardFixture(t) {
  const testRoot = path.resolve(tmpdir());
  const projectRoot = await mkdtemp(path.join(testRoot, 'osf-dashboard-'));
  assert.equal(path.dirname(path.resolve(projectRoot)), testRoot);
  assert.match(path.basename(projectRoot), /^osf-dashboard-/u);
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const dashboard = await startManagementDashboard({ projectRoot });
  t.after(() => dashboard.close());
  return dashboard;
}

async function post(base, route, data, headers = {}) {
  return fetch(base + route, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
}

async function withHost(base, host) {
  return new Promise((resolve, reject) => {
    const req = request(base + '/api/project', { headers: { Host: host } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard pins loopback host and same-origin JSON requests', async t => {
  const { url, server } = await dashboardFixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.match(await home.text(), /Exactwork Skills/);
  assert.equal(await withHost(url, 'example.test'), 403);
  assert.equal((await fetch(url + '/api/project', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post(url, '/api/preferences', {}, { Origin: 'https://example.test' })).status, 403);
  assert.equal((await fetch(url + '/api/preferences', { method: 'POST' })).status, 403);
  assert.equal((await post(url, '/api/preferences', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(url, '/api/select', { query: 'z'.repeat(36000) })).status, 413);
  assert.equal((await fetch(url + '/missing')).status, 404);
});

test('dashboard paginates metadata and applies revision-checked project and agent preferences', async t => {
  const { url } = await dashboardFixture(t);
  const project = await (await fetch(url + '/api/project')).json();
  assert.ok(project.agents.includes('codex'));
  assert.ok(project.agents.includes('cursor'));
  const getPage = async (agent, params = '') => {
    const response = await fetch(url + '/api/catalog?agent=' + agent + '&query=react%20accessibility' + params);
    assert.equal(response.status, 200);
    return response.json();
  };
  const initialPage = await getPage('codex');
  assert.equal(initialPage.revision, 0);
  assert.equal(initialPage.items.length, initialPage.pageSize);
  assert.ok(initialPage.total > initialPage.items.length);
  const secondPage = await getPage('codex', '&page=2');
  assert.notEqual(secondPage.items[0].path, initialPage.items[0].path);
  assert.equal(initialPage.items[0].markdown, undefined);

  const task = { query: 'Improve React accessibility with keyboard navigation', maxSkills: 2, tokenBudget: 2400 };
  const select = async agent => {
    const response = await post(url, '/api/select', { ...task, agent });
    assert.equal(response.status, 200);
    return response.json();
  };
  const results = await select('codex');
  assert.equal(results.revision, 0);
  assert.ok(results.matches.length > 0 && results.matches.length <= task.maxSkills);
  assert.ok(results.estimatedTokens > 0 && results.estimatedTokens <= task.tokenBudget);
  assert.match(results.markdown, /# Omni Skills Forge task context/);
  const skillPath = results.matches[0].path;
  const mutation = { path: skillPath, agent: 'codex', status: 'disabled', expectedRevision: 0 };
  assert.equal((await post(url, '/api/preferences', mutation)).status, 200);
  assert.equal((await post(url, '/api/preferences', { ...mutation, status: 'enabled' })).status, 409);
  assert.ok(!(await select('codex')).matches.some(candidate => candidate.path === skillPath));
  assert.ok((await select('cursor')).matches.some(candidate => candidate.path === skillPath));
  const disabled = await getPage('codex', '&filter=disabled');
  assert.equal(disabled.items.length, 1);
  assert.equal(disabled.items[0].agentStatus, 'disabled');
  assert.equal(disabled.items[0].projectStatus, 'default');

  const globalMutation = { path: skillPath, status: 'disabled', expectedRevision: 1 };
  assert.equal((await post(url, '/api/preferences', globalMutation)).status, 200);
  assert.ok(!(await select('cursor')).matches.some(candidate => candidate.path === skillPath));
  const cursorDisabled = await getPage('cursor', '&filter=disabled');
  assert.equal(cursorDisabled.items[0].projectStatus, 'disabled');
  assert.equal(cursorDisabled.items[0].agentStatus, 'default');
  assert.equal(cursorDisabled.items[0].eligibility, 'disabled');
  assert.equal((await post(url, '/api/preferences', { ...globalMutation, status: 'default', expectedRevision: 2 })).status, 200);
  assert.equal((await post(url, '/api/preferences', { ...mutation, status: 'enabled', expectedRevision: 3 })).status, 200);
  assert.ok((await select('codex')).matches.some(candidate => candidate.path === skillPath));
});
