#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import {
  SELECTION_AGENTS, exportSkillContext, resolveSkillProject, selectSkills,
  setSkillCategoryState, setSkillSelectionState,
} from '../src/skill-selection.js';

const VERSION = '2.3.1';

async function loadInstaller() {
  const { OmniInstaller } = await import('../src/installer.js');
  return new OmniInstaller();
}

function integerOption(value) {
  const number = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number)) {
    throw new Error('Expected a whole number.');
  }
  return number;
}

function agentOption(value) {
  if (!SELECTION_AGENTS.includes(value)) throw new Error(`Choose one of: ${SELECTION_AGENTS.join(', ')}.`);
  return value;
}

function showBanner() {
  const banner = gradient.rainbow.multiline(`
  ╔═══════════════════════════════════════════════════╗
  ║           ⚡ OMNI SKILLS FORGE ⚡                ║
  ║      50,000+ Expert AI Agent Skills              ║
  ║   Claude Code · Kilo · Cline · Opencode         ║
  ║        Cursor · Windsurf · & More                ║
  ╚═══════════════════════════════════════════════════╝`);
  console.log('\n' + banner + '\n');
}

const program = new Command();

program
  .name('omni-skills-forge')
  .description('Search, select, and install Markdown skills for coding agents')
  .version(VERSION)
  .addHelpText('before', () => { showBanner(); return ''; })
  .addHelpText('after', () => {
    console.log('');
    console.log(boxen(
      chalk.bold(' Quick Start:') + '\n\n' +
      chalk.cyan('  osf select "React accessibility testing"') + chalk.gray('  # Preview task matches') + '\n' +
      chalk.cyan('  osf dashboard --serve') + chalk.gray('  # Open project skill settings') + '\n' +
      chalk.cyan('  osf search "kubernetes"') + chalk.gray('        # Search skills') + '\n' +
      chalk.cyan('  osf doctor') + chalk.gray('                      # Diagnose environment'),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round', title: ' Examples ' }
    ));
    return '';
  });

// ── INSTALL ──
program
  .command('install')
  .alias('i')
  .description('Install skills to your AI tools')
  .option('-a, --all', 'Install all 50,000+ skills (single-click)')
  .option('-c, --category <name>', 'Install skills from a specific category')
  .option('-s, --skill <name>', 'Install a single specific skill by name')
  .option('--tag <tag>', 'Install all skills matching a tag')
  .option('--difficulty <level>', 'Install all skills at a difficulty level (beginner/intermediate/advanced/expert)')
  .option('-t, --tool <name>', 'Target a specific AI tool (claude-code, kilo, cline, opencode, cursor, windsurf, all-tools)')
  .option('-d, --dir <path>', 'Custom install directory')
  .option('-f, --force', 'Overwrite existing skills')
  .option('--dry-run', 'Preview what would be installed without writing files')
  .action(async (opts) => {
    showBanner();
    const installer = await loadInstaller();
    if (opts.all) {
      await installer.installAll(opts);
    } else if (opts.category) {
      await installer.installCategory(opts.category, opts);
    } else if (opts.skill) {
      await installer.installSkill(opts.skill, opts);
    } else if (opts.tag) {
      await installer.installByTag(opts.tag, opts);
    } else if (opts.difficulty) {
      await installer.installByDifficulty(opts.difficulty, opts);
    } else {
      const { OmniUI } = await import('../src/ui.js');
      const ui = new OmniUI(installer);
      await ui.runInteractive();
    }
  });

// ── UNINSTALL ──
program
  .command('uninstall')
  .aliases(['remove', 'rm'])
  .description('Remove installed skills from AI tools')
  .option('-t, --tool <name>', 'Target a specific AI tool')
  .option('--dry-run', 'Preview what would be removed')
  .action(async (opts) => {
    showBanner();
    const installer = await loadInstaller();
    await installer.uninstall(opts);
  });

// ── LIST ──
program
  .command('list')
  .aliases(['ls'])
  .description('List available skills')
  .option('-c, --category <name>', 'Filter by category')
  .option('--tag <tag>', 'Filter by tag')
  .option('--difficulty <level>', 'Filter by difficulty')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const installer = await loadInstaller();
    await installer.listSkills(opts);
  });

