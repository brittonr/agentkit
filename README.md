# agentkit

A collection of agent definitions, extensions, skills, and CLI tools for
[pi](https://github.com/mariozechner/pi-coding-agent) — the coding agent
framework.

Drop these into `~/.pi/agent/` (via symlinks or copies) to extend pi with
specialized agents, reusable skills, session-aware extensions, and purpose-built
CLI tools.

## Structure

```
_global/
  agents/        Agent definitions (model + role configs)
  extensions/    TypeScript extensions (hooks into pi lifecycle)
  skills/        Skill files (contextual instructions for the agent)
tools/           CLI tools packaged as Nix flake packages
flake.nix        Nix flake for building tools
```

## Agents

Specialized agent definitions for use with pi's swarm (`subagent` /
`delegate_task`). Each defines a model, role, and tool access level.

| Agent | Model | Role |
|-------|-------|------|
| **scout** | haiku | Fast read-only recon — searching, reading, gathering info |
| **worker** | sonnet | Full-capability implementation — writing code, running tests |
| **reviewer** | sonnet | Read-only code review — quality, bugs, improvements |
| **debugger** | sonnet | Bug tracing through logs, stack traces, and code paths |
| **tester** | sonnet | Writing and running tests, improving coverage |
| **refactorer** | sonnet | Improving structure and readability, preserving behavior |
| **documenter** | sonnet | Writing READMEs, API docs, and technical guides |
| **planner** | sonnet | Architecture and planning, breaking tasks into subtasks |
| **researcher** | opus | Deep research, architecture decisions, hard problems |
| **verifier** | sonnet | Formal verification with Verus in Rust |

## Extensions

TypeScript extensions that hook into pi's lifecycle events.

| Extension | Description |
|-----------|-------------|
| **auto-commit** | Commits changes automatically when the agent session exits |
| **context** | Injects system context (OS, shell, project info) into the prompt |
| **direnv** | Loads direnv environment variables into agent sessions |
| **file-trigger** | Triggers agent actions based on file changes |
| **git-checkpoint** | Creates git checkpoints before risky operations |
| **git-dirty** | Warns when the working tree has uncommitted changes |
| **handoff** | Passes conversation context between agent sessions |
| **helix-editor** | Helix-style modal editor integration |
| **interactive-shell** | Supports interactive shell commands in the agent |
| **iroh-rpc** | P2P agent communication over iroh/QUIC networking |
| **loop** | Loops agent execution for continuous tasks |
| **notify** | Desktop/terminal notifications on task completion |
| **plan-mode** | Structured planning mode before implementation |
| **safety-guards** | Blocks dangerous commands (recursive deletes, etc.) |
| **swarm** | Multi-agent swarm orchestration with TUI dashboard |
| **truncated-tool** | Example of proper output truncation for custom tools |

## Skills

Contextual instruction files that teach the agent domain-specific knowledge.
Pi loads matching skills automatically based on task context.

| Skill | Description |
|-------|-------------|
| **acl** | Analyze SOPS secret ownership and access control |
| **chaoscontrol** | Deterministic hypervisor for simulation testing — build, test, explore, replay |
| **browser-cli** | Control Firefox from the command line |
| **build** | Build NixOS machine configurations locally |
| **clan** | Clan CLI for infrastructure management |
| **cloud** | Cloud infrastructure via OpenTofu/Terranix |
| **context7-cli** | Fetch up-to-date library docs from Context7 |
| **db-cli** | Search Deutsche Bahn train connections |
| **git-worktree** | Manage isolated git worktrees for safe experimentation |
| **gmaps-cli** | Search places and get directions via Google Maps |
| **iroh-rpc** | P2P agent communication over iroh networking |
| **kagi-search** | Web search with Kagi Quick Answer AI summaries |
| **napkin** | Per-repo learning file — tracks mistakes, corrections, patterns |
| **nix** | Nix flakes, devshells, and package management |
| **nix-prefetch-sri** | Get SRI hashes for Nix fetch expressions |
| **pexpect-cli** | Automate interactive terminal applications |
| **roster** | Analyze user roster configurations |
| **screenshot-cli** | Take and analyze screenshots |
| **tags** | Analyze machine tag assignments |
| **tigerstyle** | Tiger Style coding philosophy and review |
| **ultra-mode** | Maximum capability mode with deep analysis |
| **validate** | Run formatting and pre-commit checks |
| **vars** | Analyze clan vars ownership and structure |
| **weather-cli** | Get weather forecasts worldwide |

## CLI Tools

Purpose-built CLI tools, packaged via Nix flake. Build with `nix build .#<name>`.

| Tool | Description |
|------|-------------|
| **browser-cli** | Headless Firefox automation (Python) |
| **context7-cli** | Library documentation fetcher (Python) |
| **gmaps-cli** | Google Maps search and directions (Python) |
| **iroh-rpc** | P2P messaging over iroh/QUIC (Rust) |
| **kagi-search** | Kagi web search client (Python) |
| **pexpect-cli** | Interactive terminal session manager (Python) |
| **screenshot-cli** | Screenshot capture tool (Python) |
| **weather-cli** | Weather forecast client (Python) |

## Setup

### Install tools via Nix

```bash
# Build a specific tool
nix build .#browser-cli

# Run directly
nix run .#weather-cli -- --help
```

### Link into pi

Symlink the directories you want into your pi config:

```bash
# Skills
ln -s /path/to/agentkit/_global/skills/napkin ~/.pi/agent/skills/napkin

# Agents
ln -s /path/to/agentkit/_global/agents/scout.md ~/.pi/agent/agents/scout.md

# Extensions
ln -s /path/to/agentkit/_global/extensions/notify.ts ~/.pi/agent/extensions/notify.ts
```

Or symlink entire directories for everything:

```bash
ln -sf /path/to/agentkit/_global/skills/* ~/.pi/agent/skills/
ln -sf /path/to/agentkit/_global/agents/* ~/.pi/agent/agents/
ln -sf /path/to/agentkit/_global/extensions/* ~/.pi/agent/extensions/
```

## License

MIT
