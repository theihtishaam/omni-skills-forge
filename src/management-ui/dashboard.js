import { createSkillBuilder } from './skill-builder.js';

const el = id => document.getElementById(id);
const agentLabels = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  cline: 'Cline',
  kilo: 'Kilo',
  opencode: 'OpenCode',
  windsurf: 'Windsurf',
  portable: 'Portable',
};
const categoryLabels = {
  'ai-ml': 'AI & ML',
  'web-dev': 'Web development',
  'computer-vision': 'Computer vision',
  cicd: 'CI/CD',
  csharp: 'C#',
  gcp: 'Google Cloud',
  aws: 'AWS',
  llm: 'LLMs',
  mlops: 'MLOps',
  nextjs: 'Next.js',
  nodejs: 'Node.js',
  nosql: 'NoSQL',
  rag: 'RAG',
  sql: 'SQL',
};
const format = new Intl.NumberFormat('en-US');
const deliveryTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const DELIVERY_REFRESH_MS = 15_000;
const AGENT_SETUP_URL = 'https://github.com/theihtishaam/omni-skills-forge/blob/v2.3.0/docs/TASK_SKILLS.md#run-automatically-on-a-submitted-prompt';
const state = {
  projectName: '',
  agent: 'codex',
  scope: 'agent',
  ready: false,
  saving: false,
  taskLoading: false,
  catalogLoading: false,
  workspaceLoading: false,
  taskRequest: 0,
  catalogRequest: 0,
  workspaceRequest: 0,
  deliveryRequest: 0,
  deliveryView: 'selected',
  deliveryTimer: null,
  deliveryLoading: false,
  latestDeliveryKey: null,
  revision: null,
  plan: null,
  task: null,
  workspace: null,
  catalog: null,
  filters: { query: '', filter: 'all', category: '', page: 1 },
};

class DashboardError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(url, data) {
  const options = data ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  } : {};
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new DashboardError('Dashboard connection lost. Check that the local command is still running.');
  }
  const result = await response.json();
  if (!response.ok) throw new DashboardError(result.error, response.status);
  return result;
}

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function showError(message = '') {
  el('notice').hidden = !message;
  el('notice').textContent = message;
}

function announce(message) {
  el('live-status').textContent = message;
}

function empty(list, text) {
  list.replaceChildren(node('div', 'empty', text));
}

function rememberRevision(revision) {
  if (state.revision !== null && revision > state.revision) builder.invalidate();
  state.revision = Math.max(state.revision ?? 0, revision);
}

function usablePlan() {
  return state.plan &&
    state.plan.revision === state.revision &&
    !state.taskLoading &&
    !state.saving;
}

function formMatchesTask() {
  return state.task &&
    state.workspace?.workspace.directory === state.task.directory &&
    folderFieldIsCurrent() &&
    el('task-query').value.trim() === state.task.query &&
    el('token-budget').valueAsNumber === state.task.tokenBudget &&
    el('max-skills').valueAsNumber === state.task.maxSkills;
}

function folderFieldIsCurrent() {
  return state.workspace?.workspace.directory === el('folder-path').value.trim();
}

function updateFolderNote() {
  const folder = state.workspace?.workspace.directory;
  el('folder-note').textContent = folder && !folderFieldIsCurrent()
    ? 'Currently showing ' + displayFolder(folder) + '. Inspect the new path to switch folders.'
    : 'Use a path inside this workspace. A dot selects its root.';
}

