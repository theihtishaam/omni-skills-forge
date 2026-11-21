import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { exactworkRecommendation } from './exactwork-recommendation.js';
import {
  DEFAULT_SELECTION_MAX_SKILLS,
  DEFAULT_SELECTION_TOKEN_BUDGET,
  getSkillEligibility,
  loadSkillSelectionCatalog,
  loadSkillSelectionState,
  MAX_SELECTION_QUERY_LENGTH,
  MAX_SELECTION_SKILLS,
  MAX_SELECTION_TOKEN_BUDGET,
  resolveSkillProject,
  SELECTION_AGENTS,
  selectSkills,
  setSkillSelectionState,
} from './skill-selection.js';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024;
const CATALOG_PAGE_SIZE = 8;
const BROWSE_FILTERS = new Set(['all', 'eligible', 'disabled']);
const UI_ASSETS = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/dashboard.css', 'dashboard.css', 'text/css; charset=utf-8'],
  ['/dashboard.js', 'dashboard.js', 'text/javascript; charset=utf-8'],
];
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function json(response, status, data) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

async function readJson(request) {
  const type = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw badRequest('Send a JSON request body.', 415);
  const length = Number(request.headers['content-length']);
  if (length > MAX_BODY_BYTES) throw badRequest('Request is too large.', 413);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      request.resume();
      throw badRequest('Request is too large.', 413);
    }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw badRequest('Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return body;
}

function parseAgent(agent) {
  if (agent === null || agent === undefined || agent === '') return undefined;
  if (!SELECTION_AGENTS.includes(agent)) throw badRequest('Choose a supported agent.');
  return agent;
}

function mapStatus(state, skillPath, agent) {
  return {
    projectStatus: state.overrides[skillPath] ?? 'default',
    agentStatus: state.agentOverrides[agent]?.[skillPath] ?? 'default',
    eligibility: getSkillEligibility(state, skillPath, agent),
  };
}

function catalogPage(catalog, state, parameters) {
  const agent = parseAgent(parameters.get('agent'));
  const filter = parameters.get('filter') ?? 'all';
  if (!BROWSE_FILTERS.has(filter)) throw badRequest('Choose a supported catalog filter.');
  const rawQuery = parameters.get('query') ?? '';
  if (rawQuery.length > 160) throw badRequest('Keep catalog search under 160 characters.');
  const terms = rawQuery.toLowerCase().split(/[\s\-_/]+/u).filter(Boolean);
  const page = Number(parameters.get('page') ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > Math.max(1, Math.ceil(catalog.length / CATALOG_PAGE_SIZE))) {
    throw badRequest('Choose a valid catalog page.');
  }

  let disabled = 0;
  let total = 0;
  const items = [];
  const offset = (page - 1) * CATALOG_PAGE_SIZE;
  for (const { skill, searchable } of catalog) {
    const isDisabled = getSkillEligibility(state, skill.file, agent) === 'disabled';
    if (isDisabled) disabled++;
    if (filter === 'eligible' && isDisabled) continue;
    if (filter === 'disabled' && !isDisabled) continue;
    if (!terms.every(term => searchable.includes(term))) continue;
    if (total >= offset && items.length < CATALOG_PAGE_SIZE) {
      items.push({
        path: skill.file,
        name: skill.name,
        category: skill.category,
        difficulty: skill.difficulty,
        description: skill.description,
        ...mapStatus(state, skill.file, agent),
      });
    }
    total++;
  }
  return {
    page,
    pageSize: CATALOG_PAGE_SIZE,
    total,
    items,
    revision: state.revision,
    counts: {
      catalog: catalog.length,
      disabled,
      projectOverrides: Object.keys(state.overrides).length,
      agentOverrides: Object.keys(state.agentOverrides[agent] ?? {}).length,
    },
  };
}

