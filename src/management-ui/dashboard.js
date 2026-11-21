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
const format = new Intl.NumberFormat('en-US');
const state = {
  agent: 'codex',
  scope: 'agent',
  ready: false,
  saving: false,
  taskLoading: false,
  catalogLoading: false,
  taskRequest: 0,
  catalogRequest: 0,
  revision: null,
  plan: null,
  task: null,
  catalog: null,
  filters: { query: '', filter: 'all', page: 1 },
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
    el('task-query').value.trim() === state.task.query &&
    el('token-budget').valueAsNumber === state.task.tokenBudget &&
    el('max-skills').valueAsNumber === state.task.maxSkills;
}

function updateButtons() {
  el('run').disabled = !state.ready || state.taskLoading || state.saving;
  el('download').disabled = !usablePlan() || !state.plan.markdown || !formMatchesTask();
  el('agent').disabled = !state.ready || state.saving;
  el('scope').disabled = state.saving;
  el('selected-list').setAttribute('aria-busy', String(state.taskLoading));
  el('catalog-list').setAttribute('aria-busy', String(state.catalogLoading));
  el('previous').disabled = state.catalogLoading || !state.catalog || state.catalog.page <= 1;
  el('next').disabled = state.catalogLoading || !state.catalog || state.catalog.page * state.catalog.pageSize >= state.catalog.total;
}

function updateSelectionNote() {
  let note = 'Review the matches before taking them into your agent.';
  if (state.plan) {
    note = formMatchesTask()
      ? 'Task context for ' + agentLabels[state.agent] + ' · editing preferences for ' + editScopeLabel()
      : 'Find relevant skills again to apply your edits.';
  }
  el('selection-note').textContent = note;
}

function editScopeLabel() {
  return state.scope === 'project' ? 'all agents' : agentLabels[state.agent];
}

function statusControl(skill, list, revision) {
  const isProject = state.scope === 'project';
  const configured = isProject ? skill.projectStatus : skill.agentStatus;
  const blocked = !isProject && skill.projectStatus === 'disabled';
  const enabled = !blocked && configured !== 'disabled';
  const label = blocked || configured === 'disabled' ? 'Disabled' : configured === 'enabled' ? 'Enabled' : 'Eligible';
  const key = skill.path + ' · ' + skill.difficulty;
  const control = node('div', 'skill-preference');
  const toggle = node('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(enabled));
  toggle.setAttribute('aria-label', 'Allow ' + key + ' for ' + editScopeLabel());
  toggle.dataset.path = skill.path;
  toggle.disabled = blocked || state.saving || revision !== state.revision;
  const track = node('span', 'switch-track');
  track.setAttribute('aria-hidden', 'true');
  toggle.append(track, node('span', '', label));
  toggle.addEventListener('click', () => savePreference(skill, enabled ? 'disabled' : 'enabled', list));
  control.append(toggle);
  if (blocked) control.append(node('span', 'inherited', 'Disabled for all agents'));
  if (isProject && enabled && skill.agentStatus === 'disabled') {
    control.append(node('span', 'inherited', 'Disabled for ' + agentLabels[state.agent]));
  }
  if (configured !== 'default') {
    const reset = node('button', 'reset', 'Reset');
    reset.type = 'button';
    reset.disabled = state.saving || revision !== state.revision;
    reset.setAttribute('aria-label', 'Reset ' + key + ' preference for ' + editScopeLabel());
    reset.addEventListener('click', () => savePreference(skill, 'default', list));
    control.append(reset);
  }
  return control;
}

function row(skill, list, revision) {
  const row = node('article', 'skill-row');
  const text = node('div');
  text.append(node('h3', 'skill-name', skill.name));
  const details = node('div', 'skill-meta');
  const category = node('span', '', skill.category);
  category.title = skill.path;
  details.append(category, node('span', '', '·'), node('span', '', skill.difficulty));
  if (skill.estimatedTokens !== undefined) {
    details.append(node('span', 'estimate', '≈ ' + format.format(skill.estimatedTokens) + ' tokens'));
  }
  text.append(details);
  const reason = Array.isArray(skill.reason) ? skill.reason.join(' · ') : skill.reason;
  if (reason || skill.description) text.append(node('p', 'skill-reason', reason || skill.description));
  row.append(text, statusControl(skill, list, revision));
  return row;
}

function renderPlan() {
  const plan = state.plan;
  const used = plan?.estimatedTokens ?? 0;
  const capacity = plan?.tokenBudget ?? state.task?.tokenBudget ?? 2400;
  const limit = plan?.maxSkills ?? state.task?.maxSkills ?? 3;
  const count = plan?.matches.length ?? 0;
  const list = el('selected-list');
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
    empty(list, 'Describe a task and choose Find relevant skills to create a shortlist.');
  } else if (!plan.matches.length) {
    empty(list, 'No eligible skills fit this task and budget. Try a more specific task, a larger budget, or review disabled skills.');
  } else if (!state.saving && !usablePlan()) {
    empty(list, 'Project preferences changed. Run the task again to refresh its context.');
  } else {
    list.replaceChildren(...plan.matches.map(skill => row(skill, list, plan.revision)));
  }
  updateButtons();
}