// ── SEARCH ──
program
  .command('search')
  .aliases(['s'])
  .description('Search across all 50,000+ skills')
  .argument('<query>', 'Search query')
  .option('-l, --limit <n>', 'Max results', '25')
  .action(async (query, opts) => {
    const installer = await loadInstaller();
    await installer.searchSkills(query, opts);
  });

program
  .command('select')
  .description('Preview relevant skills for a task or export a bounded Markdown context pack')
  .argument('<query>', 'Task description')
  .option('--project <dir>', 'Project directory')
  .option('--directory <dir>', 'Relative workspace folder for technology signals')
  .option('--agent <id>', 'Apply an agent’s project preferences', agentOption)
  .option('--token-budget <n>', 'Estimated input token budget', integerOption)
  .option('--max-skills <n>', 'Maximum selected skills', integerOption)
  .option('-o, --output <file>', 'Write a new Markdown context pack inside the project')
  .option('--json', 'Show selection metadata as JSON')
  .action(async (query, options) => {
    const selection = options.output
      ? await exportSkillContext({ ...options, query })
      : await selectSkills({ ...options, query });
    const { markdown, ...summary } = selection;
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      for (const technology of summary.workspace.technologies) {
        const filenames = technology.sources.map(({ directory, file }) =>
          directory === '.' ? file : `${directory}/${file}`).join(', ');
        console.log(`${technology.name} detected in ${filenames} for workspace ${summary.workspace.directory}.`);
      }
      if (!summary.matches.length) console.log('No catalog skills matched within the requested limits.');
      else {
        for (const match of summary.matches) {
          const label = match.kind === 'workspace' ? `${match.name} (${match.path})` : match.path;
          console.log(`${label} (~${match.estimatedTokens} tokens)\n  ${match.reason}`);
        }
        console.log(`This pack uses an estimated ${summary.estimatedTokens} of ${summary.tokenBudget} input tokens.`);
      }
      if (summary.output) console.log(`Wrote ${summary.output}`);
    }
  });

for (const [command, status, description] of [
  ['enable', 'enabled', 'Allow a matching catalog skill or category'],
  ['disable', 'disabled', 'Exclude a catalog skill or category from task selection'],
  ['reset-skill', 'default', 'Restore default eligibility for a catalog skill or category'],
]) {
  program.command(command)
    .description(description)
    .argument('[skill-path]', 'Exact relative path shown in the catalog')
    .option('--category <category>', 'Exact catalog category path or family')
    .option('--project <dir>', 'Project directory')
    .option('--agent <id>', 'Limit this preference to one agent', agentOption)
    .action(async (skillPath, { category, project, agent }) => {
      if (Boolean(skillPath) === Boolean(category)) throw new Error('Choose one skill path or use --category.');
      const options = { project, agent, status };
      const { revision } = category
        ? await setSkillCategoryState({ ...options, category })
        : await setSkillSelectionState({ ...options, path: skillPath });
      console.log(`${category || skillPath} is ${status} for ${agent || 'all agents'} at revision ${revision}.`);
    });
}

program
  .command('mcp')
  .description('Start the task skill selection MCP server over stdio')
  .option('--project <dir>', 'Project directory')
  .requiredOption('--agent <id>', 'Agent using the MCP server', agentOption)
  .action(async options => {
    const { runSkillMcp } = await import('../src/skill-mcp.js');
    await runSkillMcp(options);
  });

program
  .command('hook')
  .description('Read a prompt hook event from stdin and return relevant context to the host')
  .option('--project <dir>', 'Project directory')
  .requiredOption('--agent <id>', 'Agent sending the prompt hook event', agentOption)
  .option('--token-budget <n>', 'Estimated input token budget', integerOption)
  .option('--max-skills <n>', 'Maximum selected skills', integerOption)
  .action(async options => {
    const { runPromptHook } = await import('../src/skill-prompt-hook.js');
    await runPromptHook(options);
  });

