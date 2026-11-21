import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveSkillProject } from './workspace-profile.js';

export const WORKSPACE_SKILL_LIMITS = Object.freeze({ recipes: 64, title: 120, useWhen: 600, instructions: 1800, sources: 5 });
const maxSnapshotBytes = 1024 * 1024;
const maxSourceBytes = 64 * 1024;
const retainedSnapshots = 2;
const recipeId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const versionedFile = /^recipes-([1-9][0-9]*)\.json$/u;
const snapshotError = 'Workspace recipes could not be read from an ordinary project file.';

function issue(message, code = 'INVALID_WORKSPACE_RECIPE', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function text(value, field, required = true) {
  if (!required && value === undefined) return '';
  if (typeof value !== 'string' || value.length > WORKSPACE_SKILL_LIMITS[field] ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    throw issue(`Enter ${field === 'useWhen' ? 'when to use this recipe' : field} within ${WORKSPACE_SKILL_LIMITS[field]} characters.`);
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if ((required && !normalized) || (field === 'title' && /[\n\t]/u.test(normalized))) {
    throw issue(field === 'title' ? 'Enter a single-line recipe title.' : 'Describe when to use this recipe.');
  }
  return normalized;
}

function isSourcePath(value) {
  return typeof value === 'string' && value.length <= 512 && value.endsWith('.md') &&
    !/[\\:\x00-\x1f\x7f`]/u.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function draftFields({ title, useWhen, instructions, sourcePaths, agent }, agents) {
  if (agent != null && !agents.includes(agent)) throw issue('Choose an agent supported by Omni Skills Forge.');
  if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.length > WORKSPACE_SKILL_LIMITS.sources ||
      !sourcePaths.every(isSourcePath) || new Set(sourcePaths).size !== sourcePaths.length) {
    throw issue(`Choose one to ${WORKSPACE_SKILL_LIMITS.sources} distinct catalog skill paths.`);
  }
  return {
    title: text(title, 'title'), useWhen: text(useWhen, 'useWhen'), instructions: text(instructions, 'instructions', false),
    sourcePaths: [...sourcePaths], agent: agent ?? null,
  };
}

async function recipeDirectory(root, create) {
  let current = root;
  for (const name of ['.omni-skills-forge', 'workspace-recipes']) {
    current = path.join(current, name);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    try {
      if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) {
        throw issue('Workspace recipes require an ordinary directory inside the project.', 'INVALID_RECIPE_STORAGE', 422);
      }
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return current;
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

// The only allowed second link is the temporary name used to atomically publish this snapshot.
async function localSnapshotLinks(directory, revision, info) {
  if (info.nlink === 1) return true;
  if (info.nlink !== 2) return false;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(`.recipes-${revision}-`) || !name.endsWith('.tmp')) continue;
    try {
      const temporary = await lstat(path.join(directory, name));
      if (temporary.isFile() && sameFile(info, temporary)) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function readSnapshot(directory, snapshot) {
  const file = path.join(directory, snapshot.name);
  const listed = await lstat(file);
  if (!listed.isFile() || listed.size > maxSnapshotBytes) throw issue(snapshotError, 'INVALID_RECIPE_STORAGE', 422);
  if (!listed.size) return null;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(listed, opened) || !opened.nlink) return null;
    if (!opened.isFile() || opened.size > maxSnapshotBytes) throw issue(snapshotError, 'INVALID_RECIPE_STORAGE', 422);
    if (!await localSnapshotLinks(directory, snapshot.revision, opened)) {
      // A publisher can remove its temporary link between stat and our directory check.
      const { nlink } = await handle.stat();
      if (!nlink) return null;
      if (nlink !== 1) throw issue(snapshotError, 'INVALID_RECIPE_STORAGE', 422);
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes !== opened.size) throw issue(snapshotError, 'INVALID_RECIPE_STORAGE', 422);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally {
    await handle.close();
  }
}

function parseSnapshot(contents, revision, agents) {
  try {
    const state = JSON.parse(contents);
    if (state.revision !== revision || !Array.isArray(state.recipes) || state.recipes.length > WORKSPACE_SKILL_LIMITS.recipes) {
      throw new Error('Invalid recipe revision');
    }
    const ids = new Set();
    const recipes = state.recipes.map(row => {
      if (typeof row.id !== 'string' || !recipeId.test(row.id) || ids.has(row.id) || typeof row.enabled !== 'boolean') {
        throw new Error('Invalid saved recipe');
      }
      ids.add(row.id);
      return { id: row.id, ...draftFields(row, agents), enabled: row.enabled };
    });
    return { revision, recipes };
  } catch {
    throw issue(snapshotError, 'INVALID_RECIPE_STORAGE', 422);
  }
}

async function readRecipes(directory, agents) {
  if (!directory) return { revision: 0, recipes: [] };
  let retired;
  while (true) {
    const entries = await readdir(directory);
    let latest;
    for (const name of entries) {
      const revision = Number(versionedFile.exec(name)?.[1]);
      if (Number.isSafeInteger(revision) && revision > (latest?.revision ?? 0)) latest = { revision, name };
    }
    if (!latest) return { revision: 0, recipes: [] };
    const contents = await readSnapshot(directory, latest);
    if (contents !== null) return parseSnapshot(contents, latest.revision, agents);
    if (retired === latest.revision) throw issue(snapshotError, 'INVALID_RECIPE_STORAGE', 422);
    retired = latest.revision;
  }
}

async function publish(directory, state) {
  const data = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(data) > maxSnapshotBytes) {
    throw issue('Workspace recipe storage has reached its size limit.', 'WORKSPACE_RECIPE_LIMIT', 422);
  }
  const temporary = path.join(directory, `.recipes-${state.revision}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await link(temporary, path.join(directory, `recipes-${state.revision}.json`));
  } finally {
    await unlink(temporary).catch(() => {});
  }

  // Retired revision names remain reserved so stale writers cannot publish to them.
  const oldest = state.revision - retainedSnapshots;
  if (oldest < 1) return;
  const empty = path.join(directory, `.retired-${randomUUID()}.tmp`);
  try {
    await writeFile(empty, '', { flag: 'wx', mode: 0o600 });
    await rename(empty, path.join(directory, `recipes-${oldest}.json`));
  } catch {
    // Publishing succeeded. Retirement can be retried without changing this revision.
  } finally {
    await unlink(empty).catch(() => {});
  }
}

async function updateRecipes(root, agents, expectedRevision, update) {
  const directory = await recipeDirectory(root, true);
  while (true) {
    const state = await readRecipes(directory, agents);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw issue('Workspace recipes changed. Reload and try again.', 'STALE_RECIPE_REVISION', 409);
    }
    const recipes = update(state.recipes);
    if (recipes === state.recipes) return state;
    const next = { revision: state.revision + 1, recipes };
    if (!Number.isSafeInteger(next.revision)) throw issue('Workspace recipe revision limit reached.', 'WORKSPACE_RECIPE_LIMIT', 422);
    try {
      await publish(directory, next);
      return next;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

export async function listWorkspaceSkills({ project } = {}) {
  const { SELECTION_AGENTS } = await import('./skill-selection.js');
  const root = await resolveSkillProject(project);
  return readRecipes(await recipeDirectory(root, false), SELECTION_AGENTS);
}

export async function createWorkspaceSkill({ project, reuseExisting = false, ...draft } = {}) {
  const core = await import('./skill-selection.js');
  const root = await resolveSkillProject(project);
  const recipe = { id: randomUUID(), ...draftFields(draft, core.SELECTION_AGENTS), enabled: true };
  await recipeSources(core, root, recipe, recipe.agent);
  let existing;
  const state = await updateRecipes(root, core.SELECTION_AGENTS, undefined, recipes => {
    if (reuseExisting === true) {
      existing = recipes.find(candidate => candidate.agent === recipe.agent && candidate.title === recipe.title &&
        candidate.useWhen === recipe.useWhen && candidate.instructions === recipe.instructions &&
        candidate.sourcePaths.length === recipe.sourcePaths.length &&
        candidate.sourcePaths.every(source => recipe.sourcePaths.includes(source)));
      if (existing) return recipes;
    }
    if (recipes.length >= WORKSPACE_SKILL_LIMITS.recipes) {
      throw issue(`A project can save at most ${WORKSPACE_SKILL_LIMITS.recipes} recipes.`, 'WORKSPACE_RECIPE_LIMIT', 422);
    }
    return [...recipes, recipe];
  });
  return { ...state, recipe: existing ?? recipe, created: !existing };
}

function checkId(id) {
  if (typeof id !== 'string' || !recipeId.test(id)) throw issue('Choose a saved workspace recipe ID.');
}

function recipeById(recipes, id) {
  const recipe = recipes.find(item => item.id === id);
  if (!recipe) throw issue('This workspace recipe was not found in the current project.', 'UNKNOWN_WORKSPACE_RECIPE', 404);
  return recipe;
}

export async function setWorkspaceSkillEnabled({ project, id, enabled, expectedRevision } = {}) {
  checkId(id);
  if (typeof enabled !== 'boolean') throw issue('Choose whether to enable this workspace recipe.');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw issue('The expected recipe revision must be a nonnegative integer.');
  }
  const { SELECTION_AGENTS } = await import('./skill-selection.js');
  const root = await resolveSkillProject(project);
  return updateRecipes(root, SELECTION_AGENTS, expectedRevision, recipes => {
    if (recipeById(recipes, id).enabled === enabled) return recipes;
    return recipes.map(recipe => recipe.id === id ? { ...recipe, enabled } : recipe);
  });
}

export async function removeWorkspaceSkill({ project, id, expectedRevision } = {}) {
  checkId(id);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw issue('A current workspace recipe revision is required.');
  }
  const { SELECTION_AGENTS } = await import('./skill-selection.js');
  const root = await resolveSkillProject(project);
  return updateRecipes(root, SELECTION_AGENTS, expectedRevision, recipes => {
    const removed = recipeById(recipes, id);
    return recipes.filter(recipe => recipe !== removed);
  });
}

async function recipeSources(core, project, recipe, agent) {
  const state = await core.loadSkillSelectionState({ project });
  for (const source of recipe.sourcePaths) {
    if (core.getSkillEligibility(state, source, agent ?? undefined) === 'disabled') {
      throw issue(`Catalog source ${source} is disabled for this project or agent. Enable it or choose another source.`,
        'BLOCKED_WORKSPACE_RECIPE_SOURCE', 409);
    }
  }
  return Promise.all(recipe.sourcePaths.map(async source => {
    const markdown = await core.readCatalogSkill(source);
    if (!markdown || Buffer.byteLength(markdown) > maxSourceBytes) {
      throw issue(`Catalog source ${source} is unavailable or too large. Choose another source.`, 'UNKNOWN_WORKSPACE_RECIPE_SOURCE', 422);
    }
    return { path: source, markdown };
  }));
}

function sourceSections(markdown) {
  const body = markdown.replace(/\r\n/gu, '\n').trim()
    .replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/u, '').trimStart()
    .replace(/^#[ \t]+[^\n]*\n+/u, '');
  const sections = [];
  let section = [];
  let fence;
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      section.push(line);
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) fence = marker[1];
    if (/^ {0,3}#{1,6}[ \t]+\S/u.test(line) && section.length) {
      sections.push(section.join('\n').trim());
      section = [];
    }
    section.push(line);
  }
  if (section.length) sections.push(section.join('\n').trim());
  return sections.filter(Boolean);
}

