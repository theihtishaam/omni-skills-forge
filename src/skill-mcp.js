import { createRequire } from 'node:module';
import { MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH, makeWorkspaceSkill } from './make-workspace-skill.js';
import { recordSkillDelivery } from './skill-delivery.js';
import {
  DEFAULT_SELECTION_MAX_SKILLS, DEFAULT_SELECTION_TOKEN_BUDGET, MAX_SELECTION_QUERY_LENGTH,
  MAX_SELECTION_SKILLS, MAX_SELECTION_TOKEN_BUDGET, SELECTION_AGENTS, resolveSkillProject, selectSkills,
} from './skill-selection.js';
import { MAX_WORKSPACE_DIRECTORY_LENGTH } from './workspace-profile.js';
import { WORKSPACE_SKILL_LIMITS } from './workspace-skills.js';

const { name, version } = createRequire(import.meta.url)('../package.json');
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FRAME_BYTES = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const INSTRUCTIONS = 'Call select_skills once when starting a new technical task that could use specialist guidance. If an Omni prompt hook already checked the current task, use its result and skip the tool call. An empty result means you can continue without Omni guidance. Call make_workspace_skill only when the user explicitly asks to create and save a combined workspace skill.';
const DIRECTORY_INPUT = {
  type: 'string', minLength: 1, maxLength: MAX_WORKSPACE_DIRECTORY_LENGTH,
  description: 'An existing subdirectory relative to the configured project, such as apps/web. Defaults to the project root.',
};
const SELECT_TOOL = {
  name: 'select_skills',
  description: 'Find the enabled Omni skills relevant to the current technical task and return their guidance within a size budget. The server uses this project and agent’s existing settings and records nonempty deliveries locally. Call at the start of a relevant task unless an Omni prompt hook has already checked it.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: MAX_SELECTION_QUERY_LENGTH, description: 'Describe the task and its technologies.' },
      directory: DIRECTORY_INPUT,
      tokenBudget: {
        type: 'integer', minimum: 1, maximum: MAX_SELECTION_TOKEN_BUDGET,
        default: DEFAULT_SELECTION_TOKEN_BUDGET, description: 'Estimated token limit for the returned guidance.',
      },
      maxSkills: {
        type: 'integer', minimum: 1, maximum: MAX_SELECTION_SKILLS,
        default: DEFAULT_SELECTION_MAX_SKILLS, description: 'Maximum number of skills to return.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
const MAKE_TOOL = {
  name: 'make_workspace_skill',
  description: 'Save one combined workspace skill when the user explicitly asks to make one. Omni finds eligible catalog sources for the instruction or uses the exact sourcePaths you provide. Returns the saved skill ID and source paths.',
  inputSchema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string', minLength: 1, maxLength: MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH,
        description: 'Describe the reusable skill the user wants to save.',
      },
      directory: DIRECTORY_INPUT,
      sourcePaths: {
        type: 'array', minItems: 0, maxItems: WORKSPACE_SKILL_LIMITS.sources, uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 512 }, description: 'Exact catalog skill paths. Omit or leave empty for automatic picks.',
      },
    },
    required: ['instruction'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const TOOLS = [SELECT_TOOL, MAKE_TOOL];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id, result, delivery) {
  return { message: { jsonrpc: '2.0', id, result }, delivery };
}

function rpcError(id, code, message) {
  return { message: { jsonrpc: '2.0', id, error: { code, message } } };
}

function validValue(value, schema) {
  if (schema.type === 'string') {
    return typeof value === 'string' && value.trim().length >= schema.minLength && value.length <= schema.maxLength;
  }
  if (schema.type === 'array') {
    return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems &&
      new Set(value).size === value.length && value.every(item => validValue(item, schema.items));
  }
  return Number.isInteger(value) && value >= schema.minimum && value <= schema.maximum;
}

function validArguments(args, { properties, required }) {
  if (!isObject(args) || !required.every(key => Object.hasOwn(args, key))) return false;
  return Object.entries(args).every(([key, value]) => {
    return Object.hasOwn(properties, key) && validValue(value, properties[key]);
  });
}

async function makeSkillResponse(id, project, agent, args) {
  try {
    const { recipe, created, reason } = await makeWorkspaceSkill({ ...args, project, agent });
    const text = recipe ? [
      `${created ? 'Created' : 'Reused'} workspace skill “${recipe.title}”.`,
      `Workspace skill ID ${recipe.id}.`,
      !recipe.enabled && 'This saved skill is currently disabled.',
      '', 'Catalog sources', ...recipe.sourcePaths.map(path => `- ${path}`),
    ].filter(line => line !== false).join('\n') : reason || 'No eligible catalog skills matched this request.';
    return rpcResult(id, { content: [{ type: 'text', text }] });
  } catch (error) {
    if (error.status === 400) return rpcError(id, -32602, error.message);
    const text = [404, 409, 422].includes(error.status) ? error.message :
      'Omni could not save a workspace skill. Check the project’s Omni configuration and try again.';
    return rpcResult(id, { isError: true, content: [{ type: 'text', text }] });
  }
}

