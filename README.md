# Omni Skills Forge

Find a useful skill without browsing all **50,009 files**. Open Omni in your project and it suggests a few skills for the work in that folder. You decide which skills your agent can use.

[![Total npm downloads](https://img.shields.io/npm/dt/omni-skills-forge?label=Total%20downloads&color=35836a)](https://www.npmjs.com/package/omni-skills-forge) · [GitHub repository](https://github.com/theihtishaam/omni-skills-forge)

## Open it in your project

With Node.js 18 or later, run these commands from your project folder.

```sh
npm install -g omni-skills-forge@latest
osf dashboard
```

1. **Find a skill.** Start with the workspace suggestions, or search the catalog and choose a category. There are 28 categories across six families.
2. **Choose what to use.** Click **All skills** to switch the whole catalog on or off. Each category has its own switch, and every skill row has one too. To use just one skill, turn **All skills** off and then turn that skill on. Choose a project or agent before making the change.
3. **Make one skill.** Check the skills you want to merge, or type what you need and let Omni pick relevant sources. Click **Make skill**. The saved result belongs to this workspace.

![Workspace suggestions above the catalog, with switches for all skills, a category and individual skill files](https://raw.githubusercontent.com/theihtishaam/omni-skills-forge/v2.3.1/assets/skills-dashboard.png)

In the sample workspace, switching everything off left **0** eligible files. Enabling one file brought that to **1**. Enabling the React category made its **2,401** files eligible, and switching the whole catalog on restored **50,009**. Only task matches are sent to the agent.

## Ask your agent

> Make one skill for reviewing keyboard accessibility and form submission in this React checkout.

With the Omni prompt hook connected in Codex or Claude Code, start a message with **“Make one skill for …”** and the new skill is saved in the workspace. A connected MCP agent can also call the maker directly. The same sentence works in the dashboard. If nothing matches, Omni asks for a more specific request. [Connect your agent](https://github.com/theihtishaam/omni-skills-forge/blob/v2.3.1/docs/TASK_SKILLS.md)

![One request made into a saved workspace skill with its source files](https://raw.githubusercontent.com/theihtishaam/omni-skills-forge/v2.3.1/assets/make-a-skill.png)

In the checkout example, Omni picked the React accessibility and form-handling guides and saved them as one skill. Repeating the request kept one copy. A later checkout review received the combined instructions. Turning off React stopped delivery on the next request.

![Agent prompt workflow. Two catalog sources became one saved skill. A later matching prompt received it, and a repeated creation request kept one copy.](https://raw.githubusercontent.com/theihtishaam/omni-skills-forge/v2.3.1/assets/agent-skill-flow.png)

The folder matters for ordinary requests too. “Review keyboard accessibility in this form” returned two guides in a React storefront and zero in an empty folder. A weather question in the same storefront also returned zero.

![Measured chart of skills returned for the same task with and without a recognized workspace, plus an unrelated request](https://raw.githubusercontent.com/theihtishaam/omni-skills-forge/v2.3.1/assets/workspace-comparison.png)

Prefer the terminal? Run `osf make "Review keyboard accessibility and form submission in React"` from the project. [Browse all categories](https://github.com/theihtishaam/omni-skills-forge/blob/v2.3.1/docs/CATEGORIES.md) · [Recorded example](https://github.com/theihtishaam/omni-skills-forge/blob/v2.3.1/docs/workspace-comparison.json) · [Reproduce the graphs](https://github.com/theihtishaam/omni-skills-forge/blob/v2.3.1/scripts/measure-workspace.mjs)

**Exactwork Skills** helps with longer jobs that need a plan, a review, and a handoff to the next session. [Explore Exactwork Skills](https://github.com/theihtishaam/exactwork-skills)

**Ihtisham Ahmad** builds Omni Skills Forge and Agent Shadow Brain. [Follow Ihtisham on GitHub](https://github.com/theihtishaam)
