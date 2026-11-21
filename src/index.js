/**
 * omni-skills-forge — Public API
 * Use programmatically or via CLI
 */

export { OmniInstaller } from './installer.js';
export { OmniUI } from './ui.js';
export { OmniDashboard } from './dashboard.js';
export { OmniDoctor } from './doctor.js';

export {
  describeCategoryEligibility, describeSkillEligibility, exportSkillContext,
  getCategoryEligibility, getSkillEligibility, loadSkillSelectionCatalog, loadSkillSelectionState,
  readCatalogSkill, recommendWorkspaceSkills, selectSkills, setAllSkillsState,
  setSkillCategoryState, setSkillSelectionState,
} from './skill-selection.js';
export { detectWorkspaceProfile } from './workspace-profile.js';
export { listSkillDeliveries } from './skill-delivery.js';
export {
  composeWorkspaceSkill, createWorkspaceSkill, listWorkspaceSkills,
  previewWorkspaceSkill, removeWorkspaceSkill, setWorkspaceSkillEnabled,
} from './workspace-skills.js';
export { exportWorkspaceSkillMarkdown } from './workspace-skill-export.js';
export { makeWorkspaceSkill, MAX_MAKE_WORKSPACE_INSTRUCTION_LENGTH } from './make-workspace-skill.js';
export const VERSION = '2.3.2';
export const SUPPORTED_TOOLS = ['claude-code', 'kilo', 'cline', 'opencode', 'cursor', 'windsurf'];
