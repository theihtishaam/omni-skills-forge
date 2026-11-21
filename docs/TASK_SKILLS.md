# Connect your agent to Omni

Open `osf dashboard` in the project. Its suggestions come from recognized project files in your working folder or its nearest recognized parent inside the project. Use the category menu and switches to decide what the agent can use. A project-wide exclusion also applies to individually enabled skills and to saved combinations that use an excluded file.

For example, `osf disable --category devops/docker --agent codex --project .` switches Docker off for Codex in this project. Replace `disable` with `enable` to allow it again.

Use the Codex or Claude Code prompt hook to provide guidance automatically. Start a message with “Make one skill for …” when you want Omni to save a new skill in the workspace. Other compatible agents can find and make skills through MCP. Pick one delivery route per host to avoid receiving the same guidance twice.

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

The hook uses the prompt and working directory supplied by the host. An ordinary matching request receives guidance. An explicit skill-creation request saves the task instructions with the new workspace skill and returns its name. An unrelated request produces no guidance. Removing the hook entry stops future hook deliveries.

## Connect an agent over MCP

To let an agent find and make skills, configure `osf mcp --agent <agent> --project <absolute-project-path>` as a local stdio server. The agent calls `select_skills` with a task and can supply a relative `directory` inside that project. Use one delivery route per host so the same skills reach its prompt once.

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

Restart or reconnect the host. For ordinary work, the agent calls `select_skills` to get relevant guidance. When you ask it to create a reusable skill, it calls `make_workspace_skill` with your instruction. Both tools stay within the project and agent set at startup. [Codex MCP configuration](https://developers.openai.com/codex/mcp) · [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)

## Make a skill from a request

Ask the connected agent, “Make a skill for reviewing keyboard access and form submission in my React checkout.” The agent can request matching catalog files from Omni or supply specific source paths. An automatic selection uses up to three catalog files. A handpicked combination can use up to five. Repeating an identical request with the same sources reuses the existing workspace skill.

Use the **Make skill** button for the same workflow in your browser. If you already know the sources you want, check them in the catalog. Changing a category or searching again preserves your picks. The result shows the source files so you can review it alongside the project.

[Omni Skills Forge](https://github.com/theihtishaam/omni-skills-forge) · [Exactwork Skills](https://github.com/theihtishaam/exactwork-skills) · [Ihtisham on GitHub](https://github.com/theihtishaam)