function validClient(params) {
  return isObject(params) && typeof params.protocolVersion === 'string' && Boolean(params.protocolVersion) &&
    isObject(params.capabilities) && isObject(params.clientInfo) &&
    typeof params.clientInfo.name === 'string' && typeof params.clientInfo.version === 'string';
}

// Keep at most one partial frame, and discard an oversized frame up to the next newline.
async function* readResponses(input, handle) {
  const partial = Buffer.alloc(MAX_FRAME_BYTES);
  let length = 0;
  let discarding = false;
  for await (const data of input) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      offset = end + 1;
      if (discarding) {
        discarding = newline === -1;
        continue;
      }
      if (length + segment.length > MAX_FRAME_BYTES) {
        length = 0;
        discarding = newline === -1;
        yield rpcError(null, -32600, 'MCP message exceeds 64 KiB.');
        continue;
      }
      segment.copy(partial, length);
      length += segment.length;
      if (newline === -1) continue;
      const response = await handle(partial.subarray(0, length));
      length = 0;
      if (response) yield response;
    }
  }
}

function writeResponse(output, message) {
  const line = `${JSON.stringify(message)}\n`;
  return new Promise((resolve, reject) => {
    output.once('error', reject);
    output.write(line, error => {
      if (error) {
        // The stream emits the error after invoking its write callback.
        reject(error);
        return;
      }
      output.off('error', reject);
      resolve();
    });
  });
}

export async function runSkillMcp({ project, agent, input = process.stdin, output = process.stdout }) {
  if (!SELECTION_AGENTS.includes(agent)) throw new Error('Choose a supported agent for the MCP server.');
  const root = await resolveSkillProject(project);
  let state = 'new';

  async function handle(frame) {
    let request;
    try {
      request = JSON.parse(utf8.decode(frame));
    } catch {
      return rpcError(null, -32700, 'Parse error.');
    }

    if (!isObject(request) || request.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid request.');
    const hasId = Object.hasOwn(request, 'id');
    const { id, method, params } = request;
    if (typeof method !== 'string') {
      // The server does not issue requests, so unexpected client responses can be ignored.
      if (hasId && (Object.hasOwn(request, 'result') || Object.hasOwn(request, 'error'))) return;
      return rpcError(null, -32600, 'Invalid request.');
    }
    if (hasId && typeof id !== 'string' && !Number.isSafeInteger(id)) {
      return rpcError(null, -32600, 'Invalid request ID.');
    }
    if (!hasId) {
      if (method === 'notifications/initialized' && state === 'initializing' &&
        (params === undefined || isObject(params))) state = 'ready';
      return;
    }
    if (params !== undefined && !isObject(params)) return rpcError(id, -32602, 'Invalid parameters.');

    switch (method) {
      case 'initialize': {
        if (state !== 'new') return rpcError(id, -32600, 'The server is already initialized.');
        if (!validClient(params)) return rpcError(id, -32602, 'Invalid initialization parameters.');
        const protocolVersion = PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0];
        state = 'initializing';
        return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version }, instructions: INSTRUCTIONS });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        if (state !== 'ready') return rpcError(id, -32002, 'The server is not initialized.');
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        if (state !== 'ready') return rpcError(id, -32002, 'The server is not initialized.');
        const tool = TOOLS.find(candidate => candidate.name === params?.name);
        if (!tool) return rpcError(id, -32602, 'Unknown tool.');
        const args = params.arguments;
        if (!validArguments(args, tool.inputSchema)) {
          return rpcError(id, -32602, tool === SELECT_TOOL ? 'Provide a task query and valid selection options.' :
            'Provide an instruction and valid workspace skill options.');
        }
        if (tool === MAKE_TOOL) return makeSkillResponse(id, root, agent, args);
        try {
          const { markdown, matches, workspace } = await selectSkills({ ...args, project: root, agent });
          if (!markdown || !matches.length) return rpcResult(id, { content: [] });
          return rpcResult(id, { content: [{ type: 'text', text: markdown }] }, {
            project: root, agent, method: 'mcp', directory: workspace.directory, paths: matches.map(match => match.path),
          });
        } catch (error) {
          if (error.code === 'INVALID_SELECTION_INPUT') {
            return rpcError(id, -32602, 'The workspace directory must be an existing, project-relative directory.');
          }
          return rpcResult(id, {
            isError: true,
            content: [{ type: 'text', text: 'Omni could not select skills. Check the project’s Omni configuration and try again.' }],
          });
        }
      }
      default:
        return rpcError(id, -32601, 'Method not found.');
    }
  }

  for await (const { message, delivery } of readResponses(input, handle)) {
    await writeResponse(output, message);
    if (delivery) await recordSkillDelivery(delivery).catch(() => {});
  }
  output.end();
}
