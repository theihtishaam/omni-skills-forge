import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import {
  DEFAULT_SELECTION_MAX_SKILLS, DEFAULT_SELECTION_TOKEN_BUDGET, MAX_SELECTION_QUERY_LENGTH,
  MAX_SELECTION_SKILLS, MAX_SELECTION_TOKEN_BUDGET, SELECTION_AGENTS, resolveSkillProject, selectSkills,
} from './skill-selection.js';

const { name, version } = createRequire(import.meta.url)('../package.json');
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FRAME_BYTES = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const INSTRUCTIONS = 'Call select_skills once when starting a new technical task that could use specialist guidance. If an Omni prompt hook already checked the current task, use its result and skip the tool call. An empty result means you can continue without Omni guidance.';
const SELECT_TOOL = {
  name: 'select_skills',
  description: 'Find the enabled Omni skills relevant to the current technical task and return their guidance within a size budget. The server uses this project and agent’s existing settings. Call at the start of a relevant task unless an Omni prompt hook has already checked it.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: MAX_SELECTION_QUERY_LENGTH, description: 'Describe the task and its technologies.' },
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
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function validArguments(args) {
  if (!isObject(args) || typeof args.query !== 'string' || !args.query.trim()) return false;
  return Object.entries(args).every(([key, value]) => {
    if (!Object.hasOwn(SELECT_TOOL.inputSchema.properties, key)) return false;
    const schema = SELECT_TOOL.inputSchema.properties[key];
    if (key === 'query') return value.length <= schema.maxLength;
    return Number.isInteger(value) && value >= schema.minimum && value <= schema.maximum;
  });
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
        yield `${JSON.stringify(rpcError(null, -32600, 'MCP message exceeds 64 KiB.'))}\n`;
        continue;
      }
      segment.copy(partial, length);
      length += segment.length;
      if (newline === -1) continue;
      const response = await handle(partial.subarray(0, length));
      length = 0;
      if (response) yield `${JSON.stringify(response)}\n`;
    }
  }
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
        return rpcResult(id, { tools: [SELECT_TOOL] });
      case 'tools/call': {
        if (state !== 'ready') return rpcError(id, -32002, 'The server is not initialized.');
        if (params?.name !== SELECT_TOOL.name) return rpcError(id, -32602, 'Unknown tool.');
        const args = params.arguments;
        if (!validArguments(args)) return rpcError(id, -32602, 'Provide a task query and valid selection limits.');
        try {
          const { markdown } = await selectSkills({ project: root, agent, ...args });
          return rpcResult(id, { content: markdown ? [{ type: 'text', text: markdown }] : [] });
        } catch {
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

  await pipeline(readResponses(input, handle), output);
}
