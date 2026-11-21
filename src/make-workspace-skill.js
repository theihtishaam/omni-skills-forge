import { catalogSkillTopic, loadSkillSelectionCatalog, SELECTION_AGENTS, selectSkills } from './skill-selection.js';
import {
  composeWorkspaceSkill, createWorkspaceSkill, previewWorkspaceSkill, WORKSPACE_SKILL_LIMITS,
} from './workspace-skills.js';
import { resolveWorkspaceDirectory } from './workspace-profile.js';

export const MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH = WORKSPACE_SKILL_LIMITS.instructions;

const properNames = new Map([
  ['api', 'API'], ['aws', 'AWS'], ['csharp', 'C#'], ['cicd', 'CI/CD'], ['css', 'CSS'],
  ['html', 'HTML'], ['javascript', 'JavaScript'], ['json', 'JSON'], ['nextjs', 'Next.js'],
  ['nodejs', 'Node.js'], ['postgresql', 'PostgreSQL'], ['sql', 'SQL'], ['typescript', 'TypeScript'],
]);
const creationRequest = /^(?:(?:please|can you|could you|would you|i want you to)\s+)?(?:(?:tell|ask)\s+(?:(?:the|my)\s+)?agent\s+to\s+)?(?:make|create|build|save|combine|merge)\s+(?:(?:me|us|a|an|one|new|reusable|custom|local|workspace|combined)\s+){0,8}skills?\b/iu;
const catalogReference = /^\s*from\s+(?:the\s+)?(?:catalog|50[ ,]?009(?:\s+skills)?|50k(?:\s+(?:catalog\s+)?skills)?|(?:these|selected)\s+(?:catalog\s+)?(?:skills|sources))\b/iu;

function issue(message, code = 'INVALID_MAKE_WORKSPACE_SKILL', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function cleanInstruction(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    throw issue(`Describe the skill in up to ${MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH} characters.`);
  }
  const instruction = value.replace(/\r\n?/gu, '\n').trim();
  if (!creationRequest.test(instruction)) return instruction;
  return instruction.replace(creationRequest, '').replace(catalogReference, '').trim()
    .replace(/^[,.:\s]*\b(?:for|about|with|to|and)\b\s*/iu, '')
    .replace(/^[,.:\s]+/u, '').trim();
}

function humanize(value) {
  return value.split('-').filter(Boolean).map(word => properNames.get(word) ||
    (word[0].toUpperCase() + word.slice(1))).join(' ');
}

function readableTopic(name) {
  const topic = catalogSkillTopic(name);
  return humanize(topic.includes('accessibility-a11y') ? topic.replace('accessibility-a11y', 'accessibility') : topic);
}

function bounded(text, limit) {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit - 1);
  return (slice.replace(/\s+\S*$/u, '') || slice) + '…';
}

function joinTopics(topics) {
  if (topics.length <= 2) return topics.join(' and ');
  return topics.slice(0, -1).join(', ') + ', and ' + topics.at(-1);
}

function describeDraft(sources, task) {
  const orderedSources = [...sources].sort((first, second) =>
    Number(first.path > second.path) - Number(first.path < second.path));
  const topics = [...new Set(orderedSources.map(source => readableTopic(source.name)))];
  const technology = humanize(orderedSources[0].category.split('/').at(-1));
  const sharedTechnology = topics.length > 1 && topics.every(topic => topic.startsWith(technology + ' '));
  const titleTopics = sharedTechnology ? topics.map(topic => topic.slice(technology.length + 1)) : topics;
  const combined = (sharedTechnology ? technology + ' ' : '') + joinTopics(titleTopics);
  const firstTask = task.split(/(?:[.!?](?:\s|$)|[;\n])/u, 1)[0].replace(/\s+/gu, ' ').trim();
  const example = firstTask ? ` An example task is “${bounded(firstTask, 180)}”.` : '';
  return {
    title: bounded(combined, WORKSPACE_SKILL_LIMITS.title),
    useWhen: bounded(`the task involves ${combined}.${example}`, WORKSPACE_SKILL_LIMITS.useWhen),
  };
}

function noMatch(reason) {
  return { recipe: null, sources: [], markdown: '', created: false, reason };
}

export async function makeWorkspaceSkill({
  project, directory, agent, instruction, sourcePaths, scope = 'agent',
} = {}) {
  if (scope !== 'agent' && scope !== 'project') throw issue('Choose agent or project scope.');
  if ((agent != null && !SELECTION_AGENTS.includes(agent)) || (scope === 'agent' && !agent)) {
    throw issue('Choose the current agent or select shared project scope.');
  }
  const currentAgent = agent ?? undefined;
  if (sourcePaths !== undefined && (!Array.isArray(sourcePaths) || sourcePaths.length > WORKSPACE_SKILL_LIMITS.sources ||
      !sourcePaths.every(source => typeof source === 'string') || new Set(sourcePaths).size !== sourcePaths.length)) {
    throw issue(`Choose up to ${WORKSPACE_SKILL_LIMITS.sources} distinct catalog skill paths.`);
  }

  const task = cleanInstruction(instruction);
  const workspace = await resolveWorkspaceDirectory({ project, directory });
  const root = workspace.projectRoot;
  let sources;
  if (sourcePaths?.length) {
    const { skills } = await loadSkillSelectionCatalog();
    sources = sourcePaths.map(source => {
      const skill = skills.find(item => item.file === source);
      if (!skill) throw issue('Choose an exact path from the Omni catalog.', 'UNKNOWN_WORKSPACE_RECIPE_SOURCE', 422);
      return { path: skill.file, name: skill.name, category: skill.category };
    });
  } else {
    if (!task) return noMatch('Describe the task this skill should help with, or pick skills from the catalog.');
    const result = await selectSkills({
      project: root, directory: workspace.directory, agent: currentAgent, query: task, maxSkills: 3, catalogOnly: true,
    });
    sources = result.matches.map(({ path, name, category }) => ({ path, name, category }));
    if (!sources.length) return noMatch('No eligible catalog skill matched that request. Describe a specific coding task or pick skills from the catalog.');
  }

  const draft = {
    ...describeDraft(sources, task), instructions: task,
    sourcePaths: sources.map(source => source.path),
  };
  if (scope === 'project' && currentAgent) {
    await previewWorkspaceSkill({ project: root, ...draft, agent: currentAgent });
  }
  const { recipe, created } = await createWorkspaceSkill({
    project: root, ...draft, agent: scope === 'project' ? null : currentAgent, reuseExisting: true,
  });
  const names = new Map(sources.map(source => [source.path, source.name]));
  const picked = recipe.sourcePaths.map(path => ({ path, name: names.get(path) }));
  if (!recipe.enabled) {
    return { recipe, sources: picked, markdown: '', created, reason: 'This skill is already saved and disabled.' };
  }
  const { markdown } = await composeWorkspaceSkill({ project: root, id: recipe.id, agent: currentAgent });
  return { recipe, sources: picked, markdown, created };
}
