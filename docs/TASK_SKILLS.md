# Give an agent the skills for its current task

Open `osf dashboard --serve --project .` in the folder where you work. Choose an agent. For a repository with multiple apps, enter a relative folder and choose **Inspect folder**. The dashboard shows which technology it found, the manifest behind that match and a few skills on standby. Enter a task to preview a selection. The CLI, prompt hook and MCP tool use the same selector and project preferences.

Workspace detection checks known project files in the chosen directory and walks up to the project boundary for the nearest recognizable stack. For example, a React dependency in `apps/storefront/package.json` can resolve an ambiguous form-review task inside `apps/storefront/src`. An explicit technology in the request takes priority. In a project without a recognized manifest, name the technology in the task. The detector uses filenames and known manifest keys and runs no project scripts.

## Choose who can use a skill

The **Skill catalog** category dropdown groups 28 topics into six families. Pick a family such as DevOps, or a topic such as Docker. You can search and page through its skills before changing any preferences. The category switch applies to the scope selected on the left. A switch beside an individual row applies to that file.

For example, turn off `devops/docker` for Codex to skip Docker guidance while keeping Kubernetes available. Turn off `devops` for all agents to exclude the whole family in this project. A narrower switch cannot reopen a category or family blocked by a wider rule. Re-enable the blocking category at the displayed scope to make its skills eligible again. A task still has to match before the agent receives guidance.

```sh
osf disable --category devops/docker --agent codex --project .
osf enable --category devops/docker --agent codex --project .
```

In **Skill catalog**, use **This agent** to change one agent's preference, or **All agents** for a project-wide choice. Disabling a skill for the project excludes it across agents. Enabling it makes it eligible when its topic matches. Changing a preference affects the next selection. A host can retain context it already received.

The CLI takes the exact catalog path shown on a skill. For example:

```sh
osf disable web-dev/react/react-accessibility-a11y-best-practices-intermediate.md --project . --agent claude-code
osf select "Review keyboard accessibility in this form" --project . --directory apps/storefront --agent codex
```

The default pack limit is three skills and 2,400 estimated tokens. The estimate uses the complete rendered Markdown, including paths, headings and match reasons. The same request with the same preferences and installed catalog produces the same selection. The picker can return fewer skills or none. An empty result contributes zero skill text.

## Build a skill for recurring work

To give recurring work its own skill, pick up to five source files in the dashboard. Give the skill a name and a specific **When to use** sentence. “Review keyboard access and failed submission on a checkout form” is more informative than “Help with this project.” Add any project-specific instructions, preview the combined Markdown and choose its scope before saving.

Omni builds the guidance locally from your selected sources. Its automatic picker checks the task, the saved skill’s scope and the current rules for every source. A disabled source makes the entire combination ineligible. A combination that does not fit the available context is skipped. Successful delivery counts as one skill and keeps the source paths in the Markdown.

**Download SKILL.md** exports the preview with a name and description. For a host supporting the Agent Skills format, put that file in a folder matching the exported `name`. Your saved workspace skill continues to follow Omni’s current preferences. The exported copy is managed by its destination. [Agent Skills format](https://agentskills.io/specification)

## Run automatically on a submitted prompt

Install the CLI with `npm install -g omni-skills-forge` and make sure `osf --version` works in your agent's shell. In a trusted project, add the following entry to the host's existing hook configuration. Keep any hooks already present. Replace the example path with your project's absolute path. Quote it for your host's shell if it contains spaces.

**Claude Code** reads project-local hooks from `.claude/settings.local.json`. For **Codex**, use `.codex/hooks.json` and change `--agent claude-code` to `--agent codex`. Review or trust the hook in the host when prompted. [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Codex hooks](https://developers.openai.com/codex/hooks)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "osf hook --agent claude-code --project /work/checkout"
          }
        ]
      }
    ]
  }
}
```

The hook uses the visible prompt and working directory supplied by the host. It emits the selected guidance for that turn and produces no output for an unrelated prompt or a directory outside the chosen project. Omni does not save the prompt or open native transcript files. Removing the entry stops future hook deliveries.

## Let a compatible agent ask for a pack over MCP

For on-demand selection, configure `osf mcp --agent <agent> --project <absolute-project-path>` as a local stdio server. The agent calls `select_skills` with a task and can supply a relative `directory` inside that project. Use one delivery route per host so the same skills reach its prompt once.

Here is a Codex entry for `.codex/config.toml`. Using the absolute Node executable and installed CLI file also works on Windows installations where the MCP launcher can't execute an npm command shim. Run `npm root -g` to locate the global package directory, then append `omni-skills-forge/bin/cli.js`. Replace each example path with its local equivalent.

```toml
[mcp_servers.omni_skills]
command = "/path/to/node"
args = ["/path/to/omni-skills-forge/bin/cli.js", "mcp", "--project", "/work/checkout", "--agent", "codex"]
```

For Claude Code, merge an entry into the project's `.mcp.json` instead:

```json
{
  "mcpServers": {
    "omni_skills": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/omni-skills-forge/bin/cli.js", "mcp", "--project", "/work/checkout", "--agent", "claude-code"]
    }
  }
}
```

Restart or reconnect the host as needed. Ask it to use `select_skills` for the current task. For example, it can submit `{"query":"Review keyboard accessibility in this form","directory":"apps/storefront"}`. The server fixes the project and agent at startup. [Codex MCP configuration](https://developers.openai.com/codex/mcp) · [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)

## Check what reached an agent

Choose the agent in the dashboard and open **Delivered context**. Omni refreshes this list while the page is open. You can also click **Refresh**. Each receipt records the delivery time, agent, route, relative folder and catalog paths. Omni keeps the latest 64 receipts for the project under `.omni-skills-forge/deliveries/`. The task text and skill bodies stay out of the receipts. Catalog browsing, task preview and unrelated prompts leave the list unchanged. The list measures guidance returned by Omni. Your host controls model execution and billing.

## When Exactwork helps

A migration that spans several sessions needs more than a database skill. It also needs a clear acceptance test, a record of what changed and a handoff the next agent can trust. Exactwork provides portable skills for that execution, research and review process. Start with its core skill. Add a companion when the work calls for one. [Exactwork skills and installation](https://github.com/theihtishaam/exactwork-skills)
