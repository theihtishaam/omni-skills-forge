import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectWorkspaceProfile, resolveSkillProject } from './workspace-profile.js';

export { detectWorkspaceProfile, resolveSkillProject } from './workspace-profile.js';

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
  'review said should show some than that the their them then there these they this those through to too ' +
  'try up update us use using want was way we were what when where which who will with would write you your'
).split(' '));
const genericTopics = new Set([
  'advance', 'advanced', 'architecture', 'basics', 'beginner', 'deep', 'design', 'dive', 'entry',
  'example', 'expert', 'fundamental', 'fundamentals', 'guide', 'intro', 'intermediate',
  'overview', 'pattern', 'patterns', 'practice', 'practices', 'skill', 'skills', 'tutorial',
]);
const generatedSuffix = /-(?:advanced|architecture|best-practices|deep-dive|deployment|design|fundamentals|hardening|implementation|integration|migration|monitoring|optimization|patterns|performance|production|scalability|security|testing|troubleshooting)$/u;
const broadFacets = new Set('deploy deployment implementation integration migration monitor optimization performance production scalability security test troubleshoot'.split(' '));
const technologyNames = ['javascript', 'typescript', 'postgresql', 'mysql', 'elasticsearch', 'mongodb', 'redis'];
const equivalentTerms = new Map([
  ['a11y', 'accessibility'], ['accessible', 'accessibility'],
  ['k8s', 'kubernetes'], ['node', 'nodejs'], ['postgres', 'postgresql'],
]);
const workspaceThemes = new Map([
  ['React', ['web-dev/react', 'react-accessibility-a11y', 'react-custom-hooks', 'react-form-handling']],
  ['Next.js', ['web-dev/nextjs', 'nextjs-server-components', 'nextjs-data-fetching']],
  ['Vue', ['web-dev/vue', 'vue-component-patterns', 'vue-form-validation']],
  ['Svelte', ['web-dev/svelte', 'svelte-component-lifecycle', 'svelte-form-actions']],
  ['Angular', ['web-dev/angular', 'angular-standalone-components', 'angular-form-handling']],
  ['Astro', ['web-dev/astro', 'astro-components', 'astro-testing']],
  ['Remix', ['web-dev/remix', 'remix-form-handling', 'remix-resource-routes']],
  ['TypeScript', ['web-dev/react', 'react-typescript-patterns']],
  ['Node.js', ['backend/nodejs', 'nodejs-testing-jest', 'nodejs-streams-pipeline']],
  ['Python', ['backend/python', 'python-testing-pytest', 'python-data-validation', 'python-async-await']],
  ['Go', ['backend/go', 'go-context-patterns', 'go-goroutines-channels']],
  ['Rust', ['backend/rust', 'rust-ownership-patterns', 'rust-async-tokio']],
  ['C#', ['backend/csharp', 'csharp-testing-xunit', 'csharp-linq-mastery']],
  ['Docker', ['devops/docker', 'docker-multi-stage-builds']],
  ['Kubernetes', ['devops/kubernetes', 'kubernetes-config-management', 'kubernetes-deployment-strategies']],
  ['Terraform', ['devops/terraform', 'terraform-module-design', 'terraform-documentation-tf']],
]);
const weakWorkspaceTerms = new Set([
  'api', 'application', 'component', 'content', 'data', 'input', 'interface', 'output',
  'request', 'response', 'service', 'state', 'status', 'style', 'system', 'tool', 'version', 'work',
]);
const broadTechnologyTerms = new Set(['agent', 'computer', 'monitor', 'vision']);
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

function categoryFamily(category) {
  return category.split('/', 1)[0];
}

function isCategoryKey(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u.test(value);
}

async function loadCatalog() {
  catalog ??= readFile(catalogPath, 'utf8').then(JSON.parse).then(registry => {
    const skills = registry.skills.filter(skill => isSkillPath(skill.file));
    const categories = registry.categories ?? [];
    const families = [...new Set(categories.map(categoryFamily))].sort();
    return {
      registry: { ...registry, skills, families },
      byPath: new Map(skills.map(skill => [skill.file, skill])),
      categoryKeys: new Set([...categories, ...families]),
      technologies: new Set([...technologyNames, ...categories.flatMap(category =>
        words(category.split('/').at(-1)))]),
      searchIndex: null,
    };
  });
  return catalog;
}

export async function loadSkillSelectionCatalog() {
  return (await loadCatalog()).registry;
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
  return { revision: 0, overrides: {}, agentOverrides: {}, categoryOverrides: {}, agentCategoryOverrides: {} };
}

