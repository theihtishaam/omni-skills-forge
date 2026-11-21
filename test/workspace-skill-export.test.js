import assert from 'node:assert/strict';
import test from 'node:test';
import { exportWorkspaceSkillMarkdown } from '../src/workspace-skill-export.js';

test('a portable skill includes the preview verbatim under safe, single-line frontmatter', () => {
  const draft = { title: 'Réview / React forms!', useWhen: 'Check "labels":\n---\nwhen editing forms', markdown: '# Review\n\nFocus the first invalid field.' };
  const text = exportWorkspaceSkillMarkdown(draft);
  const lines = text.split('\n');
  assert.equal(JSON.parse(lines[1].slice('name: '.length)), 'review-react-forms');
  assert.equal(JSON.parse(lines[2].slice('description: '.length)), 'Check "labels": --- when editing forms');
  assert.equal(lines.slice(3).join('\n'), '---\n\n' + draft.markdown + '\n');
  const international = exportWorkspaceSkillMarkdown({ ...draft, title: '文字' });
  assert.match(international, /name: "workspace-[0-9a-f]{12}"\n/u);
  assert.throws(() => exportWorkspaceSkillMarkdown({ ...draft, useWhen: 'a'.repeat(1025) }));
  assert.throws(() => exportWorkspaceSkillMarkdown({ ...draft, markdown: '' }));
});