export async function startManagementDashboard({ projectRoot = process.cwd(), port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Dashboard port must be an integer from 0 to 65535.');
  }
  const project = await resolveSkillProject(projectRoot);
  const [{ skills, categories }, ...files] = await Promise.all([
    loadSkillSelectionCatalog(),
    ...UI_ASSETS.map(([, filename]) => readFile(new URL('./management-ui/' + filename, import.meta.url))),
  ]);
  const assets = new Map(UI_ASSETS.map(([route, , contentType], index) => {
    const body = route === '/'
      ? files[index].toString('utf8').replace('<!-- exactwork-recommendation -->', exactworkRecommendation)
      : files[index];
    return [route, { contentType, body }];
  }));
  const catalog = skills.map(skill => ({
    skill,
    searchable: [skill.name, skill.category, skill.difficulty, skill.description, ...(skill.tags ?? [])]
      .join(' ').toLowerCase().replace(/[-_/]+/gu, ' '),
  }));

  let authority;
  let url;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== authority || !request.url?.startsWith('/') || request.url.startsWith('//')) {
        throw badRequest('Open the dashboard through its loopback URL.', 403);
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== url) throw badRequest('Origin does not match the dashboard.', 403);
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        throw badRequest('Cross-site dashboard requests are blocked.', 403);
      }
      if (request.method !== 'GET' && request.method !== 'POST') throw badRequest('Method not allowed.', 405);
      if (request.method === 'POST' && origin !== url) throw badRequest('A matching browser origin is required.', 403);
      const target = new URL(request.url, url);
      if (target.origin !== url) throw badRequest('Open the dashboard through its loopback URL.', 403);
      const route = target.pathname;
      if (request.method === 'GET') {
        const asset = assets.get(route);
        if (asset) {
          send(response, 200, asset.contentType, asset.body);
          return;
        }
        if (route === '/api/project') {
          json(response, 200, {
            name: path.basename(project) || project,
            agents: SELECTION_AGENTS,
            categories: categories.length,
            limits: {
              maxQueryLength: MAX_SELECTION_QUERY_LENGTH,
              defaultMaxSkills: DEFAULT_SELECTION_MAX_SKILLS,
              maxSkills: MAX_SELECTION_SKILLS,
              defaultTokenBudget: DEFAULT_SELECTION_TOKEN_BUDGET,
              maxTokenBudget: MAX_SELECTION_TOKEN_BUDGET,
            },
          });
          return;
        }
        if (route === '/api/catalog') {
          const state = await loadSkillSelectionState({ project });
          json(response, 200, catalogPage(catalog, state, target.searchParams));
          return;
        }
      }
      if (request.method === 'POST' && route === '/api/select') {
        const { query, tokenBudget, maxSkills, agent: rawAgent } = await readJson(request);
        const agent = parseAgent(rawAgent);
        const options = { project, query, tokenBudget, maxSkills, agent };
        let selection = await selectSkills(options);
        let state = await loadSkillSelectionState({ project });
        if (selection.revision !== state.revision) {
          selection = await selectSkills(options);
          state = await loadSkillSelectionState({ project });
          if (selection.revision !== state.revision) {
            throw badRequest('Project preferences changed while selecting skills. Run the task again.', 409);
          }
        }
        json(response, 200, {
          ...selection,
          matches: selection.matches.map(match => ({ ...match, ...mapStatus(state, match.path, agent) })),
        });
        return;
      }
      if (request.method === 'POST' && route === '/api/preferences') {
        const { path: skillPath, status, agent: rawAgent, expectedRevision } = await readJson(request);
        const agent = parseAgent(rawAgent);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw badRequest('A current policy revision is required.');
        }
        const state = await setSkillSelectionState({ project, agent, path: skillPath, status, expectedRevision });
        json(response, 200, { revision: state.revision, ...mapStatus(state, skillPath, agent) });
        return;
      }
      throw badRequest('Dashboard route not found.', 404);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (!response.headersSent) {
        json(response, status, { error: status === 500 ? 'The project dashboard could not complete the request.' : error.message });
      } else {
        response.end();
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      authority = HOST + ':' + server.address().port;
      url = 'http://' + authority;
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    url,
    server,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    }),
  };
}