function validOverrides(value, validKey) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, status]) =>
      validKey(key) && (status === 'enabled' || status === 'disabled'));
}

function validAgentOverrides(value, validKey) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([agent, overrides]) =>
      SELECTION_AGENTS.includes(agent) && validOverrides(overrides, validKey));
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
    if (state?.revision !== latest.revision) {
      throw issue('Project skill settings contain an invalid preference revision.');
    }
    const { categoryOverrides = {}, agentCategoryOverrides = {} } = state;
    if (!validOverrides(state.overrides, isSkillPath) ||
        !validAgentOverrides(state.agentOverrides, isSkillPath) ||
        !validOverrides(categoryOverrides, isCategoryKey) ||
        !validAgentOverrides(agentCategoryOverrides, isCategoryKey)) {
      throw issue('Project skill settings contain an invalid preference revision.');
    }
    return { ...state, categoryOverrides, agentCategoryOverrides };
  }
}

export async function loadSkillSelectionState({ project } = {}) {
  return readState(await stateDirectory(await resolveSkillProject(project), false));
}

const defaultEligibility = Object.freeze({ status: 'default', scope: null, type: null });

function categoryWithStatus(overrides, category, family, status) {
  if (overrides?.[category] === status) return category;
  if (family !== category && overrides?.[family] === status) return family;
  return null;
}

function describeEligibility(state, category, skillPath, agent) {
  const family = categoryFamily(category);
  const agentCategories = agent && state.agentCategoryOverrides?.[agent];
  const projectCategories = state.categoryOverrides;
  const agentSkill = skillPath && agent && state.agentOverrides?.[agent]?.[skillPath];
  const projectSkill = skillPath && state.overrides?.[skillPath];

  const projectBlock = categoryWithStatus(projectCategories, category, family, 'disabled');
  if (projectBlock) return { status: 'disabled', scope: 'project', type: 'category', category: projectBlock };
  if (projectSkill === 'disabled') return { status: 'disabled', scope: 'project', type: 'skill' };
  const agentBlock = categoryWithStatus(agentCategories, category, family, 'disabled');
  if (agentBlock) return { status: 'disabled', scope: 'agent', type: 'category', category: agentBlock };
  if (agentSkill === 'disabled') return { status: 'disabled', scope: 'agent', type: 'skill' };

  if (agentSkill === 'enabled') return { status: 'enabled', scope: 'agent', type: 'skill' };
  if (projectSkill === 'enabled') return { status: 'enabled', scope: 'project', type: 'skill' };
  const agentAllow = categoryWithStatus(agentCategories, category, family, 'enabled');
  if (agentAllow) return { status: 'enabled', scope: 'agent', type: 'category', category: agentAllow };
  const projectAllow = categoryWithStatus(projectCategories, category, family, 'enabled');
  if (projectAllow) return { status: 'enabled', scope: 'project', type: 'category', category: projectAllow };
  return defaultEligibility;
}

export function describeSkillEligibility(state, skillPath, agent) {
  const slash = skillPath.lastIndexOf('/');
  const category = slash === -1 ? '' : skillPath.slice(0, slash);
  return describeEligibility(state, category, skillPath, agent);
}

export function describeCategoryEligibility(state, category, agent) {
  return describeEligibility(state, category, undefined, agent);
}

export function getSkillEligibility(state, skillPath, agent) {
  return describeSkillEligibility(state, skillPath, agent).status;
}

export function getCategoryEligibility(state, category, agent) {
  return describeCategoryEligibility(state, category, agent).status;
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

export async function setSkillSelectionState({ path: skillPath, ...options } = {}) {
  return setPreference({ ...options, key: skillPath }, false);
}

export async function setSkillCategoryState({ category, ...options } = {}) {
  return setPreference({ ...options, key: category }, true);
}

async function setPreference({ project, agent, key, status, expectedRevision }, isCategory) {
  validateAgent(agent);
  if (!states.includes(status)) throw issue('Choose enabled, disabled, or default.');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw issue('The expected revision must be a nonnegative integer.');
  }
  if (isCategory && (!isCategoryKey(key) || !(await loadCatalog()).categoryKeys.has(key))) {
    throw issue('Use an exact catalog category path or family.', 'UNKNOWN_CATEGORY', 404);
  }
  if (!isCategory && (!isSkillPath(key) || !(await loadCatalog()).byPath.has(key))) {
    throw issue('Use the exact relative path of a catalog skill.', 'UNKNOWN_SKILL', 404);
  }
  const projectKey = isCategory ? 'categoryOverrides' : 'overrides';
  const agentKey = isCategory ? 'agentCategoryOverrides' : 'agentOverrides';
  const root = await resolveSkillProject(project);
  let directory = await stateDirectory(root, false);
  while (true) {
    const state = await readState(directory);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw issue('Project skill settings changed. Reload and try again.', 'STALE_REVISION', 409);
    }
    const overrides = agent ? (state[agentKey][agent] ?? {}) : state[projectKey];
    const previous = overrides[key] ?? 'default';
    if (status === previous) return state;

    if (status === 'default') delete overrides[key];
    else overrides[key] = status;
    if (agent && Object.keys(overrides).length) state[agentKey][agent] = overrides;
    else if (agent) delete state[agentKey][agent];
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
  const normalized = value.toLowerCase().normalize('NFKC')
    .replace(/\b(node|next)\.js\b/gu, '$1js')
    .replace(/\bvue\.js\b/gu, 'vue')
    .replace(/\bc#(?![\p{L}\p{N}])/gu, 'csharp')
    .replace(/\b(?:golang|go\.mod)\b/gu, 'go');
  return (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => {
    if (equivalentTerms.has(word)) return equivalentTerms.get(word);
    if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith('s') && !/[su]s$/u.test(word)) return word.slice(0, -1);
    return word;
  });
}

