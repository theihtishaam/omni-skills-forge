import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELECTION_AGENTS = Object.freeze([
  'codex', 'claude-code', 'cursor', 'cline', 'kilo', 'opencode', 'windsurf', 'portable',
]);
export const MAX_SELECTION_QUERY_LENGTH = 4000;
export const DEFAULT_SELECTION_TOKEN_BUDGET = 2400;
export const MAX_SELECTION_TOKEN_BUDGET = 16000;
export const DEFAULT_SELECTION_MAX_SKILLS = 3;
export const MAX_SELECTION_SKILLS = 10;

const catalogPath = fileURLToPath(new URL('../registry/master-registry.json', import.meta.url));
const skillDirectory = fileURLToPath(new URL('../skills', import.meta.url));
const preferenceDirectory = '.omni-skills-forge';
const revisionPattern = /^preferences-([1-9]\d*)\.json$/;
const retainedSnapshots = 8;
const states = ['default', 'enabled', 'disabled'];
const stopWords = new Set((
  'a about add after all also am an and are as at be been best build but by can code could create ' +
  'do does doing done existing fix for from get give good got had has have help how i if improve ' +
  'in into is it its let like make me more my need new of on one or our out please project put ' +
  'said should show some than that the their them then there these they this those through to too ' +
  'try up update us use using want was way we were what when where which who will with would write you your'
).split(' '));
const genericTopics = new Set([
  'advance', 'advanced', 'architecture', 'basics', 'beginner', 'deep', 'design', 'dive', 'entry',
  'examples', 'expert', 'fundamental', 'fundamentals', 'guide', 'intro', 'intermediate',
  'overview', 'pattern', 'patterns', 'practice', 'practices', 'skill', 'skills', 'tutorial',
]);
const generatedSuffix = /-(?:advanced|architecture|best-practices|deep-dive|deployment|design|fundamentals|hardening|implementation|integration|migration|monitoring|optimization|patterns|performance|production|scalability|security|testing|troubleshooting)$/u;
const broadFacets = new Set('deploy deployment implementation integration migration monitor optimization performance production scalability security test troubleshoot'.split(' '));
const technologyNames = ['javascript', 'typescript', 'postgresql', 'mysql', 'elasticsearch', 'mongodb', 'redis'];
const equivalentTerms = new Map([
  ['a11y', 'accessibility'], ['accessible', 'accessibility'],
  ['k8s', 'kubernetes'], ['node', 'nodejs'], ['postgres', 'postgresql'],
]);
const levelOrder = ['intermediate', 'beginner', 'advanced', 'expert'];

let catalog;

function issue(message, code = 'INVALID_SELECTION_INPUT', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validateAgent(agent) {
  if (agent !== undefined && !SELECTION_AGENTS.includes(agent)) {
    throw issue(`Unsupported agent. Choose one of: ${SELECTION_AGENTS.join(', ')}.`);
  }
}

function isSkillPath(value) {
  return typeof value === 'string' && value.endsWith('.md') &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:\0]/u.test(part));
}

async function loadCatalog() {
  catalog ??= readFile(catalogPath, 'utf8').then(JSON.parse).then(registry => {
    const skills = registry.skills.filter(skill => isSkillPath(skill.file));
    return {
      registry: { ...registry, skills },
      byPath: new Map(skills.map(skill => [skill.file, skill])),
      technologies: new Set([...technologyNames, ...(registry.categories ?? []).flatMap(category =>
        words(category.split('/').at(-1)))]),
      searchIndex: null,
    };
  });
  return catalog;
}

export async function loadSkillSelectionCatalog() {
  return (await loadCatalog()).registry;
}

export async function resolveSkillProject(project = process.cwd()) {
  if (typeof project !== 'string' || !project.trim()) throw issue('Choose a project directory.');
  let root;
  try {
    root = await realpath(path.resolve(project));
    if ((await lstat(root)).isDirectory()) return root;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  throw issue('The project path must be an existing directory.');
}

async function stateDirectory(project, create) {
  const directory = path.join(project, preferenceDirectory);
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  try {
    if ((await lstat(directory)).isDirectory()) return directory;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  throw issue('Project skill settings must be stored in an ordinary directory.');
}

function blankState() {
  return { revision: 0, overrides: {}, agentOverrides: {} };
}

function validOverrides(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, status]) =>
      isSkillPath(key) && (status === 'enabled' || status === 'disabled'));
}

async function readState(directory) {
  if (!directory) return blankState();
  let retiredRevision;
  while (true) {
    let latest;
    for (const file of await readdir(directory)) {
      const match = revisionPattern.exec(file);
      if (!match) continue;
      const revision = Number(match[1]);
      if (Number.isSafeInteger(revision) && revision > (latest?.revision ?? 0)) {
        latest = { file, revision };
      }
    }
    if (!latest) return blankState();

    const file = path.join(directory, latest.file);
    if (!(await lstat(file)).isFile()) throw issue('Project skill settings must be an ordinary file.');
    const contents = await readFile(file, 'utf8');
    if (!contents && retiredRevision !== latest.revision) {
      retiredRevision = latest.revision;
      continue; // A newer revision may have committed and retired this snapshot.
    }
    if (!contents) throw issue('The latest project skill settings are empty.');
    const state = JSON.parse(contents);
    if (state?.revision !== latest.revision || !validOverrides(state.overrides) ||
        !state.agentOverrides || typeof state.agentOverrides !== 'object' ||
        Array.isArray(state.agentOverrides) ||
        !Object.entries(state.agentOverrides).every(([agent, scopes]) =>
          SELECTION_AGENTS.includes(agent) && validOverrides(scopes))) {
      throw issue('Project skill settings contain an invalid preference revision.');
    }
    return state;
  }
}

