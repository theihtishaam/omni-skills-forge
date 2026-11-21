const el = id => document.getElementById(id);
const agentLabels = {
  codex: 'Codex', 'claude-code': 'Claude Code', cursor: 'Cursor', cline: 'Cline',
  kilo: 'Kilo', opencode: 'OpenCode', windsurf: 'Windsurf', portable: 'Portable',
};
const labels = {
  'ai-ml': 'AI & ML', 'web-dev': 'Web development', 'computer-vision': 'Computer vision',
  cicd: 'CI/CD', csharp: 'C#', gcp: 'Google Cloud', aws: 'AWS', llm: 'LLMs', mlops: 'MLOps',
  nextjs: 'Next.js', nodejs: 'Node.js', nosql: 'NoSQL', rag: 'RAG', sql: 'SQL',
};
const sourceLabels = new Map([
  ['web-dev/react/react-accessibility-a11y-advanced-intermediate.md', 'React accessibility'],
  ['web-dev/react/react-form-handling-advanced-intermediate.md', 'React form handling'],
]);
const number = new Intl.NumberFormat();
const listNames = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' });
const maximumSources = 5;
const state = {
  ready: false,
  agent: '',
  scope: 'agent',
  directory: '.',
  revision: null,
  catalog: null,
  workspace: null,
  library: null,
  result: null,
  picks: new Map(),
  query: '',
  category: '',
  page: 1,
  busy: false,
  catalogRequest: 0,
  workspaceRequest: 0,
  catalogLoading: true,
  workspaceLoading: true,
};

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function categoryName(category) {
  return category.split('/').map(part => labels[part] ?? part[0].toUpperCase() + part.slice(1)).join(' / ');
}

function skillName(skill) {
  const readable = sourceLabels.get(skill.path);
  if (readable) return readable;
  const name = (skill.name || skill.path.split('/').at(-1))
    .replace(/\.md$/u, '')
    .replace(/-(?:beginner|intermediate|advanced|expert)$/u, '')
    .replace(/-/gu, ' ')
    .replace(/\baccessibility a11y\b/giu, 'accessibility')
    .replace(/\ba11y\b/giu, 'accessibility')
    .replace(/\btypescript\b/giu, 'TypeScript')
    .replace(/\bapi\b/giu, 'API');
  return name[0].toUpperCase() + name.slice(1);
}

