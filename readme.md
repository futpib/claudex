# claudex

[![Coverage Status](https://coveralls.io/repos/github/futpib/claudex/badge.svg?branch=master)](https://coveralls.io/github/futpib/claudex?branch=master)

A CLI wrapper and hook management system for Anthropic's Claude Code that adds Docker containerization, safety guardrails, desktop notifications, and session tracking.

## Features

- **Docker Containerization**: Run Claude Code in an isolated Docker container with automatic image building, volume mounting, and security hardening
- **Safety Layer**: Prevents dangerous git operations (bypassing hooks, amending other developers' commits) and rejects unsafe working directories
- **Desktop Notifications**: Get notified via `notify-send` when tasks complete or need attention, with host socket forwarding for Docker
- **Session Tracking**: Comprehensive logging of tool usage and user interactions
- **Memory Management**: Modular CLAUDE.md file generation from organized configuration directory
- **SSH Forwarding**: Automatic SSH agent setup and forwarding into Docker containers
- **Hook System**: Extensible pre-tool-use, post-tool-use, user-prompt-submit, notification, and stop hooks
- **MCP Server**: Built-in requirements tracking tool for Claude Code sessions
- **Multi-Scope Configuration**: Layered config system with global, project, group, and profile scopes
- **Accounts**: Isolated Claude configurations per named account (`--account <name>`)
- **Multiple Launchers**: Built-in support for `claude`, `opencode`, `ollama`, and `codex` with extensible custom launcher definitions
- **Companion Launchers**: Co-mount multiple launchers' packages and account directories via the `launchers` config key
- **Host Port Proxying**: Automatically forward host-side ports into Docker containers via socat
- **Startup Commands**: Run custom init and startup commands inside Docker containers at build or start time
- **Session Portability**: Automatically copies session files across projects when resuming a session with `--resume`

## Installation

```bash
# Install locally from source
git clone https://github.com/futpib/claudex.git
cd claudex
yarn install
yarn build
```

## Usage

### Basic Usage

```bash
# Run Claude Code in Docker (default)
claudex

# All arguments are passed through to Claude Code
claudex -p 'fix the tests'

# Run directly on the host (no Docker)
claudex --no-docker

# Start a new container with a bash shell instead of the launcher
claudex --docker-shell

# Exec a bash shell into an already-running container for the current directory
claudex exec

# Exec into a running container as root
claudex exec --root
```

### CLI Flags

| Flag | Description |
|---|---|
| `--no-docker` | Run Claude Code directly on the host |
| `--docker-shell` | Start a new container with a bash shell instead of the launcher |
| `--docker-pull` | Pull the latest base image when building |
| `--docker-no-cache` | Build image without Docker cache |
| `--docker-skip-build` | Skip Docker image build and use existing image |
| `--docker-sudo` | Allow sudo inside the container |
| `--docker-insecure` | Disable all Docker hardening (caps, no-new-privileges, ipc, pids-limit) |
| `--docker-arg <arg>` | Pass extra argument to `docker run` (repeatable) |
| `--docker-args <args>` | Extra arguments to pass to `docker run` (space-separated) |
| `--allow-unsafe-directory` | Skip directory safety checks |
| `--package <name>` | Install pacman package in Docker (repeatable) |
| `--volume <spec>` | Mount volume: `path` or `host:container` (repeatable) |
| `--env <spec>` | Set env var: `KEY=value` or `KEY` for passthrough (repeatable) |
| `--env-file <path>` | Load env vars from a dotenv-format file (repeatable) |
| `--env-mode <mode>` | How env-file vars reach the container: `explicit` (default) or `all` |
| `--ssh-key <path>` | Add SSH key to agent (repeatable) |
| `--launcher <name>` | Select launcher by name (e.g. `ollama`, `opencode`, `codex`) |
| `--model <name>` | Override the launcher's default model |
| `--account <name>` | Use a specific claudex account (isolated Claude config) |
| `--no-account` | Ignore configured account and use default paths |

### Docker Safety

By default, claudex refuses to run in unsafe directories (home directory, hidden directories, unowned directories, directories without `.git`). A temporary directory is created automatically in these cases. Use `--allow-unsafe-directory` to override.

Containers run with `--cap-drop ALL --security-opt no-new-privileges --ipc=private --pids-limit` unless `--docker-sudo` or `--docker-insecure` is passed. `--docker-insecure` disables all hardening; `--docker-sudo` only disables capability dropping and no-new-privileges. Use `--docker-arg` or `--docker-args` to pass arbitrary arguments to `docker run`:

```bash
# Single args (repeatable)
claudex --docker-arg --privileged
claudex --docker-arg --cap-add --docker-arg SYS_ADMIN

# Multiple args at once (space-separated)
claudex --docker-args='--cap-add SYS_ADMIN --cap-add SYS_PTRACE --security-opt seccomp=unconfined'
```

### Memory Management

Organize your Claude Code context in `~/.config/claudex/CLAUDE.md.d/`:

```
~/.config/claudex/CLAUDE.md.d/
├── 01-memory-management.md
├── 02-git-workflow.md
├── 03-cli-best-practices.md
├── 04-code-exploration.md
├── 05-rust-development.md
└── 06-code-style.md
```

Run `claudex` to aggregate these files into `~/.claude/CLAUDE.md`.

## How It Works

### Pre-Tool-Use Hook

Located in `src/hooks/pre-tool-use.ts`, this hook intercepts all Claude Code tool calls to:

- **Block dangerous git operations**:
  - `git commit --amend` (prevents amending other developers' commits)
  - `git commit --no-verify` (prevents bypassing pre-commit hooks)

- **Log tool usage**:
  - Records session IDs, transcript locations, and tool parameters
  - Filters sensitive information from logs

### User Prompt Submit Hook

Logs user prompts with session context for tracking and debugging.

### Architecture

```
┌─────────────┐
│   claudex   │  CLI wrapper
└──────┬──────┘
       │
       ├─► Sets up hooks in ~/.claude/settings.json
       ├─► Generates ~/.claude/CLAUDE.md from ~/.config/claudex/CLAUDE.md.d/
       ├─► Starts SSH agent and host socket server
       ├─► Builds and runs Docker container (or spawns claude directly)
       │
       └─► claude (inside container or on host)
           │
           ├─► PreToolUse hook validates operations
           ├─► PostToolUse hook (extensible stub)
           ├─► UserPromptSubmit hook logs interactions
           ├─► Stop hook sends "task completed" notification
           └─► Notification hook forwards attention-needed alerts
```

### Notifications

Desktop notifications are enabled by default. Claude Code fires notifications when tasks complete (`Stop` event) or need attention (`Notification` event).

In Docker mode, notifications are delivered through a Unix domain socket mounted from the host. The socket uses newline-delimited JSON and is designed to be extensible for future message types. Outside Docker, `notify-send` is called directly.

```bash
# Disable notifications
claudex config set --global notifications false
```

### Env Files

Claudex can load dotenv-format files at startup. Loaded values feed `${VAR}` substitutions in `env: {...}` and, when `envMode` is `all`, are forwarded into the container as-is. Default behavior (no env files) is unchanged.

```bash
# Auto-load .env and any .env.* file (except templates: .env.example/sample/template/dist)
claudex config set envFile true

# Or point at a specific file
claudex config set envFile path/to/.env

# Add additional explicit files (paths relative to cwd; tilde-expanded)
claudex config add envFiles ~/secrets/shared.env

# Or pass at runtime
claudex --env-file path/to/.env --env-file path/to/other.env
```

By default (`envMode: "explicit"`), env-file values are only available for `${VAR}` resolution from `env: {...}`. To pass every loaded variable straight into the container, use `all`:

```bash
claudex config set envMode all
# or once
claudex --env-mode all
```

Loaded values are run through `gitleaks` (when available) and shielded as `****` in startup logs. Last-loaded source wins for conflicting keys; explicit `env: {...}` and `--env` entries win over file-loaded values.

### SSH Forwarding

Claudex starts an SSH agent, loads configured keys, and forwards it into the container. Known hosts from `~/.ssh/known_hosts` are filtered to configured hosts and injected into the container.

```bash
claudex config set ssh.keys '["~/.ssh/id_ed25519"]'
claudex config set ssh.hosts '["github.com", "gitlab.com"]'
```

### Accounts

Claudex supports multiple named accounts to keep Claude configurations isolated (e.g. for different projects or organizations). Each account gets its own Claude config directory under `~/.config/claudex/accounts/<name>/claude`.

```bash
# Run with a specific account
claudex --account work

# Set the default account for a project
claudex config set account work
```

### Alternative Launchers

Claudex supports multiple AI launchers via the `--launcher` flag or the `launcher` config key. All launchers benefit from Docker containerization, SSH forwarding, hook management, and account isolation.

#### OpenCode

Claudex supports [OpenCode](https://opencode.ai/) as an alternative launcher. When selected, the OpenCode plugin (`opencode-plugin.ts`) is automatically registered and bridges OpenCode hook events (tool calls, stop, user prompts) to claudex hook executables.

```bash
# Run with OpenCode launcher
claudex --launcher opencode

# Set OpenCode as the default launcher for a project
claudex config set launcher opencode
```

The built-in `opencode` launcher definition mounts `~/.local/share/opencode` and `~/.config/opencode` into the container automatically.

#### Ollama

The `ollama` launcher wraps Claude Code but routes it through a local [Ollama](https://ollama.com/) instance. It automatically installs Ollama inside the container and exposes host port 11434 so the container can reach the host's Ollama service.

```bash
claudex --launcher ollama
```

#### Codex

The `codex` launcher runs OpenAI Codex CLI inside the container. Hooks are wired via Codex's `hooks.json` mechanism. Account isolation is applied to `~/.codex`.

```bash
claudex --launcher codex
```

#### Co-mounting Multiple Launchers

Use the `launchers` config key to co-mount additional launchers alongside the primary one. This installs their packages and mounts their account directories so you can switch between launchers without leaving the container.

```bash
# Co-mount codex alongside the default claude launcher
claudex config add launchers codex

# Co-mount opencode as well
claudex config add launchers opencode
```

The primary launcher (set via `launcher`) determines which process is actually started; `launchers` only adds infrastructure (packages, volumes).

#### Custom Launcher Definitions

Define custom launchers in the root config under `launcherDefinitions`. Each definition can override the command, model, packages, volumes, and host ports of any built-in launcher, or define a brand-new launcher entirely.

```jsonc
{
  "launcherDefinitions": {
    "my-codex": {
      "command": ["codex", "--model", "o3-mini"],
      "packages": ["openai-codex"]
    }
  }
}
```

Then use it with `--launcher my-codex` or `claudex config set launcher my-codex`.

### Session Portability

When resuming a Claude Code session with `--resume <session-id>`, claudex automatically finds and copies the session transcript into the current project directory if it was recorded under a different project. This makes it easy to resume sessions even after moving or renaming a project.

```bash
# Resume a session — claudex finds it automatically even if it lives in another project dir
claudex --resume <session-id>
```

### Host Port Proxying

When `hostPorts` is configured, claudex starts host-side `socat` proxies so the container can reach localhost-only services on the host via `host.docker.internal`.

```bash
# Expose host port 11434 (Ollama) to the container
claudex config add hostPorts 11434
```

### Startup and Init Commands

Run custom commands during Docker image build or at container startup:

```bash
# Run as root during image build (after packages are installed)
claudex config add rootInitCommands 'echo "hello from root build"'

# Run as user during image build
claudex config add userInitCommands 'npm install -g typescript'

# Run as root at every container start
claudex config add rootStartupCommands 'service nginx start'

# Run as user at every container start (before Claude)
claudex config add userStartupCommands 'eval "$(ssh-agent -s)"'
```

## Config Management

Manage claudex configuration from the command line with `claudex config`:

```bash
claudex config <action> [scope flags] [key] [value]
```

### Actions

- `list` — show effective merged config
- `get <key>` — get a merged effective value
- `set <key> <value>` — set a scalar value or record entry
- `add <key> <value>` — append to an array field
- `remove <key> [<value>]` — remove a value from an array or record field
- `unset <key> [<value>]` — remove a key, or remove a specific value from an array
- `keys` — list available configuration keys and their types
- `group <name> <paths...>` — assign multiple projects to a group at once
- `ungroup <name> <paths...>` — remove projects from a group
- `profile <name> <paths...>` — add a profile to multiple projects at once
- `unprofile <name> <paths...>` — remove a profile from multiple projects

### Scope Flags

- *(none)* — current project (`projects[<cwd>]` section)
- `--global` — root-level config
- `--project <path>` — `projects[<path>]` section (explicit)
- `--group <name>` — `groupDefinitions[<name>]` section
- `--profile <name>` — `profileDefinitions[<name>]` section
- `--file <path>` — target a specific file (relative to config dir)
- `--members` — list project paths belonging to a group (use with `list --group`)

### Key Format

| Key | Type | Actions |
|---|---|---|
| `packages` | string[] | add, unset |
| `volumes` | string[] | add, unset |
| `env.<KEY>` | string | set, unset |
| `envFile` | boolean \| string | set, unset |
| `envFiles` | string[] | add, unset |
| `envMode` | `"all"` \| `"explicit"` | set, unset |
| `ssh.keys` | string[] | add, unset |
| `ssh.hosts` | string[] | add, unset |
| `hostPorts` | number[] | add, unset |
| `extraHosts.<HOST>` | string | set, unset |
| `shareVolumes` | boolean | set, unset |
| `shareAdditionalDirectories` | boolean | set, unset |
| `settingSources` | string | set, unset |
| `hooks` | boolean / object | set, unset |
| `hooks.<FLAG>` | boolean | set, unset |
| `mcpServers` | boolean / object | set, unset |
| `mcpServers.<NAME>` | boolean | set, unset |
| `notifications` | boolean | set, unset |
| `hooksDescriptions` | boolean | set, unset |
| `profiles` | string[] | add, unset |
| `group` | string (project only) | set, unset |
| `account` | string | set, unset |
| `launcher` | string | set, unset |
| `launchers` | string[] | add, unset |
| `rootInitCommands` | string[] | add, unset |
| `userInitCommands` | string[] | add, unset |
| `rootStartupCommands` | string[] | add, unset |
| `userStartupCommands` | string[] | add, unset |
| `dockerDangerouslySkipPermissions` | boolean | set, unset |
| `dockerAllowDangerouslySkipPermissions` | boolean | set, unset |
| `dockerIpcPrivate` | boolean | set, unset |
| `dockerPidsLimit` | boolean | set, unset |
| `launcherOverrides.<launcher>.args` | string[] | set, unset |
| `launcherOverrides.<launcher>.env.<KEY>` | string | set, unset |
| `launcherOverrides.<launcher>.settings.<KEY>` | any | set, unset |

### Profiles

Profiles are reusable tool bundles that package together everything a tool needs: its apt package, config volumes, and environment variables.

Define profiles in `profileDefinitions` at the root level, then reference them from any scope (global, group, or project) via the `profiles` array:

```json
{
  "profileDefinitions": {
    "gh": {
      "packages": ["github-cli"],
      "volumes": ["~/.config/gh/"]
    },
    "glab": {
      "packages": ["glab"],
      "volumes": ["~/.config/glab-cli/"]
    }
  },
  "profiles": ["gh"],
  "groupDefinitions": {
    "my-project": {
      "profiles": ["gh", "glab"]
    }
  }
}
```

Volumes from profiles are **excluded from `--add-dir`** — they're utility mounts (tool config), not project directories. Profile fields are applied before explicit config, so fields set directly on a group or project override the profile's values.

```bash
# Define a profile
claudex config add --profile gh packages github-cli
claudex config add --profile gh volumes ~/.config/gh/

# Reference a profile globally
claudex config add --global profiles gh

# Reference a profile from a group
claudex config add --group my-project profiles glab

# View a profile's config
claudex config list --profile gh
```

#### Profiles vs Groups

| | Profiles | Groups |
|---|---|---|
| **Purpose** | Bundle a tool + its config | Bundle related projects |
| **Defined at** | Root `profileDefinitions` record | Root `groupDefinitions` record |
| **Referenced via** | `profiles: ["name"]` from any scope | `group: "name"` from a project |
| **Volumes** | Excluded from `--add-dir` | Auto-shared between members |

### Examples

```bash
# Add a volume to current project
claudex config add volumes ~/code/parser

# Set an extra host for a group
claudex config set --group mygroup extraHosts.gitlab.example.com 127.0.0.1

# Add a host port to a group (in a specific file)
claudex config add --group mygroup --file config.json.d/99-private.json hostPorts 8443

# Set env var for a project
claudex config set --project ~/code/foo env.API_KEY '${API_KEY}'

# Remove a volume from a project
claudex config unset --project ~/code/myproject volumes ~/code/parser

# List merged config for current project
claudex config list

# Get a specific value
claudex config get --group mygroup hostPorts

# Assign multiple projects to a group
claudex config group mygroup ~/code/foo ~/code/bar

# Remove projects from a group
claudex config ungroup mygroup ~/code/foo

# List projects in a group
claudex config list --group mygroup --members

# Assign a profile to multiple projects at once
claudex config profile gh ~/code/foo ~/code/bar

# Remove a profile from projects
claudex config unprofile gh ~/code/foo
```

## Config Interactive TUI

For a visual way to browse and edit configuration, use the interactive TUI:

```bash
claudex config-interactive
```

## Package Installation

Install packages into a running claudex container on-the-fly with `claudex install`:

```bash
# Install packages and save to project config
claudex install ripgrep fd

# Install without saving to config
claudex install --no-save jq

# Target a specific container
claudex install --container claudex-myproject-abc123 nodejs
```

Packages are installed with pacman and persisted to the project config by default (use `--no-save` to skip).

Remove packages from a running container with `claudex uninstall`:

```bash
# Uninstall packages and remove from project config
claudex uninstall ripgrep

# Uninstall without updating config
claudex uninstall --no-save jq

# Target a specific container
claudex uninstall --container claudex-myproject-abc123 nodejs
```

## Container Management

### Listing Containers

```bash
# List running claudex containers for the current project
claudex ps

# List all running claudex containers
claudex ps --all
```

### Re-Attaching to a Container

```bash
# Re-attach to an orphaned claudex container (cleans up on exit)
claudex attach

# Attach to a specific container by name
claudex attach claudex-myproject-abc123
```

### Exec into a Running Container

```bash
# Exec a bash shell into a running container for the current directory
claudex exec

# Target a specific container by name
claudex exec claudex-myproject-abc123

# Exec as root with full privileges
claudex exec --root
```

### Pruning Orphaned Containers

Remove stopped or detached containers that are no longer in use:

```bash
# Prune orphaned containers for the current project
claudex prune

# Prune orphaned containers across all projects
claudex prune --all

# Skip confirmation prompt
claudex prune --force
```

### Moving a Project

Move a project directory along with its Claude session data and config references:

```bash
claudex mv ~/code/old-name ~/code/new-name
```

### Confirming Pending Actions

Some hook rules (e.g. `requireGitMutationConfirmation`, `banWriteOperations`) block an action and emit a short confirmation ID. Confirm with a verbatim quote from the user that authorized the action:

```bash
claudex confirm <id> '<verbatim quote from the user>'

# Immediately execute the confirmed command after storing the confirmation
claudex confirm <id> '<verbatim quote>' --exec
```

## Configuration

### Hooks and MCP Servers

Pre-tool-use hook checks are **on by default** with recommended settings. MCP server registration is **off by default**. You can customize them in your claudex config:

```bash
# Enable all hook checks and MCP servers
claudex config set --global hooks true
claudex config set --global mcpServers true

# Enable a single hook check
claudex config set --global hooks.banGitCommitAmend true

# Enable the claudex MCP server
claudex config set --global mcpServers.claudex true
```

Or in `config.json`:

```jsonc
{
  // Enable everything:
  "hooks": true,
  "mcpServers": true

  // Or granular:
  // "hooks": { "banGitCommitAmend": true, "logToolUse": true },
  // "mcpServers": { "claudex": true }
}
```

**Hook flags:**

| Flag | Description |
|---|---|
| `banGitC` | Ban `git -C` (running git in a different directory) |
| `banCargoManifestPath` | Ban `cargo --manifest-path` (running cargo with a different manifest) |
| `banYarnCwd` | Ban `yarn --cwd` (running yarn with a different working directory) |
| `banGitAddAll` | Ban `git add -A` / `--all` / `--no-ignore-removal` |
| `banGitCommitAmend` | Ban `git commit --amend` |
| `banGitCommitNoVerify` | Ban `git commit --no-verify` |
| `banGitRemoteSetUrl` | Ban `git remote set-url` that switches SSH remote to HTTPS |
| `banGitCheckoutRedundantStartPoint` | Ban redundant start-point in `git checkout -b` on detached HEAD |
| `banBackgroundBash` | Ban `run_in_background` bash commands |
| `banBashMinusC` | Ban `bash -c` or `sh -c` (run the command directly) |
| `banCommandChaining` | Ban `&&`, `\|\|`, `;` command chaining |
| `banPipeToFilter` | Ban piping to filter commands (grep, head, tail, etc.) |
| `banFileOperationCommands` | Ban cat, sed, head, tail, awk (use dedicated tools) |
| `banFindCommand` | Ban `find` for file searching (use the builtin Glob tool) |
| `banFindDelete` | Ban `find -delete` (list matches first, then remove with rm) |
| `banFindExec` | Ban `find -exec` / `-execdir` (use dedicated tools) |
| `banGrepCommand` | Ban `grep`/`rg` to search file contents (use the builtin Grep tool) |
| `banLsCommand` | Ban `ls` to list files (use the builtin Glob tool) |
| `banOutdatedYearInSearch` | Ban web searches containing recent but outdated years (2020+ but before current) |
| `banAbsolutePaths` | Ban absolute paths under cwd in Bash commands (use relative paths) |
| `banHomeDirAbsolutePaths` | Ban absolute paths under home directory in Bash commands (use `~/...`) |
| `banWrongPackageManager` | Ban using wrong package manager for the project |
| `banWriteOperations` | Require proof confirmation (`claudex confirm`) before HTTP write operations, GraphQL mutations, or MCP write tools |
| `preferLocalGithubRepo` | Block fetching files from GitHub when the repo is already cloned locally as a sibling directory |
| `preferGhx` | Use `ghx` instead of `gh` when `ghx` is available |
| `suggestCommandSubstitute` | When a command is not found but an equivalent is available, suggest it (e.g. pip → uv) |
| `requireGitMutationConfirmation` | Require explicit user confirmation before git mutations (commit, push, merge, etc.) |
| `logToolUse` | Log non-read-only tool usage |
| `logReadOnlyToolUse` | Log read-only tool usage |
| `logPrompts` | Log user prompts |

**MCP server flags:**

| Flag | Description |
|---|---|
| `claudex` | Register the claudex MCP server in `~/.claude.json` |

Setting `hooks: true` enables all recommended checks and registers hooks in `~/.claude/settings.json`. Setting `hooks: { ... }` enables only listed checks; any truthy value triggers hook registration. When `hooks` is not set (default), all recommended checks are enabled.

### MCP Server Tools

When the `claudex` MCP server is registered, it exposes these tools to the AI during a session:

| Tool | Description |
|---|---|
| `requirements_add` | Add a requirement that must be satisfied for the task to be complete |
| `requirements_remove` | Remove a requirement by its 1-based index |
| `requirements_list` | List all current requirements |

Requirements are stored in-memory and reset when the claudex session ends. They are useful for Claude to track what still needs to be done within a single session.

### Hook Registration

Claudex automatically registers all hooks in `~/.claude/settings.json` on startup.

### Memory Files

Create modular memory files in `~/.config/claudex/CLAUDE.md.d/` using numeric prefixes for ordering:

```markdown
# 01-example-memory.md

## Pattern or Strategy Name

- Store patterns and strategies, not specific data points
- Focus on reusable logic and process knowledge
- Remember how to do things, not what was done
```

## Development

### Requirements

- Node.js 22, 23, 24, or 25
- Yarn 4.x

### Setup

```bash
git clone https://github.com/futpib/claudex.git
cd claudex
yarn install
```

### Scripts

```bash
# Build TypeScript
yarn build

# Watch mode for development
yarn dev

# Run tests with linting and coverage
yarn test
```

### Testing

Tests are written with AVA and coverage is tracked with c8:

```bash
yarn test
```

### Code Quality

The project uses XO for strict linting with TypeScript support:

```bash
npx xo
```

## Subcommands

All functionality is provided through a single `claudex` binary with subcommands:

- `claudex` - Main CLI wrapper
- `claudex in-docker` - Docker container entry point
- `claudex mcp` - MCP server for requirements tracking
- `claudex hook pre-tool-use` - Pre-tool-use hook handler
- `claudex hook post-tool-use` - Post-tool-use hook handler (extensible stub)
- `claudex hook user-prompt-submit` - User prompt event handler
- `claudex hook notification` - Notification event handler (desktop notifications)
- `claudex hook stop` - Stop event handler (task completion notifications)
- `claudex hook session-start` - Session-start event handler (used by codex launcher)

## Contributing

Contributions are welcome! Please ensure:

- All tests pass (`yarn test`)
- Code follows XO linting standards
- TypeScript compiles without errors
- New features include appropriate tests