export async function loadSkillSelectionState({ project } = {}) {
  return readState(await stateDirectory(await resolveSkillProject(project), false));
}

export function getSkillEligibility(state, skillPath, agent) {
  const projectStatus = state.overrides[skillPath];
  const agentStatus = agent && state.agentOverrides[agent]?.[skillPath];
  if (projectStatus === 'disabled' || agentStatus === 'disabled') return 'disabled';
  if (projectStatus === 'enabled' || agentStatus === 'enabled') return 'enabled';
  return 'default';
}

// A complete snapshot is linked into place once. Competing writers can never replace
// the same revision. A process interrupted before publishing leaves only a temporary file.
async function writeExclusive(file, data) {
  const temporary = path.join(path.dirname(file), `.osf-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await link(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function retireSnapshot(directory, revision) {
  if (revision < 1) return;
  const temporary = path.join(directory, `.osf-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    // Keep the old pathname occupied so a delayed writer cannot reuse its revision.
    await rename(temporary, path.join(directory, `preferences-${revision}.json`));
  } catch {
    // The current revision is already committed. Retaining an older snapshot is safe.
    await unlink(temporary).catch(() => {});
  }
}

export async function setSkillSelectionState({ project, agent, path: skillPath, status, expectedRevision } = {}) {
  validateAgent(agent);
  if (!states.includes(status)) throw issue('Choose enabled, disabled, or default.');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw issue('The expected revision must be a nonnegative integer.');
  }
  if (!isSkillPath(skillPath) || !(await loadCatalog()).byPath.has(skillPath)) {
    throw issue('Use the exact relative path of a catalog skill.', 'UNKNOWN_SKILL', 404);
  }
  const root = await resolveSkillProject(project);
  let directory = await stateDirectory(root, false);
  while (true) {
    const state = await readState(directory);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw issue('Project skill settings changed. Reload and try again.', 'STALE_REVISION', 409);
    }
    const overrides = agent ? (state.agentOverrides[agent] ?? {}) : state.overrides;
    const previous = overrides[skillPath] ?? 'default';
    if (status === previous) return state;

    if (status === 'default') delete overrides[skillPath];
    else overrides[skillPath] = status;
    if (agent && Object.keys(overrides).length) state.agentOverrides[agent] = overrides;
    else if (agent) delete state.agentOverrides[agent];
    state.revision += 1;

    try {
      directory ??= await stateDirectory(root, true);
      await writeExclusive(path.join(directory, `preferences-${state.revision}.json`), JSON.stringify(state, null, 2) + '\n');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      continue;
    }
    await retireSnapshot(directory, state.revision - retainedSnapshots);
    return state;
  }
}

