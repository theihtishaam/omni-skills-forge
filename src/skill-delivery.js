import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveSkillProject, SELECTION_AGENTS } from './skill-selection.js';

const maxRecords = 64;
const recordName = /^\d{13}-[a-f0-9-]{36}\.json$/;
const maxBytes = 8192;

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\\:\x00-\x1f\x7f]/u.test(value) && value.split('/').every(s => s && s !== '.' && s !== '..');
}

function valid(record) {
  return record && SELECTION_AGENTS.includes(record.agent) && ['hook', 'mcp'].includes(record.method) &&
    (record.directory === '.' || safeRelative(record.directory)) && Array.isArray(record.paths) &&
    record.paths.length > 0 && record.paths.length <= 10 &&
    record.paths.every(p => safeRelative(p) && p.endsWith('.md'));
}

async function deliveryFolder(project, create) {
  let folder = await resolveSkillProject(project);
  for (const segment of ['.omni-skills-forge', 'deliveries']) {
    folder = path.join(folder, segment);
    if (create) {
      try { await mkdir(folder, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    try {
      if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== folder) {
        throw new Error('Skill delivery history requires an ordinary project directory.');
      }
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return folder;
}

async function records(folder) {
  return (await readdir(folder)).filter(name => recordName.test(name)).sort().reverse();
}

export async function recordSkillDelivery({ project, agent, method, directory = '.', paths }) {
  const record = { id: randomUUID(), at: new Date().toISOString(), agent, method, directory, paths };
  const data = JSON.stringify(record);
  if (!valid(record) || Buffer.byteLength(data) > maxBytes) throw new Error('Invalid skill delivery metadata.');
  const folder = await deliveryFolder(project, true);
  const name = Date.parse(record.at) + '-' + record.id;
  const temp = path.join(folder, name + '.tmp');
  await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temp, path.join(folder, name + '.json'));
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  for (const old of (await records(folder)).slice(maxRecords)) {
    await unlink(path.join(folder, old)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function listSkillDeliveries({ project, agent } = {}) {
  const folder = await deliveryFolder(project, false);
  if (!folder) return [];
  const rows = [];
  for (const name of (await records(folder)).slice(0, maxRecords)) {
    const file = path.join(folder, name);
    let handle;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) continue;
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const current = await handle.stat();
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1 || current.size > maxBytes) continue;
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead !== current.size) continue;
      const row = JSON.parse(buffer.toString('utf8', 0, bytesRead));
      if (valid(row) && name === Date.parse(row.at) + '-' + row.id + '.json' && (!agent || row.agent === agent)) {
        rows.push({ id: row.id, at: row.at, agent: row.agent, method: row.method, directory: row.directory, paths: row.paths });
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    } finally {
      await handle?.close();
    }
  }
  return rows;
}