export function renderWorkspaceSkill({ recipe, sources }) {
  const byPath = new Map(sources.map(source => [source.path, source.markdown]));
  if (!recipe.enabled || recipe.sourcePaths.some(source => {
    const markdown = byPath.get(source);
    return !markdown || Buffer.byteLength(markdown) > maxSourceBytes;
  })) return '';
  const blocks = [`## Workspace recipe ${recipe.title}`, `Use when ${recipe.useWhen}`];
  if (recipe.instructions) blocks.push(`### Workspace instructions\n\n${recipe.instructions}`);
  const seenSections = new Set();
  for (const source of recipe.sourcePaths) {
    blocks.push(`### Catalog source \`${source}\``);
    for (const section of sourceSections(byPath.get(source))) {
      if (seenSections.has(section)) continue;
      seenSections.add(section);
      blocks.push(section.replace(/^ {0,3}(#{1,6})(?=[ \t]+\S)/u, (_heading, level) => '#'.repeat(Math.min(level.length + 2, 6))));
    }
  }
  return blocks.join('\n\n') + '\n';
}

async function renderPreview(core, project, recipe, revision, agent, tokenBudget = core.DEFAULT_SELECTION_TOKEN_BUDGET) {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > core.MAX_SELECTION_TOKEN_BUDGET) {
    throw issue(`Enter a whole token budget from 1 to ${core.MAX_SELECTION_TOKEN_BUDGET}.`);
  }
  const sources = await recipeSources(core, project, recipe, agent);
  const markdown = renderWorkspaceSkill({ recipe, sources });
  const estimatedTokens = Math.ceil(Buffer.byteLength(markdown) / 4);
  return {
    recipe, revision, sourcePaths: sources.map(source => source.path), markdown, estimatedTokens,
    tokenBudget, fitsBudget: estimatedTokens <= tokenBudget,
  };
}

export async function previewWorkspaceSkill({ project, tokenBudget, ...draft } = {}) {
  const core = await import('./skill-selection.js');
  const root = await resolveSkillProject(project);
  const recipe = { id: null, ...draftFields(draft, core.SELECTION_AGENTS), enabled: true };
  const { revision } = await readRecipes(await recipeDirectory(root, false), core.SELECTION_AGENTS);
  return renderPreview(core, root, recipe, revision, recipe.agent, tokenBudget);
}

export async function composeWorkspaceSkill({ project, id, agent, tokenBudget } = {}) {
  checkId(id);
  const core = await import('./skill-selection.js');
  if (agent != null && !core.SELECTION_AGENTS.includes(agent)) throw issue('Choose an agent supported by Omni Skills Forge.');
  const root = await resolveSkillProject(project);
  const { revision, recipes } = await readRecipes(await recipeDirectory(root, false), core.SELECTION_AGENTS);
  const recipe = recipeById(recipes, id);
  if (!recipe.enabled || (recipe.agent && agent && recipe.agent !== agent)) {
    throw issue('This workspace recipe is disabled or belongs to another agent. Enable it or choose a recipe for this agent.',
      'BLOCKED_WORKSPACE_RECIPE', 409);
  }
  return renderPreview(core, root, recipe, revision, agent ?? recipe.agent, tokenBudget);
}
