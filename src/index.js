/**
 * omni-skills-forge — Public API
 * Use programmatically or via CLI
 */

export { OmniInstaller } from './installer.js';
export { OmniUI } from './ui.js';
export { OmniDashboard } from './dashboard.js';
export { OmniDoctor } from './doctor.js';

export { loadSkillSelectionState, setSkillSelectionState, selectSkills, exportSkillContext, recommendWorkspaceSkills } from './skill-selection.js';
export { detectWorkspaceProfile } from './workspace-profile.js';
export { listSkillDeliveries } from './skill-delivery.js';
export const VERSION = '2.3.0';
export const SUPPORTED_TOOLS = ['claude-code', 'kilo', 'cline', 'opencode', 'cursor', 'windsurf'];
