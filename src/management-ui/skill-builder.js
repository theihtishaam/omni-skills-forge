const MAX_SOURCES = 5;

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function sourceName(skill) {
  const id = skill.name || skill.path.split('/').at(-1)?.replace(/\.md$/u, '') || skill.path;
  if (id.startsWith('react-accessibility-a11y-')) return 'React accessibility';
  if (id.startsWith('react-form-handling-')) return 'React form handling';
  const name = id.replace(/-(?:beginner|intermediate|advanced|expert)$/u, '').replace(/-/gu, ' ');
  return name[0].toUpperCase() + name.slice(1);
}

export function createSkillBuilder({ api, activeAgent, agentLabel, taskMatches, taskQuery, rerenderRows, refreshTask, download }) {
  const byId = id => document.getElementById(id);
  const format = new Intl.NumberFormat('en-US');
  const form = byId('studio-form');
  const sources = new Map();
  let library;
  let preview;
  let busy = false;
  let savedSignature;
  let savedId;
  let generation = 0;

  function draft() {
    return {
      title: byId('recipe-title').value.trim(),
      useWhen: byId('recipe-when').value.trim(),
      instructions: byId('recipe-instructions').value.trim(),
      sourcePaths: [...sources.keys()],
      agent: byId('recipe-scope').value === 'agent' ? activeAgent() : undefined,
      tokenBudget: byId('recipe-budget').valueAsNumber,
    };
  }

  function signature() {
    return JSON.stringify(draft());
  }

  function eligible(skill) {
    return skill.kind !== 'workspace' && !skill.path.startsWith('workspace/') && skill.eligibility !== 'disabled';
  }

  function report(error = '', status = '') {
    byId('studio-error').hidden = !error;
    byId('studio-error').textContent = error;
    byId('studio-status').textContent = status;
  }

  function update() {
    byId('recipe-scope').options[0].textContent = 'This agent (' + agentLabel(activeAgent()) + ')';
    const current = signature();
    const valid = preview?.signature === current;
    byId('preview-recipe').disabled = busy || sources.size === 0;
    byId('save-recipe').disabled = busy || !valid || savedSignature === current;
    byId('download-recipe').disabled = busy || !valid;
    byId('use-matches').disabled = busy || sources.size >= MAX_SOURCES ||
      !taskMatches().some(skill => eligible(skill) && !sources.has(skill.path));
    const code = byId('recipe-markdown');
    if (valid) {
      byId('recipe-preview-note').textContent = format.format(preview.estimatedTokens) +
        ' est. tokens · ' + preview.sourcePaths.length + ' source' + (preview.sourcePaths.length === 1 ? '' : 's') +
        (preview.fitsBudget === false ? '. Available to export. Shorten it or raise the context limit for automatic delivery.' : '');
      code.textContent = preview.portableMarkdown;
      code.hidden = false;
    } else {
      byId('recipe-preview-note').textContent = 'Preview the composition to see the Markdown and estimated context size.';
      code.hidden = true;
      code.textContent = '';
    }
  }

  function changeSources() {
    generation++;
    preview = undefined;
    report();
    const list = byId('source-list');
    byId('source-count').textContent = sources.size + ' / ' + MAX_SOURCES;
    if (!sources.size) {
      list.replaceChildren(node('p', 'field-note', 'Add a source from the skill catalog or task preview.'));
    } else {
      const choices = node('ul', 'studio-source-list');
      for (const skill of sources.values()) {
        const item = node('li');
        const details = node('div');
        details.append(node('strong', '', sourceName(skill)), node('br'), node('code', '', skill.path));
        const remove = node('button', 'secondary source-action', 'Remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove source ' + skill.path);
        remove.addEventListener('click', () => {
          sources.delete(skill.path);
          changeSources();
          byId('recipe-title').focus({ preventScroll: true });
        });
        item.append(details, remove);
        choices.append(item);
      }
      list.replaceChildren(choices);
    }
    update();
    rerenderRows();
  }

  function sourceAction(skill) {
    const picked = sources.has(skill.path);
    const button = node('button', 'secondary source-action', picked ? 'Remove source' : 'Add source');
    button.type = 'button';
    button.setAttribute('aria-label', (picked ? 'Remove' : 'Add') + ' source ' + skill.path);
    button.dataset.source = skill.path;
    button.disabled = !picked && (!eligible(skill) || sources.size >= MAX_SOURCES);
    if (!picked && !eligible(skill)) button.title = 'Source disabled by policy';
    else button.title = sourceName(skill);
    button.addEventListener('click', () => {
      if (sources.has(skill.path)) sources.delete(skill.path);
      else if (eligible(skill) && sources.size < MAX_SOURCES) sources.set(skill.path, skill);
      const rowList = button.closest('.skill-list');
      changeSources();
      [...rowList.querySelectorAll('[data-source]')]
        .find(control => control.dataset.source === skill.path)?.focus({ preventScroll: true });
    });
    return button;
  }

  function renderLibrary() {
    const list = byId('recipe-list');
    if (!library) return;
    if (!library.recipes.length) {
      list.replaceChildren(node('p', 'field-note', 'No workspace skills saved yet.'));
      return;
    }
    list.replaceChildren(...library.recipes.map(recipe => {
      const article = node('article', 'studio-recipe');
      const header = node('div', 'studio-source-heading');
      const details = node('div');
      details.append(node('h3', '', recipe.title), node('p', 'field-note', recipe.agent ? agentLabel(recipe.agent) : 'All agents'));
      const toggle = node('button', 'switch');
      toggle.type = 'button';
      toggle.dataset.recipe = recipe.id;
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', 'Enable ' + recipe.title);
      toggle.setAttribute('aria-checked', String(recipe.enabled));
      toggle.disabled = busy;
      const track = node('span', 'switch-track');
      track.setAttribute('aria-hidden', 'true');
      toggle.append(track, node('span', '', recipe.enabled ? 'Enabled' : 'Disabled'));
      toggle.addEventListener('click', () => void changeRecipe(recipe, false));
      const actions = node('div', 'studio-library-actions');
      const remove = node('button', 'secondary source-action', 'Remove');
      remove.type = 'button';
      remove.disabled = busy;
      remove.setAttribute('aria-label', 'Remove workspace skill ' + recipe.title);
      remove.addEventListener('click', () => {
        if (window.confirm('Remove the saved workspace skill “' + recipe.title + '”?')) void changeRecipe(recipe, true);
      });
      actions.append(toggle, remove);
      header.append(details, actions);
      const files = node('ul');
      for (const path of recipe.sourcePaths) {
        const item = node('li', 'small');
        item.append(node('code', '', path));
        files.append(item);
      }
      const description = node('p', 'field-note', recipe.useWhen);
      article.append(header, description, files);
      return article;
    }));
  }

  async function loadLibrary() {
    try {
      library = await api('/api/workspace-skills');
      renderLibrary();
    } catch (error) {
      byId('recipe-list').replaceChildren(node('p', 'studio-error', error.message));
    }
  }

  async function changeRecipe(recipe, remove) {
    if (!library || busy) return;
    report();
    busy = true;
    update();
    renderLibrary();
    try {
      library = await api('/api/workspace-skills/' + (remove ? 'remove' : 'status'), {
        id: recipe.id,
        enabled: !recipe.enabled,
        expectedRevision: library.revision,
      });
      if (remove && savedId === recipe.id) {
        savedId = undefined;
        savedSignature = undefined;
      }
      report('', recipe.title + (remove ? ' removed.' : recipe.enabled ? ' disabled.' : ' enabled.'));
      refreshTask();
    } catch (error) {
      report(error.message);
      if (error.status === 409) await loadLibrary();
    } finally {
      busy = false;
      update();
      renderLibrary();
      const remaining = [...byId('recipe-list').querySelectorAll('[data-recipe]')];
      const focus = remaining.find(button => button.dataset.recipe === recipe.id) ?? remaining[0] ?? byId('recipe-title');
      focus.focus({ preventScroll: true });
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!sources.size || busy) return;
    const input = draft();
    const submitted = JSON.stringify(input);
    const attempt = generation;
    busy = true;
    report();
    update();
    try {
      const result = await api('/api/workspace-skills/compose', input);
      if (attempt === generation && submitted === signature()) {
        preview = { ...result, signature: submitted };
      }
    } catch (error) {
      preview = undefined;
      report(error.message);
    } finally {
      busy = false;
      update();
    }
  });

  form.addEventListener('input', () => {
    generation++;
    report();
    update();
  });
  form.addEventListener('invalid', event => {
    if (event.target === byId('recipe-budget')) byId('recipe-budget-options').open = true;
  }, true);

  byId('save-recipe').addEventListener('click', async () => {
    if (busy || preview?.signature !== signature()) return;
    const input = draft();
    busy = true;
    report();
    update();
    try {
      library = await api('/api/workspace-skills/create', input);
      savedSignature = JSON.stringify(input);
      savedId = library.recipe.id;
      report('', 'Saved ' + input.title + '.');
      refreshTask();
    } catch (error) {
      report(error.message);
    } finally {
      busy = false;
      update();
      renderLibrary();
    }
  });

  byId('download-recipe').addEventListener('click', () => {
    if (!busy && preview?.signature === signature()) download(preview.portableMarkdown, 'SKILL.md');
  });

  byId('use-matches').addEventListener('click', () => {
    if (!byId('recipe-when').value.trim()) byId('recipe-when').value = taskQuery().slice(0, byId('recipe-when').maxLength);
    for (const skill of taskMatches()) {
      if (sources.size === MAX_SOURCES) break;
      if (eligible(skill)) sources.set(skill.path, skill);
    }
    changeSources();
  });

  return {
    loadLibrary,
    sourceAction,
    update,
    invalidate() {
      generation++;
      preview = undefined;
      update();
    },
  };
}