function updateButtons() {
  el('inspect-folder').disabled = !state.ready || state.saving || state.workspaceLoading;
  el('run').disabled = !state.ready || !folderFieldIsCurrent() || !el('task-query').value.trim() ||
    state.taskLoading || state.saving || state.workspaceLoading;
  el('download').disabled = !usablePlan() || !state.plan.markdown || !formMatchesTask();
  el('agent').disabled = !state.ready || state.saving || state.workspaceLoading;
  el('delivery-view').disabled = !state.ready;
  el('catalog-category').disabled = !state.ready || state.saving;
  el('scope').disabled = state.saving;
  el('selected-list').setAttribute('aria-busy', String(state.taskLoading));
  el('suggested-list').setAttribute('aria-busy', String(state.workspaceLoading));
  el('catalog-list').setAttribute('aria-busy', String(state.catalogLoading));
  el('previous').disabled = state.catalogLoading || !state.catalog || state.catalog.page <= 1;
  el('next').disabled = state.catalogLoading || !state.catalog || state.catalog.page * state.catalog.pageSize >= state.catalog.total;
}

function updateSelectionNote() {
  let note = 'Preview skill text before downloading it.';
  if (state.plan) {
    if (!folderFieldIsCurrent()) note = 'Inspect this folder before previewing task skills.';
    else if (!formMatchesTask()) note = 'Preview task skills again to apply your edits.';
    else note = 'Preview for ' + agentLabels[state.agent] + ' · ' + displayFolder(state.task.directory) +
      ' · editing preferences for ' + editScopeLabel();
  }
  el('selection-note').textContent = note;
}

function displayFolder(directory) {
  return directory === '.' ? state.projectName : state.projectName + ' / ' + directory;
}

function editScopeLabel() {
  return state.scope === 'project' ? 'all agents' : agentLabels[state.agent];
}

function categoryLabel(category) {
  return category.split('/').map(part => categoryLabels[part] ?? part[0].toUpperCase() + part.slice(1)).join(' / ');
}

function blockedLabel(rule) {
  const label = rule.scope === 'project' ? 'all agents' : agentLabels[state.agent];
  return 'Disabled for ' + label + (rule.category ? ' by ' + categoryLabel(rule.category) : '');
}