async function api(route, data) {
  const options = data ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  } : {};
  let response;
  try {
    response = await fetch(route, options);
  } catch {
    throw new Error('Could not reach this local dashboard.');
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

function notice(message = '') {
  el('notice').textContent = message;
  el('notice').hidden = !message;
}

function editingProject() {
  return !state.agent || state.scope === 'project';
}

function rememberRevision(revision) {
  state.revision = Math.max(state.revision ?? 0, revision);
}

function updateControls() {
  const canMake = el('instruction').value.trim() || state.picks.size;
  el('make-skill').disabled = !state.ready || state.busy || state.workspaceLoading || !canMake;
  el('inspect-folder').disabled = !state.ready || state.busy || state.workspaceLoading;
  el('agent').disabled = !state.ready || state.busy;
  el('catalog-category').disabled = !state.ready || state.busy;
  el('scope').disabled = state.busy;
  el('scope-label').hidden = !state.agent;
  el('catalog-list').setAttribute('aria-busy', String(state.catalogLoading));
  el('suggested-list').setAttribute('aria-busy', String(state.workspaceLoading));
  el('previous').disabled = state.busy || state.catalogLoading || !state.catalog || state.catalog.page <= 1;
  el('next').disabled = state.busy || state.catalogLoading || !state.catalog ||
    state.catalog.page * state.catalog.pageSize >= state.catalog.total;
}

function toggle(label, enabled, disabled, onClick) {
  const button = node('button', 'switch');
  button.type = 'button';
  button.disabled = disabled;
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-checked', String(enabled));
  const track = node('span', 'switch-track');
  track.setAttribute('aria-hidden', 'true');
  button.append(track, node('span', '', enabled ? 'Enabled' : 'Disabled'));
  button.addEventListener('click', onClick);
  return button;
}

function blockMessage(rule) {
  const agent = rule.scope === 'project' ? 'all agents' : agentLabels[state.agent];
  return rule.category ? 'Blocked by ' + categoryName(rule.category) + ' for ' + agent : 'Disabled for ' + agent;
}

function preference(entry, revision, isCategory) {
  const project = editingProject();
  const value = project ? entry.projectStatus : entry.agentStatus;
  const block = project ? entry.projectBlock : entry.agentBlock;
  const enabled = value !== 'disabled' && !block;
  const fresh = !state.busy && revision === state.revision;
  const name = isCategory ? categoryName(entry.category) : skillName(entry);
  const key = isCategory ? entry.category : entry.path;
  const container = node('div', isCategory ? 'category-switch' : 'skill-control');
  if (isCategory) container.append(node('strong', '', name));
  const scopeName = project ? 'all agents' : agentLabels[state.agent];
  const change = toggle('Allow ' + name + ' for ' + scopeName, enabled, !fresh || Boolean(block),
    () => void savePreference(key, isCategory, enabled ? 'disabled' : 'enabled'));
  change.dataset.policy = key;
  container.append(change);
  if (value !== 'default') {
    const reset = node('button', 'reset', 'Reset');
    reset.type = 'button';
    reset.disabled = !fresh;
    reset.setAttribute('aria-label', 'Reset ' + name + ' preference');
    reset.addEventListener('click', () => void savePreference(key, isCategory, 'default'));
    container.append(reset);
  }
  const rule = block || (project && enabled && entry.effective.status === 'disabled' ? entry.effective : null);
  if (rule) container.append(node('span', 'policy-reason', blockMessage(rule)));
  return container;
}

function checkbox(skill, location) {
  const input = node('input');
  input.type = 'checkbox';
  input.dataset.source = skill.path;
  input.checked = state.picks.has(skill.path);
  input.disabled = state.busy || (!input.checked && (skill.eligibility === 'disabled' || state.picks.size >= maximumSources));
  input.setAttribute('aria-label', 'Pick ' + skillName(skill) +
    (location === 'catalog' && skill.difficulty ? ' (' + skill.difficulty + ')' : ''));
  input.addEventListener('change', () => {
    if (!input.checked) state.picks.delete(skill.path);
    else if (state.picks.size < maximumSources) state.picks.set(skill.path, skill);
    renderPicks();
    renderCatalog();
    renderSuggestions();
    const list = el(location === 'catalog' ? 'catalog-list' : 'suggested-list');
    [...list.querySelectorAll('[data-source]')].find(other => other.dataset.source === skill.path)?.focus({ preventScroll: true });
  });
  return input;
}

function renderSuggestions() {
  const list = el('suggested-list');
  if (state.workspaceLoading) {
    list.replaceChildren(node('p', 'muted', 'Finding skills…'));
  } else if (!state.workspace?.suggestions.length) {
    list.replaceChildren(node('p', 'muted', 'No suggestions for this folder.'));
  } else {
    list.replaceChildren(...state.workspace.suggestions.map(skill => {
      const item = node('label', 'suggestion');
      item.title = skill.path;
      item.append(checkbox(skill, 'suggested'), node('span', '', skillName(skill)));
      return item;
    }));
  }
  updateControls();
}

function renderCatalog() {
  const result = state.catalog;
  const list = el('catalog-list');
  const category = el('category-preference');
  category.replaceChildren();
  if (state.catalogLoading || !result) {
    list.replaceChildren(node('p', 'empty', state.catalogLoading ? 'Finding skills…' : 'Search to load the catalog.'));
    el('page-summary').textContent = '';
  } else {
    if (result.categoryPreference) category.append(preference(result.categoryPreference, result.revision, true));
    if (result.items.length === 0) {
      list.replaceChildren(node('p', 'empty', 'No skills match this search.'));
      el('page-summary').textContent = '';
    } else {
      list.replaceChildren(...result.items.map(skill => {
        const row = node('article', 'skill-row');
        const choice = node('label', 'skill-label');
        choice.title = skill.path;
        const details = node('span');
        details.append(
          node('span', 'skill-name', skillName(skill)),
          node('span', 'skill-meta', categoryName(skill.category) + ' · ' + skill.difficulty),
        );
        choice.append(checkbox(skill, 'catalog'), details);
        row.append(choice, preference(skill, result.revision, false));
        return row;
      }));
      const start = (result.page - 1) * result.pageSize + 1;
      el('page-summary').textContent = number.format(start) + '–' + number.format(start + result.items.length - 1) +
        ' of ' + number.format(result.total);
    }
  }
  updateControls();
}

function renderPicks() {
  const list = el('selected-sources');
  const count = el('picked-count');
  count.hidden = state.picks.size === 0;
  count.textContent = state.picks.size + ' picked';
  el('selection').hidden = state.picks.size === 0;
  list.replaceChildren(...[...state.picks.values()].map(skill => {
    const item = node('li');
    const name = skillName(skill);
    const label = node('span', '', name);
    label.title = skill.path;
    const remove = node('button', 'secondary', 'Remove');
    remove.type = 'button';
    remove.disabled = state.busy;
    remove.setAttribute('aria-label', 'Remove ' + name);
    remove.addEventListener('click', () => {
      state.picks.delete(skill.path);
      renderPicks();
      renderCatalog();
      renderSuggestions();
      el('instruction').focus({ preventScroll: true });
    });
    item.append(label, remove);
    return item;
  }));
  updateControls();
}

function renderSaved() {
  const list = el('saved-list');
  const visible = state.library?.recipes.filter(recipe => !state.agent || !recipe.agent || recipe.agent === state.agent);
  if (!visible?.length) {
    list.replaceChildren(node('p', 'muted', 'No saved skills yet.'));
    return;
  }
  list.replaceChildren(...visible.map(recipe => {
    const item = node('article', 'saved-item');
    const text = node('div');
    const label = recipe.agent ? agentLabels[recipe.agent] ?? recipe.agent : 'All agents';
    text.append(node('h3', '', recipe.title), node('p', 'skill-meta', label));
    const actions = node('div', 'saved-actions');
    const change = toggle('Enable ' + recipe.title, recipe.enabled, state.busy, () => void changeRecipe(recipe, false));
    change.dataset.recipe = recipe.id;
    const remove = node('button', 'reset', 'Remove');
    remove.type = 'button';
    remove.disabled = state.busy;
    remove.setAttribute('aria-label', 'Remove saved skill ' + recipe.title);
    remove.addEventListener('click', () => {
      if (window.confirm('Remove the saved skill “' + recipe.title + '”?')) void changeRecipe(recipe, true);
    });
    actions.append(change, remove);
    item.append(text, actions);
    return item;
  }));
}

function renderResult() {
  el('result').hidden = !state.result?.recipe;
  if (!state.result?.recipe) return;
  el('result-title').textContent = (state.result.created ? 'Made ' : 'Saved skill: ') + state.result.recipe.title;
  el('result-sources').textContent = 'From ' + listNames.format(state.result.sources.map(skillName)) +
    (state.result.reason ? '. ' + state.result.reason : '');
  el('download-skill').hidden = !state.result.portableMarkdown;
}

function setBusy(busy) {
  state.busy = busy;
  renderPicks();
  renderCatalog();
  renderSuggestions();
  renderSaved();
}

async function loadCatalog(retry = true) {
  const attempt = ++state.catalogRequest;
  state.catalogLoading = true;
  renderCatalog();
  try {
    const params = new URLSearchParams({ agent: state.agent, category: state.category, query: state.query, page: state.page });
    const result = await api('/api/catalog?' + params);
    if (attempt !== state.catalogRequest) return;
    if (retry && result.revision < (state.revision ?? 0)) return loadCatalog(false);
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (result.page > lastPage) {
      state.page = lastPage;
      return loadCatalog();
    }
    state.catalog = result;
    rememberRevision(result.revision);
  } catch (error) {
    if (attempt === state.catalogRequest) {
      state.catalog = null;
      notice(error.message);
    }
  } finally {
    if (attempt === state.catalogRequest) {
      state.catalogLoading = false;
      renderCatalog();
    }
  }
}

async function loadWorkspace(directory, submitted = false, retry = true) {
  const attempt = ++state.workspaceRequest;
  state.workspaceLoading = true;
  renderSuggestions();
  try {
    const result = await api('/api/workspace', { directory, agent: state.agent || undefined });
    if (attempt !== state.workspaceRequest) return;
    if (retry && result.revision < (state.revision ?? 0)) return loadWorkspace(directory, submitted, false);
    state.workspace = result;
    state.directory = result.workspace.directory;
    el('workspace-folder').textContent = state.directory;
    if (submitted) {
      el('folder-path').value = state.directory;
      el('folder-control').open = false;
      el('folder-control').querySelector('summary').focus({ preventScroll: true });
    }
    rememberRevision(result.revision);
  } catch (error) {
    if (attempt === state.workspaceRequest) notice(error.message);
  } finally {
    if (attempt === state.workspaceRequest) {
      state.workspaceLoading = false;
      renderSuggestions();
      if (state.catalog && state.catalog.revision !== state.revision && !state.catalogLoading) void loadCatalog();
    }
  }
}

async function loadLibrary(announceError = true) {
  try {
    state.library = await api('/api/workspace-skills');
    renderSaved();
  } catch (error) {
    if (announceError) notice(error.message);
  }
}

async function savePreference(key, isCategory, status) {
  if (state.busy) return;
  notice();
  const categoryRoute = isCategory ? '/api/category-preferences' : '/api/preferences';
  const target = isCategory ? { category: key } : { path: key };
  setBusy(true);
  try {
    const result = await api(categoryRoute, {
      ...target, status, agent: editingProject() ? undefined : state.agent, expectedRevision: state.revision,
    });
    rememberRevision(result.revision);
  } catch (error) {
    notice(error.message);
  } finally {
    await Promise.all([loadCatalog(), loadWorkspace(state.directory)]);
    setBusy(false);
    const button = [...document.querySelectorAll('[data-policy]')].find(control => control.dataset.policy === key);
    (button?.disabled === false ? button : el('catalog-category')).focus({ preventScroll: true });
  }
}

async function changeRecipe(recipe, removed) {
  if (state.busy || !state.library) return;
  notice();
  setBusy(true);
  try {
    state.library = await api('/api/workspace-skills/' + (removed ? 'remove' : 'status'), {
      id: recipe.id, enabled: !recipe.enabled, expectedRevision: state.library.revision,
    });
    if (removed && state.result?.recipe.id === recipe.id) {
      state.result = null;
      renderResult();
    }
    el('status').textContent = recipe.title + (removed ? ' removed.' : recipe.enabled ? ' disabled.' : ' enabled.');
  } catch (error) {
    notice(error.message);
    if (error.status === 409) await loadLibrary(false);
  } finally {
    setBusy(false);
    const button = [...el('saved-list').querySelectorAll('[data-recipe]')].find(control => control.dataset.recipe === recipe.id);
    (button ?? el('instruction')).focus({ preventScroll: true });
  }
}

function pickCategories(groups) {
  for (const group of groups) {
    const options = node('optgroup');
    options.label = categoryName(group.family);
    const family = node('option', '', 'All ' + options.label);
    family.value = group.family;
    options.append(family);
    for (const category of group.categories) {
      const entry = node('option', '', categoryName(category.split('/').at(-1)));
      entry.value = category;
      options.append(entry);
    }
    el('catalog-category').append(options);
  }
}

function applyFilters() {
  notice();
  state.query = el('catalog-query').value.trim();
  state.category = el('catalog-category').value;
  state.page = 1;
  void loadCatalog();
}

el('catalog-form').addEventListener('submit', event => {
  event.preventDefault();
  applyFilters();
});
el('catalog-category').addEventListener('change', applyFilters);
for (const [id, change] of [['previous', -1], ['next', 1]]) {
  el(id).addEventListener('click', () => {
    state.page += change;
    void loadCatalog();
  });
}
el('scope').addEventListener('change', () => {
  state.scope = el('scope').value;
  renderCatalog();
});
el('agent').addEventListener('change', () => {
  notice();
  state.agent = el('agent').value;
  renderSaved();
  void Promise.all([loadCatalog(), loadWorkspace(state.directory)]);
});
el('folder-form').addEventListener('submit', event => {
  event.preventDefault();
  notice();
  void loadWorkspace(el('folder-path').value.trim(), true);
});
el('instruction').addEventListener('input', updateControls);
el('make-form').addEventListener('submit', async event => {
  event.preventDefault();
  const instruction = el('instruction').value.trim();
  if (state.busy || (!instruction && !state.picks.size)) return;
  notice();
  state.result = null;
  renderResult();
  setBusy(true);
  el('make-note').textContent = 'Making your skill…';
  try {
    const result = await api('/api/make-skill', {
      directory: state.directory,
      agent: state.agent || undefined,
      scope: editingProject() ? 'project' : undefined,
      instruction,
      sourcePaths: [...state.picks.keys()],
    });
    state.result = result;
    renderResult();
    if (result.recipe) {
      await loadLibrary(false);
      el('status').textContent = result.recipe.title + ' is ready.';
    }
    else notice(result.reason || 'Try a more specific skill or pick a catalog skill.');
  } catch (error) {
    notice(error.message);
    if (error.status === 409) await Promise.all([loadCatalog(), loadWorkspace(state.directory)]);
  } finally {
    el('make-note').textContent = 'Describe a skill or choose up to five from the catalog.';
    setBusy(false);
  }
});
el('download-skill').addEventListener('click', () => {
  if (!state.result?.portableMarkdown) return;
  const url = URL.createObjectURL(new Blob([state.result.portableMarkdown], { type: 'text/markdown;charset=utf-8' }));
  const link = node('a');
  link.href = url;
  link.download = 'SKILL.md';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

async function start() {
  try {
    const project = await api('/api/project');
    el('project-name').textContent = project.name;
    el('instruction').maxLength = project.limits.maxMakeInstructionLength;
    for (const agent of project.agents) {
      const option = node('option', '', agentLabels[agent] ?? agent);
      option.value = agent;
      el('agent').append(option);
    }
    pickCategories(project.categoryGroups);
    state.ready = true;
    updateControls();
    await Promise.all([loadCatalog(), loadWorkspace('.'), loadLibrary()]);
  } catch (error) {
    notice(error.message);
  }
}
void start();