function explicitTechnologies(terms, query, known) {
  const namesGo = /\b(?:golang|go\.mod|go\s+(?:channel|code|concurrenc|context|goroutine|module|package|program)|(?:in|using|with)\s+go\b)/iu.test(query);
  return terms.filter(term => known.has(term) && !broadTechnologyTerms.has(term) && (term !== 'go' || namesGo));
}

function taskTerms(value) {
  return [...new Set(words(value).filter(word => !stopWords.has(word) && !genericTopics.has(word) && word.length > 1))];
}

export function catalogSkillTopic(name) {
  return name.replace(generatedSuffix, '');
}

function skillFamily(skill) {
  return `${skill.category}/${catalogSkillTopic(skill.name)}`;
}

function searchIndex(source) {
  source.searchIndex ??= source.registry.skills.map(skill => {
    const title = words(skill.name);
    const base = catalogSkillTopic(skill.name);
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

function scoreSkill(record, terms, technologies, workspaceEvidence, agent, state) {
  const eligibility = describeEligibility(state, record.skill.category, record.skill.file, agent);
  if (eligibility.status === 'disabled') return null;
  if (technologies.some(term => !record.title.has(term) && !record.tagged.has(term) &&
      !record.category.has(term) && !record.description.has(term))) return null;

  const matched = [];
  let score = 0;
  let topicMatches = 0;
  let specificMatches = 0;
  let specificWorkspaceTerm = false;
  for (const [index, term] of terms.entries()) {
    const categoryMatch = record.category.has(term);
    const titleMatch = record.title.has(term);
    const tagMatch = record.tagged.has(term);
    if (titleMatch || tagMatch || categoryMatch) {
      matched.push(term);
      if (!categoryMatch && (titleMatch || tagMatch) && !technologies.includes(term)) {
        if (!broadFacets.has(term)) specificMatches += 1;
        if (!broadFacets.has(term) || record.base.has(term)) topicMatches += 1;
        if (!broadFacets.has(term) && !weakWorkspaceTerms.has(term)) specificWorkspaceTerm = true;
      }
      score += titleMatch ? (categoryMatch ? 2 : 6 + 0.5 / (index + 1)) : (tagMatch ? 4 : 1);
    } else if (record.description.has(term)) {
      matched.push(term);
      score += 1;
    }
  }
  const integratedTopic = technologies.length > 1 && terms.length === technologies.length &&
    technologies.every(term => record.title.has(term) || record.tagged.has(term));
  const required = terms.length === 1 ? 1 : Math.max(2, technologies.length + Number(!integratedTopic));
  const workspaceMatch = workspaceEvidence && specificWorkspaceTerm ? workspaceEvidence : null;
  if ((!topicMatches && !integratedTopic) || (matched.length < required && !workspaceMatch)) return null;
  for (let index = 1; index < terms.length; index += 1) {
    if (record.titlePhrase.includes(` ${terms[index - 1]} ${terms[index]} `)) score += 4;
  }
  if (eligibility.status === 'enabled' && eligibility.type === 'skill') score += 1;
  if (workspaceMatch) score += 2;
  return { ...record, score, matched, specificMatches, workspaceMatch };
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
    return (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').trim();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

export async function readCatalogSkill(skillPath) {
  if (!isSkillPath(skillPath) || !(await loadCatalog()).byPath.has(skillPath)) return null;
  return readSkill(skillPath);
}

function estimateTokens(markdown) {
  return Math.ceil(Buffer.byteLength(markdown, 'utf8') / 4);
}

async function selectionScope(project, directory) {
  const root = await resolveSkillProject(project);
  const [state, workspace] = await Promise.all([
    readState(await stateDirectory(root, false)),
    detectWorkspaceProfile({ project: root, directory }),
  ]);
  return { projectRoot: root, state, workspace };
}

function evidenceLabel(evidence) {
  return `${evidence.name} in ${evidence.sources.map(source => source.file).join(', ')}`;
}

function workspaceCue(record, workspace) {
  return workspace.technologies.find(evidence => {
    const [category, ...families] = workspaceThemes.get(evidence.name) ?? [];
    if (evidence.name === 'TypeScript') {
      return workspace.technologies.some(item => item.name === 'React') &&
        families.some(family => record.family === `${category}/${family}`);
    }
    return record.skill.category === category;
  });
}

function matchWorkspaceSkill(recipe, scope, terms, technologies, source) {
  if (!recipe.enabled || (recipe.agent && recipe.agent !== scope.agent)) return null;
  const catalogSources = recipe.sourcePaths.map(skillPath => source.byPath.get(skillPath));
  if (catalogSources.some(skill => !skill ||
      getSkillEligibility(scope.state, skill.file, scope.agent) === 'disabled')) return null;

  const titleTerms = new Set(taskTerms(recipe.title));
  const useTerms = new Set(taskTerms(recipe.useWhen));
  const matched = terms.filter(term => titleTerms.has(term) || useTerms.has(term));
  const useHits = matched.filter(term => useTerms.has(term));
  const technologyEvidence = new Set([...titleTerms, ...useTerms, ...catalogSources.flatMap(skill =>
    words(`${skill.category} ${skill.name} ${skill.tags?.join(' ') ?? ''}`))]);
  if (matched.length < 2 || !useHits.length ||
      !matched.some(term => !technologies.includes(term) && !weakWorkspaceTerms.has(term) && !broadFacets.has(term)) ||
      technologies.some(term => !technologyEvidence.has(term))) {
    return null;
  }
  const score = matched.length * 4 + useHits.length + Number(Boolean(recipe.agent));
  return { recipe, catalogSources, matched, score };
}

async function selectWorkspaceSkill(scope, terms, technologies, source, header, tokenBudget) {
  if (terms.length < 2) return null;
  const { listWorkspaceSkills, renderWorkspaceSkill } = await import('./workspace-skills.js');
  const { recipes } = await listWorkspaceSkills({ project: scope.projectRoot });
  const ranked = recipes
    .map(recipe => matchWorkspaceSkill(recipe, scope, terms, technologies, source))
    .filter(Boolean)
    .sort((first, second) => second.score - first.score ||
      Number(first.recipe.id > second.recipe.id) - Number(first.recipe.id < second.recipe.id));

  for (const { recipe, catalogSources, matched } of ranked.slice(0, 3)) {
    const sources = await Promise.all(catalogSources.map(async skill =>
      ({ path: skill.file, markdown: await readSkill(skill.file) })));
    if (sources.some(item => !item.markdown)) continue;
    const rendered = renderWorkspaceSkill({ recipe, sources });
    if (!rendered) continue;
    const reason = `Matches the task terms ${matched.join(', ')} in this workspace skill's title or usage notes.`;
    const markdown = `\n${reason}\n\n${rendered.trim()}\n`;
    if (estimateTokens(header + markdown) > tokenBudget) continue;

    return {
      markdown,
      families: catalogSources.map(skillFamily),
      match: {
        kind: 'workspace', recipeId: recipe.id, path: `workspace/${recipe.id}.md`, name: recipe.title,
        category: 'workspace', difficulty: null, description: recipe.useWhen,
        sourcePaths: recipe.sourcePaths, reason, estimatedTokens: estimateTokens(markdown),
      },
    };
  }
  return null;
}

export async function selectSkills({ project, directory, agent, query, tokenBudget, maxSkills, catalogOnly = false } = {}) {
  validateAgent(agent);
  if (typeof query !== 'string' || query.length > MAX_SELECTION_QUERY_LENGTH) {
    throw issue(`The task must be text of up to ${MAX_SELECTION_QUERY_LENGTH} characters.`);
  }
  tokenBudget = parseLimit(tokenBudget, DEFAULT_SELECTION_TOKEN_BUDGET, MAX_SELECTION_TOKEN_BUDGET, 'Token budget');
  maxSkills = parseLimit(maxSkills, DEFAULT_SELECTION_MAX_SKILLS, MAX_SELECTION_SKILLS, 'Maximum skills');
  const { projectRoot, state, workspace } = await selectionScope(project, directory);
  const result = {
    query, agent: agent ?? null, revision: state.revision, workspace,
    matches: [], estimatedTokens: 0, tokenBudget, maxSkills, markdown: '',
  };
  const terms = taskTerms(query);
  if (!terms.length) return result;
  let markdown = '# Omni Skills Forge task context\n\nSelected catalog skills. Token counts are estimates.\n';
  if (estimateTokens(markdown) >= tokenBudget) return result;

  const source = await loadCatalog();
  const technologies = explicitTechnologies(terms, query, source.technologies);
  const families = new Set();
  const selectedWorkspaceSkill = catalogOnly ? null : await selectWorkspaceSkill({ projectRoot, state, agent },
    terms, technologies, source, markdown, tokenBudget);
  if (selectedWorkspaceSkill) {
    result.matches.push(selectedWorkspaceSkill.match);
    markdown += selectedWorkspaceSkill.markdown;
    for (const family of selectedWorkspaceSkill.families) families.add(family);
  }
  const ranked = result.matches.length < maxSkills
    ? searchIndex(source)
      .map(record => scoreSkill(record, terms, technologies,
        technologies.length ? null : workspaceCue(record, workspace), agent, state))
      .filter(Boolean)
      .sort(scoreOrder)
    : [];
  const hasSpecific = ranked.some(record => record.specificMatches);
  let inspected = 0;
  for (const { family, matched, skill, specificMatches, workspaceMatch } of ranked) {
    if (result.matches.length === maxSkills) break;
    if (families.has(family) || (hasSpecific && !specificMatches)) continue;
    if (++inspected > 8 * maxSkills) break;
    const content = await readSkill(skill.file);
    if (!content) continue;
    const reason = `Matches the task terms ${matched.join(', ')}.` +
      (workspaceMatch ? ` Workspace signals include ${evidenceLabel(workspaceMatch)}.` : '');
    const chunk = `\n## ${skill.name}\n\nCatalog file \`${skill.file}\`\n\n${reason}\n\n${content}\n`;
    const next = markdown + chunk;
    if (estimateTokens(next) > tokenBudget) continue;

    markdown = next;
    families.add(family);
    result.matches.push({
      path: skill.file, name: skill.name, category: skill.category, difficulty: skill.difficulty,
      description: skill.description, reason, estimatedTokens: estimateTokens(chunk),
    });
  }
  if (result.matches.length) {
    result.markdown = markdown;
    result.estimatedTokens = estimateTokens(markdown);
  }
  return result;
}

export async function recommendWorkspaceSkills({ project, directory, agent, maxSkills } = {}) {
  validateAgent(agent);
  const limit = parseLimit(maxSkills, DEFAULT_SELECTION_MAX_SKILLS, MAX_SELECTION_SKILLS, 'Maximum skills');
  const { state, workspace } = await selectionScope(project, directory);
  const result = { revision: state.revision, agent: agent ?? null, workspace, suggestions: [] };
  if (!workspace.technologies.length) return result;

  const selections = new Map();
  for (const evidence of workspace.technologies) {
    if (evidence.name === 'TypeScript' && !workspace.technologies.some(item => item.name === 'React')) continue;
    const [category, ...themes] = workspaceThemes.get(evidence.name) ?? [];
    selections.set(evidence, themes.map(theme => `${category}/${theme}`));
  }
  if (!selections.size) return result;
  const available = new Map();
  const families = new Set([...selections.values()].flat());
  for (const record of searchIndex(await loadCatalog())) {
    if (!families.has(record.family)) continue;
    const { skill } = record;
    const eligibility = describeEligibility(state, skill.category, skill.file, agent);
    if (eligibility.status === 'disabled') continue;
    const score = eligibility.status === 'enabled' && eligibility.type === 'skill' ? 1 : 0;
    const candidate = { skill, score };
    const previous = available.get(record.family);
    if (!previous || scoreOrder(candidate, previous) < 0) available.set(record.family, candidate);
  }

  for (let index = 0; index < Math.max(...Array.from(selections.values(), themes => themes.length)); index += 1) {
    for (const [evidence, themes] of selections) {
      const candidate = available.get(themes[index]);
      if (!candidate) continue;
      const { skill } = candidate;
      result.suggestions.push({
        path: skill.file, name: skill.name, category: skill.category, difficulty: skill.difficulty,
        description: skill.description, reason: `Suggested because Omni found ${evidenceLabel(evidence)}.`,
      });
      available.delete(themes[index]);
      if (result.suggestions.length === limit) return result;
    }
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