function statusControl(entry, list, revision, kind = 'skill') {
  const isProject = state.scope === 'project';
  const configured = isProject ? entry.projectStatus : entry.agentStatus;
  const blocked = isProject ? entry.projectBlock : entry.agentBlock;
  const enabled = !blocked && configured !== 'disabled';
  const label = blocked || configured === 'disabled' ? 'Disabled' : configured === 'enabled' ? 'Enabled' : 'Eligible';
  const key = kind === 'category' ? categoryLabel(entry.category) : entry.path + ' · ' + entry.difficulty;
  const control = node('div', 'skill-preference');
  const toggle = node('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(enabled));
  toggle.setAttribute('aria-label', 'Allow ' + key + ' for ' + editScopeLabel());
  if (kind === 'category') toggle.dataset.category = entry.category;
  else toggle.dataset.path = entry.path;
  toggle.disabled = Boolean(blocked) || state.saving || revision !== state.revision;
  const track = node('span', 'switch-track');
  track.setAttribute('aria-hidden', 'true');
  toggle.append(track, node('span', '', label));
  toggle.addEventListener('click', () => savePreference(entry, enabled ? 'disabled' : 'enabled', list, kind));
  control.append(toggle);
  if (blocked) control.append(node('span', 'inherited', blockedLabel(blocked)));
  else if (isProject && enabled && entry.effective.status === 'disabled') {
    control.append(node('span', 'inherited', blockedLabel(entry.effective)));
  }
  if (configured !== 'default') {
    const reset = node('button', 'reset', 'Reset');
    reset.type = 'button';
    reset.disabled = state.saving || revision !== state.revision;
    reset.setAttribute('aria-label', 'Reset ' + key + ' preference for ' + editScopeLabel());
    reset.addEventListener('click', () => savePreference(entry, 'default', list, kind));
    control.append(reset);
  }
  return control;
}

function row(skill, list, revision, type) {
  const row = node('article', 'skill-row');
  const text = node('div');
  text.append(node('h3', 'skill-name', skill.name));
  const details = node('div', 'skill-meta');
  const workspaceSkill = skill.kind === 'workspace' || skill.path.startsWith('workspace/');
  const category = node('span', '', skill.category);
  category.title = skill.path;
  if (workspaceSkill) details.append(node('span', 'skill-state active', 'Workspace skill'));
  else details.append(category, node('span', '', '·'), node('span', '', skill.difficulty));
  if (skill.eligibility === 'disabled') details.append(node('span', 'skill-state', 'Disabled by policy'));
  else if (type === 'suggested') details.append(node('span', 'skill-state', 'Standby'));
  else if (type === 'selected') details.append(node('span', 'skill-state active', 'Selected'));
  if (skill.estimatedTokens !== undefined) {
    details.append(node('span', 'estimate', '≈ ' + format.format(skill.estimatedTokens) + ' tokens'));
  }
  text.append(details);
  const reason = Array.isArray(skill.reason) ? skill.reason.join(' · ') : skill.reason;
  if (reason || skill.description) text.append(node('p', 'skill-reason', reason || skill.description));
  row.append(text);
  if (workspaceSkill) {
    if (skill.sourcePaths?.length) {
      const provenance = node('details', 'skill-reason');
      const paths = node('ul');
      for (const path of skill.sourcePaths) paths.append(node('li', '', path));
      provenance.append(node('summary', '', skill.sourcePaths.length + ' catalog sources'), paths);
      text.append(provenance);
    }
  } else {
    const controls = statusControl(skill, list, revision);
    if (type !== 'suggested') controls.append(builder.sourceAction(skill));
    row.append(controls);
  }
  return row;
}

function renderPlan() {
  const plan = state.plan;
  const used = plan?.estimatedTokens ?? 0;
  const capacity = plan?.tokenBudget ?? state.task?.tokenBudget ?? 2400;
  const limit = plan?.maxSkills ?? state.task?.maxSkills ?? 3;
  const count = plan?.matches.length ?? 0;
  const list = el('selected-list');
  el('selection').hidden = !state.task;
  el('used-tokens').textContent = format.format(used);
  el('budget-total').textContent = '/ ' + format.format(capacity) + ' est. tokens';
  el('budget-progress').max = capacity;
  el('budget-progress').value = used;
  el('remaining-tokens').textContent = format.format(Math.max(capacity - used, 0)) + ' available';
  el('selection-count').textContent = count + ' / ' + limit + ' skills';
  updateSelectionNote();
  if (state.taskLoading) {
    empty(list, 'Finding relevant skills for ' + agentLabels[state.agent] + '…');
  } else if (!plan) {
    empty(list, 'Choose Preview task skills to try again.');
  } else if (!plan.matches.length) {
    empty(list, 'No eligible skills fit this task and budget. Try a more specific task, a larger budget, or review disabled skills.');
  } else if (!state.saving && !usablePlan()) {
    empty(list, 'Project preferences changed. Run the task again to refresh its context.');
  } else {
    list.replaceChildren(...plan.matches.map(skill => row(skill, list, plan.revision, 'selected')));
  }
  builder.update();
  updateButtons();
}

function renderWorkspace() {
  const result = state.workspace;
  const technologies = el('technology-list');
  const list = el('suggested-list');
  if (state.workspaceLoading || !result) {
    technologies.replaceChildren(node('p', 'muted small', state.workspaceLoading ? 'Checking the workspace…' : 'Inspect a folder to detect technologies.'));
    empty(list, state.workspaceLoading ? 'Finding suggestions for this folder…' : 'Inspect a folder to see suggestions.');
  } else {
    technologies.replaceChildren(...result.workspace.technologies.map(technology => {
      const chip = node('div', 'tech-chip');
      const sources = technology.sources.map(source => source.directory === '.' ? source.file : source.directory + '/' + source.file);
      chip.append(node('strong', '', technology.name), node('code', '', sources.join(' · ')));
      return chip;
    }));
    if (!result.workspace.technologies.length) {
      technologies.replaceChildren(node('p', 'muted small', 'No recognized project files in this folder or its parent folders.'));
    }
    if (result.revision !== state.revision) {
      empty(list, 'Project preferences changed. Inspect the folder again to update suggestions.');
    } else if (result.suggestions.length) {
      const selected = new Set(usablePlan() ? state.plan.matches.map(skill => skill.path) : []);
      list.replaceChildren(...result.suggestions.map(skill =>
        row(skill, list, result.revision, selected.has(skill.path) ? 'selected' : 'suggested')));
    } else {
      empty(list, 'No eligible skills matched the detected stack. You can preview a task or browse the catalog.');
    }
  }
  updateFolderNote();
  updateButtons();
}

async function loadWorkspace(directory, submitted = false, reschedule = true) {
  const call = ++state.workspaceRequest;
  state.workspaceLoading = true;
  renderWorkspace();
  try {
    const result = await api('/api/workspace', { directory, agent: state.agent });
    if (call !== state.workspaceRequest) return;
    if (reschedule && result.revision < (state.revision ?? 0)) return loadWorkspace(directory, submitted, false);
    if (state.task && state.task.directory !== result.workspace.directory) {
      state.taskRequest++;
      state.taskLoading = false;
      state.plan = null;
      state.task = null;
    }
    state.workspace = result;
    if (submitted) {
      if (el('folder-path').value.trim() === directory) el('folder-path').value = result.workspace.directory;
      announce(result.workspace.technologies.length + ' technologies detected for ' + displayFolder(result.workspace.directory) + '.');
    }
    rememberRevision(result.revision);
  } catch (error) {
    if (call === state.workspaceRequest) showError(error.message);
  } finally {
    if (call === state.workspaceRequest) {
      state.workspaceLoading = false;
      renderWorkspace();
      renderPlan();
      if (state.catalog && state.catalog.revision !== state.revision && !state.catalogLoading) void loadCatalog();
    }
  }
}

function deliveryRecord(record, showAgent = false) {
  const article = node('article', 'delivery-record');
  const meta = node('div', 'delivery-meta');
  const method = record.method === 'hook' ? 'Prompt hook' : 'MCP';
  const time = node('time', '', deliveryTime.format(new Date(record.at)));
  time.dateTime = record.at;
  time.title = record.at;
  if (showAgent) meta.append(node('strong', 'delivery-agent', agentLabels[record.agent] ?? record.agent));
  meta.append(node('span', 'delivery-method', method), time);
  const paths = node('ul', 'delivery-skills');
  for (const skill of record.skills) {
    const item = node('li', '', skill.name);
    item.title = skill.path;
    paths.append(item);
  }
  article.append(meta, node('code', 'delivery-folder', displayFolder(record.directory)), paths);
  return article;
}

function renderDeliveries(records) {
  const list = el('delivery-list');
  const allAgents = state.deliveryView === 'all';
  if (!records.length) {
    const prompt = allAgents ? 'No context delivered in this workspace yet.' :
      'No context delivered to this agent yet. Previews appear under Selected for this task.';
    const message = node('div', 'empty delivery-empty');
    const connect = node('a', '', 'Connect your agent');
    connect.href = AGENT_SETUP_URL;
    connect.target = '_blank';
    connect.rel = 'noopener noreferrer';
    message.append(node('p', '', prompt), connect);
    list.replaceChildren(message);
    return;
  }
  if (allAgents) {
    list.replaceChildren(...records.map(record => deliveryRecord(record, true)));
    return;
  }
  const [latest, ...history] = records;
  list.replaceChildren(deliveryRecord(latest));
  if (history.length) {
    const details = node('details', 'delivery-history');
    details.append(node('summary', '', 'Earlier deliveries (' + history.length + ')'), ...history.map(deliveryRecord));
    list.append(details);
  }
}

async function refreshDeliveries(reset = false) {
  clearTimeout(state.deliveryTimer);
  if (document.hidden || !state.ready || (state.deliveryLoading && !reset)) return;
  const call = ++state.deliveryRequest;
  const list = el('delivery-list');
  const refresh = el('refresh-delivery');
  const allAgents = state.deliveryView === 'all';
  el('delivery-note').textContent = allAgents ? 'Latest recorded handoff for each agent.' :
    'Latest hook or MCP handoff for ' + agentLabels[state.agent] + '.';
  if (reset) {
    state.latestDeliveryKey = null;
    empty(list, 'Checking for deliveries…');
  }
  state.deliveryLoading = true;
  refresh.disabled = true;
  list.setAttribute('aria-busy', 'true');
  try {
    const query = allAgents ? '' : '?' + new URLSearchParams({ agent: state.agent });
    const data = await api('/api/deliveries' + query);
    if (call !== state.deliveryRequest) return;
    const records = allAgents ? data.latestByAgent : data.records;
    const key = JSON.stringify(records);
    if (key !== state.latestDeliveryKey) {
      renderDeliveries(records);
      state.latestDeliveryKey = key;
    }
  } catch {
    if (call !== state.deliveryRequest) return;
    state.latestDeliveryKey = null;
    empty(list, 'Could not check for deliveries. Refresh to try again.');
  } finally {
    if (call === state.deliveryRequest) {
      state.deliveryLoading = false;
      list.setAttribute('aria-busy', 'false');
      refresh.disabled = false;
      if (!document.hidden) state.deliveryTimer = setTimeout(refreshDeliveries, DELIVERY_REFRESH_MS);
    }
  }
}

function renderCatalog() {
  const result = state.catalog;
  const list = el('catalog-list');
  el('catalog-scope').textContent = 'Showing eligibility for ' + agentLabels[state.agent] + ' · editing preferences for ' + editScopeLabel();
  const count = el('category-counts');
  const category = state.filters.category;
  const preference = el('category-preference');
  el('category-policy-heading').textContent = 'Category preference for ' + editScopeLabel();
  count.textContent = state.catalogLoading || !result ? '' :
    format.format(result.counts.category) + ' skills · ' + format.format(result.counts.categoryDisabled) +
    ' disabled for ' + agentLabels[state.agent];
  if (!category) {
    preference.replaceChildren(node('p', 'field-note', 'Choose a family or category to edit its preference.'));
  } else if (state.catalogLoading || result?.categoryPreference?.category !== category) {
    preference.replaceChildren(node('p', 'field-note', state.catalogLoading ? 'Loading category preference…' : 'Filter the catalog to load this preference.'));
  } else {
    preference.replaceChildren(statusControl(result.categoryPreference, preference, result.revision, 'category'));
  }
  if (state.catalogLoading || !result) {
    empty(list, state.catalogLoading ? 'Loading skills…' : 'Run a catalog filter to load skills.');
    el('page-summary').textContent = '';
  } else {
    el('disabled-count').textContent = format.format(result.counts.disabled);
    el('catalog-total').textContent = format.format(result.counts.catalog) + ' packaged skills';
    if (result.items.length) {
      list.replaceChildren(...result.items.map(skill => row(skill, list, result.revision)));
      const start = (result.page - 1) * result.pageSize + 1;
      const end = start + result.items.length - 1;
      el('page-summary').textContent = 'Showing ' + format.format(start) + '–' + format.format(end) + ' of ' + format.format(result.total);
    } else {
      empty(list, 'No skills match these filters. Clear the search or choose a different eligibility filter.');
      el('page-summary').textContent = '0 matching skills';
    }
  }
  updateButtons();
}

async function loadCatalog(reschedule = true) {
  const call = ++state.catalogRequest;
  state.catalogLoading = true;
  renderCatalog();
  try {
    const params = new URLSearchParams({ ...state.filters, agent: state.agent });
    const result = await api('/api/catalog?' + params);
    if (call !== state.catalogRequest) return;
    if (reschedule && result.revision < (state.revision ?? 0)) return loadCatalog(false);
    const finalPage = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (result.page > finalPage) {
      state.filters.page = finalPage;
      return loadCatalog();
    }
    state.catalog = result;
    rememberRevision(result.revision);
  } catch (error) {
    if (call === state.catalogRequest) showError(error.message);
  } finally {
    if (call === state.catalogRequest) {
      state.catalogLoading = false;
      renderCatalog();
      if (state.plan && !state.saving && !usablePlan()) renderPlan();
      if (state.workspace && state.workspace.revision !== state.revision && !state.workspaceLoading) {
        void loadWorkspace(state.workspace.workspace.directory);
      }
    }
  }
}

async function runTask(reschedule = true) {
  if (!state.task) return;
  const call = ++state.taskRequest;
  state.taskLoading = true;
  state.plan = null;
  renderPlan();
  try {
    const result = await api('/api/select', { ...state.task, agent: state.agent });
    if (call !== state.taskRequest) return;
    if (reschedule && result.revision < (state.revision ?? 0)) {
      return runTask(false);
    }
    state.plan = result;
    rememberRevision(result.revision);
    announce(result.matches.length + ' skills selected for ' + agentLabels[state.agent] + '.');
  } catch (error) {
    if (call === state.taskRequest) showError(error.message);
  } finally {
    if (call === state.taskRequest) {
      state.taskLoading = false;
      renderPlan();
      renderWorkspace();
      if (state.catalog && state.catalog.revision !== state.revision && !state.catalogLoading) {
        void loadCatalog();
      }
      if (state.workspace && state.workspace.revision !== state.revision && !state.workspaceLoading) {
        void loadWorkspace(state.workspace.workspace.directory);
      }
    }
  }
}

async function savePreference(entry, status, list, kind) {
  if (state.saving) return;
  showError();
  state.saving = true;
  renderPlan();
  renderCatalog();
  renderWorkspace();
  const scopeLabel = editScopeLabel();
  const agent = state.scope === 'project' ? undefined : state.agent;
  const category = kind === 'category';
  const route = category ? '/api/category-preferences' : '/api/preferences';
  const target = category ? { category: entry.category } : { path: entry.path };
  let errorMessage;
  try {
    const result = await api(route, { ...target, status, agent, expectedRevision: state.revision });
    rememberRevision(result.revision);
  } catch (error) {
    errorMessage = error.status === 409 ? 'Another dashboard changed these preferences. Review the refreshed settings and try again.' : error.message;
  }
  try {
    await Promise.all([loadCatalog(), runTask(), loadWorkspace(state.workspace?.workspace.directory ?? '.')]);
  } finally {
    state.saving = false;
    renderPlan();
    renderCatalog();
    renderWorkspace();
    if (errorMessage) showError(errorMessage);
    else announce((category ? categoryLabel(entry.category) : entry.name) + ' preference saved for ' + scopeLabel + '.');
    const restoredSwitch = [...list.querySelectorAll('.switch')].find(control => category
      ? control.dataset.category === entry.category : control.dataset.path === entry.path);
    if (restoredSwitch && !restoredSwitch.disabled) restoredSwitch.focus({ preventScroll: true });
    else if (category) el('catalog-category').focus({ preventScroll: true });
    else if (list === el('selected-list')) el('run').focus({ preventScroll: true });
    else if (list === el('suggested-list')) el('inspect-folder').focus({ preventScroll: true });
    else el('catalog-filter').focus({ preventScroll: true });
  }
}

el('folder-form').addEventListener('submit', event => {
  event.preventDefault();
  showError();
  void loadWorkspace(el('folder-path').value.trim() || '.', true);
});
el('folder-path').addEventListener('input', () => {
  updateFolderNote();
  updateSelectionNote();
  updateButtons();
});

el('task-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = el('task-query').value.trim();
  if (!query || !folderFieldIsCurrent() || state.workspaceLoading) return;
  showError();
  state.task = {
    query,
    directory: state.workspace.workspace.directory,
    tokenBudget: el('token-budget').valueAsNumber,
    maxSkills: el('max-skills').valueAsNumber,
  };
  void runTask();
});
el('task-form').addEventListener('input', () => {
  updateSelectionNote();
  updateButtons();
  builder.update();
});
el('task-form').addEventListener('invalid', () => {
  el('advanced').open = true;
}, true);

