import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MAX_WORKSPACE_DIRECTORY_LENGTH = 512;
const maxDirectoryDepth = 12;
const maxPackageBytes = 64 * 1024;
const knownManifests = new Map([
  ['Python', ['pyproject.toml', 'requirements.txt', 'setup.cfg', 'Pipfile']],
  ['Go', ['go.mod']],
  ['Rust', ['Cargo.toml']],
  ['C#', ['Directory.Build.props', 'Directory.Packages.props']],
  ['Docker', ['Dockerfile', 'compose.yaml', 'docker-compose.yml']],
  ['Kubernetes', ['kustomization.yaml', 'kustomization.yml']],
  ['Terraform', ['main.tf']],
]);
const nodeSignals = new Map([
  ['React', ['react', 'react-dom']],
  ['Next.js', ['next']],
  ['Vue', ['vue', 'nuxt']],
  ['Svelte', ['svelte', '@sveltejs/kit']],
  ['Angular', ['@angular/core']],
  ['Astro', ['astro']],
  ['Remix', ['@remix-run/react', '@remix-run/node']],
  ['TypeScript', ['typescript']],
  ['Node.js', ['express', 'fastify', '@nestjs/core']],
]);

function invalidWorkspace(message) {
  return Object.assign(new Error(message), { code: 'INVALID_SELECTION_INPUT', status: 400 });
}

export async function resolveSkillProject(project = process.cwd()) {
  if (typeof project !== 'string' || !project.trim()) throw invalidWorkspace('Choose a project directory.');
  try {
    const root = await realpath(path.resolve(project));
    if ((await lstat(root)).isDirectory()) return root;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  throw invalidWorkspace('The project path must be an existing directory.');
}

function relativeParts(directory) {
  if (directory === '.' || directory === undefined) return [];
  if (typeof directory !== 'string' || !directory.trim() || directory.length > MAX_WORKSPACE_DIRECTORY_LENGTH ||
      path.win32.isAbsolute(directory) || path.posix.isAbsolute(directory) || /[:\u0000-\u001F\u007F]/u.test(directory)) {
    throw invalidWorkspace('Choose a relative directory inside the project.');
  }
  const parts = directory.split(/[\\/]+/u).filter(part => part && part !== '.');
  if (parts.length > maxDirectoryDepth || parts.some(part => part.startsWith('.') || part.endsWith('.') ||
      part !== part.trim())) {
    throw invalidWorkspace('Choose a relative workspace directory without hidden folders or parent traversal.');
  }
  return parts;
}

export async function resolveWorkspaceDirectory({ project, directory } = {}) {
  const projectRoot = await resolveSkillProject(project);
  const parts = relativeParts(directory);
  let focusRoot = projectRoot;
  try {
    for (const part of parts) {
      focusRoot = path.join(focusRoot, part);
      if (!(await lstat(focusRoot)).isDirectory() || path.relative(focusRoot, await realpath(focusRoot)) !== '') {
        throw invalidWorkspace('Workspace directories must be ordinary folders inside the project.');
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    throw invalidWorkspace('The workspace directory does not exist inside the project.');
  }
  return { projectRoot, focusRoot, directory: parts.join('/') || '.' };
}

function unusableFile(error) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code);
}

async function inspectManifest(directory, basename) {
  const file = path.join(directory, basename);
  try {
    const info = await lstat(file);
    if (info.isFile() && info.nlink === 1 && path.relative(file, await realpath(file)) === '') return { file, info };
  } catch (error) {
    if (!unusableFile(error)) throw error;
  }
  return null;
}

async function readPackage(directory) {
  const manifest = await inspectManifest(directory, 'package.json');
  if (!manifest || manifest.info.size > maxPackageBytes) return null;
  let handle;
  try {
    handle = await open(manifest.file, constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== manifest.info.ino || info.dev !== manifest.info.dev ||
        info.size > maxPackageBytes) return null;
    const buffer = Buffer.alloc(maxPackageBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = (await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)).bytesRead;
      if (!count) break;
      bytesRead += count;
    }
    if (bytesRead > maxPackageBytes) return null;
    return JSON.parse(buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error instanceof SyntaxError || unusableFile(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function hasKey(object, key) {
  return object !== null && typeof object === 'object' && !Array.isArray(object) && Object.hasOwn(object, key);
}

async function detectAt(directory, displayDirectory) {
  const workspaceFiles = new Map(knownManifests);
  const directoryName = path.basename(directory);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u.test(directoryName)) {
    workspaceFiles.set('C#', [...knownManifests.get('C#'), `${directoryName}.csproj`]);
  }

  const [node, ...fixed] = await Promise.all([
    readPackage(directory),
    ...Array.from(workspaceFiles, async ([name, basenames]) => {
      const checks = await Promise.all(basenames.map(basename => inspectManifest(directory, basename)));
      const sources = basenames.flatMap((file, index) => checks[index] ? [{ directory: displayDirectory, file }] : []);
      return sources.length ? { name, sources } : null;
    }),
  ]);
  const technologies = fixed.filter(Boolean);
  if (node) {
    const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .filter(key => hasKey(node, key)).map(key => node[key]);
    for (const [name, keys] of nodeSignals) {
      if (keys.some(key => dependencies.some(dependency => hasKey(dependency, key))) ||
          (name === 'Node.js' && hasKey(node, 'engines') && hasKey(node.engines, 'node'))) {
        technologies.push({ name, sources: [{ directory: displayDirectory, file: 'package.json' }] });
      }
    }
  }
  return technologies.sort((left, right) => left.name < right.name ? -1 : Number(left.name > right.name));
}

export async function detectWorkspaceProfile(options = {}) {
  const focus = await resolveWorkspaceDirectory(options);
  // Match only three ordinary filenames in the selected folder; their contents stay unread.
  const documentSkills = [
    ['meeting-notes.md','work/communication/meeting-actions.md'],
    ['weekly-status.md','work/communication/weekly-status-update.md'],
    ['decision-log.md','work/planning/decision-brief.md'],
  ];
  const documents = (await Promise.all(documentSkills.map(async ([file, skill]) =>
    await inspectManifest(focus.focusRoot,file) ? {file,skill} : null))).filter(Boolean);
  for (let current = focus.focusRoot; ; current = path.dirname(current)) {
    const relative = path.relative(focus.projectRoot, current).split(path.sep).join('/') || '.';
    const technologies = await detectAt(current, relative);
    if (technologies.length || current === focus.projectRoot) {
      return { directory: focus.directory, technologies, ...(documents.length ? {documents} : {}) };
    }
  }
}