function parseLimit(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw issue(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function words(value) {
  const normalized = value.toLowerCase().normalize('NFKC').replace(/\bnode\.js\b/gu, 'nodejs');
  return (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => {
    if (equivalentTerms.has(word)) return equivalentTerms.get(word);
    if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith('s') && !/[su]s$/u.test(word)) return word.slice(0, -1);
    return word;
  });
}

function searchIndex(source) {
  source.searchIndex ??= source.registry.skills.map(skill => {
    const title = words(skill.name);
    const base = skill.name.replace(generatedSuffix, '');
    const description = words(skill.description || '');
    const category = words(skill.category || '');
    const tagged = words((Array.isArray(skill.tags) ? skill.tags : []).join(' '));
    return {
      skill,
      family: `${skill.category}/${base}`,
      base: new Set(words(base)),
      category: new Set(category),
      title: new Set(title),
      tagged: new Set(tagged),
      description: new Set(description),
      titlePhrase: ` ${title.join(' ')} `,
    };
  });
  return source.searchIndex;
}

function scoreSkill(record, terms, technologies, agent, state) {
  const eligibility = getSkillEligibility(state, record.skill.file, agent);
  if (eligibility === 'disabled') return null;
  if (technologies.some(term => !record.title.has(term) && !record.tagged.has(term) &&
      !record.category.has(term) && !record.description.has(term))) return null;

  const matched = [];
  let score = 0;
  let topicMatches = 0;
  let specificMatches = 0;
  for (const term of terms) {
    const categoryMatch = record.category.has(term);
    const titleMatch = record.title.has(term);
    const tagMatch = record.tagged.has(term);
    if (titleMatch || tagMatch || categoryMatch) {
      matched.push(term);
      if (!categoryMatch && (titleMatch || tagMatch) && !technologies.includes(term)) {
        if (!broadFacets.has(term)) specificMatches += 1;
        if (!broadFacets.has(term) || record.base.has(term)) topicMatches += 1;
      }
      score += titleMatch ? (categoryMatch ? 2 : 6) : (tagMatch ? 4 : 1);
    } else if (record.description.has(term)) {
      matched.push(term);
      score += 1;
    }
  }
  const integratedTopic = technologies.length > 1 && terms.length === technologies.length &&
    technologies.every(term => record.title.has(term) || record.tagged.has(term));
  const required = terms.length === 1 ? 1 : Math.max(2, technologies.length + Number(!integratedTopic));
  if ((!topicMatches && !integratedTopic) || matched.length < required) return null;
  for (let index = 1; index < terms.length; index += 1) {
    if (record.titlePhrase.includes(` ${terms[index - 1]} ${terms[index]} `)) score += 4;
  }
  if (eligibility === 'enabled') score += 1;
  return { ...record, score, matched, specificMatches };
}

function scoreOrder(first, second) {
  return second.score - first.score ||
    levelOrder.indexOf(first.skill.difficulty) - levelOrder.indexOf(second.skill.difficulty) ||
    Number(first.skill.file > second.skill.file) - Number(first.skill.file < second.skill.file);
}

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readSkill(skillPath) {
  const root = await realpath(skillDirectory);
  const file = path.join(root, skillPath);
  try {
    const resolved = await realpath(file);
    if (resolved !== file || !inside(root, resolved) || !(await lstat(file)).isFile()) return null;
    return (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function estimateTokens(markdown) {
  return Math.ceil(Buffer.byteLength(markdown, 'utf8') / 4);
}

export async function selectSkills({ project, agent, query, tokenBudget, maxSkills } = {}) {
  validateAgent(agent);
  if (typeof query !== 'string' || query.length > MAX_SELECTION_QUERY_LENGTH) {
    throw issue(`The task must be text of up to ${MAX_SELECTION_QUERY_LENGTH} characters.`);
  }
  tokenBudget = parseLimit(tokenBudget, DEFAULT_SELECTION_TOKEN_BUDGET, MAX_SELECTION_TOKEN_BUDGET, 'Token budget');
  maxSkills = parseLimit(maxSkills, DEFAULT_SELECTION_MAX_SKILLS, MAX_SELECTION_SKILLS, 'Maximum skills');
  const state = await loadSkillSelectionState({ project });
  const result = { query, agent: agent ?? null, revision: state.revision, matches: [], estimatedTokens: 0, tokenBudget, maxSkills, markdown: '' };
  const terms = [...new Set(words(query).filter(word => !stopWords.has(word) && !genericTopics.has(word) && word.length > 1))];
  if (!terms.length) return result;
  let markdown = '# Omni Skills Forge task context\n\nSelected catalog skills. Token counts are estimates.\n';
  if (estimateTokens(markdown) >= tokenBudget) return result;

  const source = await loadCatalog();
  const technologies = terms.filter(term => source.technologies.has(term));
  const ranked = searchIndex(source)
    .map(record => scoreSkill(record, terms, technologies, agent, state))
    .filter(Boolean)
    .sort(scoreOrder);
  const hasSpecific = ranked.some(record => record.specificMatches);
  const families = new Set();
  let inspected = 0;
  for (const { family, matched, skill, specificMatches } of ranked) {
    if (families.has(family) || (hasSpecific && !specificMatches)) continue;
    if (++inspected > 8 * maxSkills) break;
    const content = await readSkill(skill.file);
    if (!content) continue;
    const reason = `Task terms matched: ${matched.join(', ')}.`;
    const chunk = `\n## ${skill.name}\n\nSource: \`${skill.file}\`\n\n${reason}\n\n${content}\n`;
    const next = markdown + chunk;
    if (estimateTokens(next) > tokenBudget) continue;

    markdown = next;
    families.add(family);
    result.matches.push({
      path: skill.file, name: skill.name, category: skill.category, difficulty: skill.difficulty,
      description: skill.description, reason, estimatedTokens: estimateTokens(chunk),
    });
    if (result.matches.length === maxSkills) break;
  }
  if (result.matches.length) {
    result.markdown = markdown;
    result.estimatedTokens = estimateTokens(markdown);
  }
  return result;
}

export async function exportSkillContext(options = {}) {
  const { output } = options;
  if (typeof output !== 'string' || path.extname(output).toLowerCase() !== '.md') {
    throw issue('Choose a Markdown output file inside the project.');
  }
  const root = await resolveSkillProject(options.project);
  const requested = path.resolve(root, output);
  if (!inside(root, requested)) throw issue('The context output must stay inside the project.');
  const parent = await realpath(path.dirname(requested));
  if (!inside(root, parent)) throw issue('The context output must stay inside the project.');
  const destination = path.join(parent, path.basename(requested));

  const result = await selectSkills({ ...options, project: root });
  if (!result.matches.length) return { ...result, output: null };
  try {
    await writeExclusive(destination, result.markdown);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw issue('The context output file already exists.', 'OUTPUT_EXISTS', 409);
    }
    throw error;
  }
  return { ...result, output: destination };
}