function downloadMarkdown(markdown, filename) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = node('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

el('download').addEventListener('click', () => {
  if (!usablePlan() || !state.plan.markdown || !formMatchesTask()) return;
  downloadMarkdown(state.plan.markdown, 'omni-task-context-' + state.agent + '.md');
});

el('agent').addEventListener('change', () => {
  showError();
  const directory = state.workspace?.workspace.directory ?? '.';
  state.agent = el('agent').value;
  builder.update();
  state.filters.page = 1;
  state.catalog = null;
  renderCatalog();
  void Promise.all([loadCatalog(), runTask(), loadWorkspace(directory)]);
  if (state.deliveryView === 'selected') void refreshDeliveries(true);
});

el('scope').addEventListener('change', () => {
  state.scope = el('scope').value;
  renderPlan();
  renderCatalog();
  renderWorkspace();
});

el('delivery-view').addEventListener('change', () => {
  state.deliveryView = el('delivery-view').value;
  void refreshDeliveries(true);
});
el('refresh-delivery').addEventListener('click', () => void refreshDeliveries());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(state.deliveryTimer);
  else void refreshDeliveries();
});

function applyFilters() {
  showError();
  state.filters = {
    query: el('catalog-query').value.trim(),
    filter: el('catalog-filter').value,
    category: el('catalog-category').value,
    page: 1,
  };
  void loadCatalog();
}

