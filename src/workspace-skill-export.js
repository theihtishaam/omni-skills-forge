import { createHash } from 'node:crypto';

/** Build a portable SKILL.md from the eligible guidance shown in the workspace preview. */
export function exportWorkspaceSkillMarkdown({ title, useWhen, markdown }) {
  if (![title, useWhen, markdown].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('Preview a named skill with guidance before exporting.');
  }
  const readableName = title.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').slice(0, 64).replace(/^-+|-+$/gu, '');
  const name = readableName || 'workspace-' + createHash('sha256').update(title).digest('hex').slice(0, 12);
  const description = useWhen.trim().replace(/\s+/gu, ' ');
  if (Array.from(description).length > 1024) throw new Error('Keep the skill description within 1,024 characters.');
  return ['---', 'name: ' + JSON.stringify(name), 'description: ' + JSON.stringify(description),
    '---', '', markdown.trim(), ''].join('\n');
}
