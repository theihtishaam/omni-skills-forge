import { realpath } from 'node:fs/promises';
import path from 'node:path';

const maxEventBytes = 128 * 1024;

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

    const { selectSkills } = await import('./skill-selection.js');
    const selection = await selectSkills({ project: root, agent, query: event.prompt.slice(0, 4000), tokenBudget, maxSkills });
    if (!selection.matches.length || !selection.markdown) return;
    output.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit', additionalContext: selection.markdown
    } }) + '\n');
  } catch {
    // Fail open without logging the user's prompt, event payload or native transcript location.
  }
}