el('catalog-form').addEventListener('submit', event => {
  event.preventDefault();
  applyFilters();
});
el('catalog-filter').addEventListener('change', applyFilters);
el('catalog-category').addEventListener('change', applyFilters);
el('disabled-link').addEventListener('click', () => {
  el('catalog-query').value = '';
  el('catalog-filter').value = 'disabled';
  el('catalog-category').value = '';
  applyFilters();
});
for (const [id, change] of [['previous', -1], ['next', 1]]) {
  el(id).addEventListener('click', () => {
    showError();
    state.filters.page += change;
    void loadCatalog();
  });
}

async function start() {
  try {
    const project = await api('/api/project');
    state.projectName = project.name;
    el('project-name').textContent = project.name;
    el('workspace-name').textContent = project.name;
    el('agent').replaceChildren(...project.agents.map(id => {
      const option = node('option', '', agentLabels[id] ?? id);
      option.value = id;
      return option;
    }));
    if (!project.agents.includes(state.agent)) state.agent = project.agents[0];
    el('agent').value = state.agent;
    const categories = el('catalog-category');
    for (const group of project.categoryGroups) {
      const options = node('optgroup');
      options.label = categoryLabel(group.family);
      const family = node('option', '', 'All ' + options.label);
      family.value = group.family;
      options.append(family);
      for (const category of group.categories) {
        const option = node('option', '', categoryLabel(category.split('/').at(-1)));
        option.value = category;
        options.append(option);
      }
      categories.append(options);
    }
    el('task-query').maxLength = project.limits.maxQueryLength;
    el('max-skills').max = project.limits.maxSkills;
    el('max-skills').defaultValue = project.limits.defaultMaxSkills;
    el('token-budget').max = project.limits.maxTokenBudget;
    el('token-budget').defaultValue = project.limits.defaultTokenBudget;
    state.ready = true;
    updateButtons();
    await Promise.all([loadCatalog(), loadWorkspace('.', true), refreshDeliveries(true), builder.loadLibrary()]);
  } catch (error) {
    showError(error.message);
    el('project-name').textContent = 'Project unavailable';
  }
}
const builder = createSkillBuilder({
  api,
  activeAgent: () => state.agent,
  agentLabel: agent => agentLabels[agent] ?? agent,
  taskMatches: () => usablePlan() && formMatchesTask() ? state.plan.matches : [],
  taskQuery: () => state.task?.query ?? '',
  rerenderRows: () => { renderCatalog(); renderPlan(); },
  refreshTask: () => { void runTask(); },
  download: downloadMarkdown,
});
void start();