function renderCatalog() {
  const result = state.catalog;
  const list = el('catalog-list');
  el('catalog-scope').textContent = 'Showing eligibility for ' + agentLabels[state.agent] + ' · editing preferences for ' + editScopeLabel();
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
      if (state.catalog && state.catalog.revision !== state.revision && !state.catalogLoading) {
        void loadCatalog();
      }
    }
  }
}

async function savePreference(skill, status, list) {
  if (state.saving) return;
  showError();
  state.saving = true;
  renderPlan();
  renderCatalog();
  const scopeLabel = editScopeLabel();
  const agent = state.scope === 'project' ? undefined : state.agent;
  let errorMessage;
  try {
    const result = await api('/api/preferences', { path: skill.path, status, agent, expectedRevision: state.revision });
    rememberRevision(result.revision);
  } catch (error) {
    errorMessage = error.status === 409 ? 'Another dashboard changed these preferences. Review the refreshed settings and try again.' : error.message;
  }
  try {
    await Promise.all([loadCatalog(), runTask()]);
  } finally {
    state.saving = false;
    renderPlan();
    renderCatalog();
    if (errorMessage) showError(errorMessage);
    else announce(skill.name + ' preference saved for ' + scopeLabel + '.');
    const restoredSwitch = [...list.querySelectorAll('.switch')].find(control => control.dataset.path === skill.path);
    if (restoredSwitch && !restoredSwitch.disabled) restoredSwitch.focus({ preventScroll: true });
    else if (list === el('selected-list')) el('run').focus({ preventScroll: true });
    else el('catalog-filter').focus({ preventScroll: true });
  }
}

el('task-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = el('task-query').value.trim();
  if (!query) {
    showError('Describe the task you want to work on.');
    el('task-query').focus();
    return;
  }
  showError();
  state.task = {
    query,
    tokenBudget: el('token-budget').valueAsNumber,
    maxSkills: el('max-skills').valueAsNumber,
  };
  void runTask();
});
el('task-form').addEventListener('input', () => {
  updateSelectionNote();
  updateButtons();
});

el('download').addEventListener('click', () => {
  if (!usablePlan() || !state.plan.markdown || !formMatchesTask()) return;
  const url = URL.createObjectURL(new Blob([state.plan.markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = node('a');
  link.href = url;
  link.download = 'omni-task-context-' + state.agent + '.md';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

el('agent').addEventListener('change', () => {
  showError();
  state.agent = el('agent').value;
  state.filters.page = 1;
  state.catalog = null;
  renderCatalog();
  void Promise.all([loadCatalog(), runTask()]);
});

el('scope').addEventListener('change', () => {
  state.scope = el('scope').value;
  renderPlan();
  renderCatalog();
});

function applyFilters() {
  showError();
  state.filters = { query: el('catalog-query').value.trim(), filter: el('catalog-filter').value, page: 1 };
  void loadCatalog();
}

el('catalog-form').addEventListener('submit', event => {
  event.preventDefault();
  applyFilters();
});
el('catalog-filter').addEventListener('change', applyFilters);
el('disabled-link').addEventListener('click', () => {
  el('catalog-query').value = '';
  el('catalog-filter').value = 'disabled';
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
    el('project-name').textContent = project.name;
    el('agent').replaceChildren(...project.agents.map(id => {
      const option = node('option', '', agentLabels[id] ?? id);
      option.value = id;
      return option;
    }));
    if (!project.agents.includes(state.agent)) state.agent = project.agents[0];
    el('agent').value = state.agent;
    el('task-query').maxLength = project.limits.maxQueryLength;
    el('max-skills').max = project.limits.maxSkills;
    el('max-skills').defaultValue = project.limits.defaultMaxSkills;
    el('token-budget').max = project.limits.maxTokenBudget;
    el('token-budget').defaultValue = project.limits.defaultTokenBudget;
    state.ready = true;
    updateButtons();
    await loadCatalog();
  } catch (error) {
    showError(error.message);
    el('project-name').textContent = 'Project unavailable';
  }
}
void start();