// ── INFO ──
program
  .command('info')
  .description('Show detailed info about a specific skill')
  .argument('<name>', 'Skill name')
  .action(async (name) => {
    const installer = await loadInstaller();
    await installer.showSkillInfo(name);
  });

// ── CATEGORIES ──
program
  .command('categories')
  .aliases(['cats'])
  .description('Browse all skill categories')
  .action(async () => {
    const installer = await loadInstaller();
    await installer.listCategories();
  });

// ── STATS ──
program
  .command('stats')
  .description('Show library statistics')
  .action(async () => {
    showBanner();
    const installer = await loadInstaller();
    await installer.showStats();
  });

// ── DASHBOARD ──
program
  .command('dashboard')
  .aliases(['ui', 'web'])
  .description('Open skills for the current workspace, or export an HTML catalog with --output')
  .option('-o, --output <path>', 'Output HTML file path')
  .option('--no-open', 'Print the address or output path without opening a browser')
  .option('--serve', 'Serve project skill settings on localhost')
  .option('--project <dir>', 'Project directory for the management dashboard')
  .option('--port <n>', 'Management dashboard port (0 chooses a free port)', integerOption)
  .action(async (opts) => {
    let destination;
    if (opts.serve || !opts.output) {
      const { startManagementDashboard } = await import('../src/management-dashboard.js');
      const projectRoot = await resolveSkillProject(opts.project);
      const { url, close } = await startManagementDashboard({ projectRoot, port: opts.port });
      destination = url;
      console.log(`Omni Skills Forge dashboard: ${url}`);
      process.once('SIGINT', () => void close());
      process.once('SIGTERM', () => void close());
    } else {
      showBanner();
      const installer = await loadInstaller();
      const { OmniDashboard } = await import('../src/dashboard.js');
      const dashboard = new OmniDashboard(await installer._loadRegistry());
      destination = await dashboard.generate(opts);
    }
    if (opts.open !== false) {
      try {
        const { default: open } = await import('open');
        await open(destination);
      } catch {
        console.log(chalk.yellow(`  Could not auto-open. Open manually: ${destination}`));
      }
    }
  });

// ── DOCTOR ──
program
  .command('doctor')
  .aliases(['check', 'diagnose'])
  .description('Diagnose your environment and tool installations')
  .action(async () => {
    const { OmniDoctor } = await import('../src/doctor.js');
    const doctor = new OmniDoctor();
    await doctor.run();
  });

// ── EXPORT ──
program
  .command('export')
  .aliases(['exp'])
  .description('Export skills registry to JSON, CSV, or Markdown')
  .option('-f, --format <type>', 'Export format: json, csv, md', 'json')
  .option('-o, --output <path>', 'Output file path')
  .action(async (opts) => {
    showBanner();
    const installer = await loadInstaller();
    await installer.exportSkills(opts);
  });

// ── UPDATE ──
program
  .command('update')
  .aliases(['u'])
  .description('Update to the latest skill library')
  .action(async () => {
    showBanner();
    console.log(chalk.cyan('Checking for updates...'));
    console.log(chalk.green(`You are on version ${VERSION}`));
    console.log(chalk.gray('Run: npm update -g omni-skills-forge'));
  });

program
  .command('make <instruction>')
  .alias('generate')
  .description('Make one workspace skill from a plain-language request')
  .option('--project <dir>', 'Project folder', process.cwd())
  .option('--directory <folder>', 'Folder inside the project')
  .option('--agent <name>', 'Limit this skill to one agent', agentOption)
  .action(async (instruction, opts) => {
    const { makeWorkspaceSkill } = await import('../src/make-workspace-skill.js');
    const result = await makeWorkspaceSkill({ project: opts.project, directory: opts.directory,
      agent: opts.agent, instruction, scope: opts.agent ? 'agent' : 'project' });
    if (!result.recipe) {
      console.log(result.reason);
      return;
    }
    console.log((result.created ? 'Saved ' : 'Found ') + result.recipe.title);
    for (const source of result.sources) console.log('  ' + source.path);
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
