# Give an agent the skills for its current task

Open `osf dashboard --serve --project .` in the folder where you work. Choose an agent, describe a task and preview the pack. The same selection powers the CLI, the prompt hook and the MCP tool. They all read the preferences for the project supplied at launch.

## Choose who can use a skill

In **Skill catalog**, use **This agent** to change one agent's preference, or **All agents** for a project-wide choice. Disabling a skill for the project excludes it across agents. Enabling it makes it eligible when its topic matches. Changing a preference affects the next selection. A host can retain context it already received.

The CLI takes the exact catalog path shown on a skill. For example:

```sh
osf disable web-dev/react/react-accessibility-a11y-best-practices-intermediate.md --project . --agent claude-code
osf select "React accessibility best practices" --project . --agent codex --max-skills 1 --token-budget 1400
```

The default pack limit is three skills and 2,400 estimated tokens. The estimate uses the complete rendered Markdown, including paths, headings and match reasons. The same request with the same preferences and installed catalog produces the same selection. The picker can return fewer skills or none. An empty result contributes zero skill text.

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
            "command": "osf hook --agent claude-code --project /work/checkout --max-skills 2 --token-budget 1400"
          }
        ]
      }
    ]
  }
}
```

The hook uses the visible prompt and working directory supplied by the host. It emits the selected guidance for that turn and produces no output for an unrelated prompt or a directory outside the chosen project. Omni does not save the prompt or open native transcript files. Removing the entry stops future hook deliveries.

## Let a compatible agent ask for a pack over MCP

For on-demand selection, configure `osf mcp --agent <agent> --project <absolute-project-path>` as a local stdio server. The agent calls the read-only `select_skills` tool with a task. This route works with a host that supports local MCP tools and lets the host choose when it needs guidance. Use a single delivery route in each host to avoid including the same skills twice.

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

Restart or reconnect the host as needed. Ask it to use `select_skills` for the current task. The tool receives task text and limits. The server fixes the project and agent at startup. [Codex MCP configuration](https://developers.openai.com/codex/mcp) · [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)

## When Exactwork helps

A migration that spans several sessions needs more than a database skill. It also needs a clear acceptance test, a record of what changed and a handoff the next agent can trust. Exactwork provides portable skills for that execution, research and review process. Start with its core skill. Add a companion when the work calls for one. [Exactwork skills and installation](https://github.com/theihtishaam/exactwork-skills)
