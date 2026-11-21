import { realpath } from 'node:fs/promises';
import path from 'node:path';

const maxEventBytes = 128 * 1024;
const makeDirective = /^(?:please[, ]+)?(?:make|create|save)\s+(?:me\s+)?(?:a|one)\s+(?:(?:combined|reusable|workspace)\s+){0,3}skill\s+for\s+(\S[\s\S]*)$/iu;
const deferredActions = [
  /\b(?:not|don['’]t|never|without)\s+(?:(?:actually|really|automatically|yet)\s+)*(?:mak(?:e|ing)|creat(?:e|ing)|sav(?:e|ing)|add(?:ing)?|persist(?:ing)?|apply(?:ing)?|writ(?:e|ing)|install(?:ing)?|register(?:ing)?)\b/iu,
  /\b(?:(?:preview|example)[- ]only|dry[- ]run|(?:only|just)\s+(?:an?\s+)?(?:preview|simulate|simulation|pretend|draft)|as\s+(?:an?\s+)?(?:preview|simulation|mock[- ]up|draft))\b/iu,
  /\b(?:(?:only|just)\s+(?:show|describe)\s+(?:me\s+)?(?:a|the)\s+(?:draft|preview|simulation)|simulate\s+(?:a|the)\s+(?:creation|save|write)|pretend\s+to\s+(?:create|save))\b/iu,
  /\b(?:(?:if|unless|until|after)\s+(?:i|we|you)\s+(?:confirm|approve|ask)|hold\s+off)\b/iu,
];
const exampleDirective = /\bas\s+an?\s+(?:example|sample|demonstration)\b/iu;

function explicitCreationTask(prompt) {
  // Require an imperative at the start of the prompt before writing a recipe.
  const directive = prompt.trim();
  const match = makeDirective.exec(directive);
  if (!match) return;
  const task = match[1].normalize('NFKC');
  const firstSentence = task.split(/[.!]\s/u, 1)[0];
  if (task.includes('?') || deferredActions.some(pattern => pattern.test(task)) || exampleDirective.test(firstSentence)) return;
  return match[1];
}

async function readEvent(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxEventBytes) return null;
    chunks.push(buffer);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function writeHookContext(output, additionalContext) {
  const line = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }) + '\n';
  return new Promise((resolve, reject) => {
    output.once('error', reject);
    output.write(line, error => {
      if (error) {
        // Node emits the stream error after reporting it to the write callback.
        reject(error);
        return;
      }
      output.off('error', reject);
      resolve();
    });
  });
}

async function createSkillNotice({ project, agent, directory, instruction }) {
  const { MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH, makeWorkspaceSkill } = await import('./make-workspace-skill.js');
  if (instruction.length > MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH) {
    return `Describe the workspace skill in up to ${MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH} characters.`;
  }
  const { recipe, created, reason } = await makeWorkspaceSkill({ project, agent, directory, instruction });
  if (!recipe) return `Omni workspace skill request\n\n${reason}`;
  const lines = [
    `${created ? 'Saved' : 'Reused'} the Omni workspace skill “${recipe.title}”.`,
    `Workspace skill ID ${recipe.id}.`,
  ];
  if (!recipe.enabled) lines.push('This saved skill is disabled.');
  lines.push('', 'Catalog sources', ...recipe.sourcePaths.map(source => `- ${source}`));
  lines.push('', 'Omni handled the save request. Report this result to the user.');
  return lines.join('\n');
}

/** A prompt hook is optional guidance. A missing directory or bad event must leave the prompt usable. */
export async function runPromptHook({ project = process.cwd(), agent, tokenBudget, maxSkills },
  { input = process.stdin, output = process.stdout } = {}) {
  if (agent !== 'claude-code' && agent !== 'codex') return;
  try {
    const event = await readEvent(input);
    if (event?.hook_event_name !== 'UserPromptSubmit' || typeof event.prompt !== 'string' ||
        !event.prompt.trim() || typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd)) return;
    const [root, cwd] = await Promise.all([realpath(project), realpath(event.cwd)]);
    const relative = path.relative(root, cwd);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;

    const directory = relative.split(path.sep).join('/') || '.';
    const instruction = explicitCreationTask(event.prompt);
    if (instruction) {
      const notice = await createSkillNotice({ project: root, agent, directory, instruction });
      await writeHookContext(output, notice);
      return;
    }

    const { selectSkills } = await import('./skill-selection.js');
    const selection = await selectSkills({ project: root, agent, directory, query: event.prompt.slice(0, 4000), tokenBudget, maxSkills });
    if (!selection.matches.length || !selection.markdown) return;
    await writeHookContext(output, selection.markdown);
    const { recordSkillDelivery } = await import('./skill-delivery.js');
    await recordSkillDelivery({ project: root, agent, method: 'hook', directory: selection.workspace.directory,
      paths: selection.matches.map(item => item.path) });
  } catch {
    // Fail open without logging the user's prompt, event payload or native transcript location.
  }
}
