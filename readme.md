# claudex

[![Coverage Status](https://coveralls.io/repos/github/futpib/claudex/badge.svg?branch=master)](https://coveralls.io/github/futpib/claudex?branch=master)

A CLI wrapper and hook management system for Anthropic's Claude Code that adds Docker containerization, safety guardrails, desktop notifications, co-authorship tracking, and memory management capabilities.

## Features

- **Docker Containerization**: Run Claude Code in an isolated Docker container with automatic image building, volume mounting, and security hardening
- **Safety Layer**: Prevents dangerous git operations (bypassing hooks, amending other developers' commits) and rejects unsafe working directories
- **Desktop Notifications**: Get notified via `notify-send` when tasks complete or need attention, with host socket forwarding for Docker
- **Co-Authorship Verification**: Cryptographic proof system to validate Claude's actual contributions to commits
- **Session Tracking**: Comprehensive logging of tool usage and user interactions
- **Memory Management**: Modular CLAUDE.md file generation from organized configuration directory
- **SSH Forwarding**: Automatic SSH agent setup and forwarding into Docker containers
- **Hook System**: Extensible pre-tool-use, user-prompt-submit, notification, and stop hooks
- **MCP Server**: Built-in requirements tracking tool for Claude Code sessions
- **Multi-Scope Configuration**: Layered config system with global, project, and group scopes

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

# Launch a shell inside the container
claudex --docker-shell

# Exec into a running container for the current directory
claudex --docker-exec
```

### CLI Flags

| Flag | Description |
|---|---|
| `--no-docker` | Run Claude Code directly on the host |
| `--docker-shell` | Launch bash inside the container |
| `--docker-exec` | Exec into a running container |
| `--docker-pull` | Pull the latest base image when building |
| `--docker-no-cache` | Build image without Docker cache |
| `--docker-sudo` | Allow sudo inside the container |
| `--allow-unsafe-directory` | Skip directory safety checks |
| `--package <name>` | Install apt package in Docker (repeatable) |
| `--volume <spec>` | Mount volume: `path` or `host:container` (repeatable) |
| `--env <spec>` | Set env var: `KEY=value` or `KEY` for passthrough (repeatable) |
| `--ssh-key <path>` | Add SSH key to agent (repeatable) |

### Docker Safety

By default, claudex refuses to run in unsafe directories (home directory, hidden directories, unowned directories, directories without `.git`). A temporary directory is created automatically in these cases. Use `--allow-unsafe-directory` to override.

Containers run with `--cap-drop ALL --security-opt no-new-privileges` unless `--docker-sudo` is passed.

### Co-Authorship Proof System

When Claude makes code changes, you can mark commits as co-authored with cryptographic verification:

```bash
# Generate a proof PIN for co-authorship
claudex-submit-co-authorship-proof
```

This creates a proof entry that must be included in commit messages when using `Co-authored-by: Claude Code`. The pre-tool-use hook validates these proofs before allowing commits.

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

- **Validate co-authorship claims**:
  - Requires valid SHA256 proof PIN when `Co-authored-by: Claude Code` is used
  - Ensures Claude actually contributed to the code being committed

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

### SSH Forwarding

Claudex starts an SSH agent, loads configured keys, and forwards it into the container. Known hosts from `~/.ssh/known_hosts` are filtered to configured hosts and injected into the container.

```bash
claudex config set ssh.keys '["~/.ssh/id_ed25519"]'
claudex config set ssh.hosts '["github.com", "gitlab.com"]'
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
- `ungroup <paths...>` — remove group assignment from projects

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
| `ssh.keys` | string[] | add, unset |
| `ssh.hosts` | string[] | add, unset |
| `hostPorts` | number[] | add, unset |
| `extraHosts.<HOST>` | string | set, unset |
| `shareVolumes` | boolean | set, unset |
| `settingSources` | string | set, unset |
| `hooks` | boolean / object | set, unset |
| `hooks.<FLAG>` | boolean | set, unset |
| `mcpServers` | boolean / object | set, unset |
| `mcpServers.<NAME>` | boolean | set, unset |
| `notifications` | boolean | set, unset |
| `profiles` | string[] | add, unset |
| `group` | string (project only) | set, unset |

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

# Remove projects from their group
claudex config ungroup ~/code/foo

# List projects in a group
claudex config list --group mygroup --members
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
| `banGitAddAll` | Ban `git add -A` / `--all` / `--no-ignore-removal` |
| `banGitCommitAmend` | Ban `git commit --amend` |
| `banGitCommitNoVerify` | Ban `git commit --no-verify` |
| `banGitCheckoutRedundantStartPoint` | Ban redundant start-point in `git checkout -b` on detached HEAD |
| `banBackgroundBash` | Ban `run_in_background` bash commands |
| `banCommandChaining` | Ban `&&`, `\|\|`, `;` command chaining |
| `banPipeToFilter` | Ban piping to filter commands (grep, head, tail, etc.) |
| `banFileOperationCommands` | Ban cat, sed, head, tail, awk (use dedicated tools) |
| `banFindExec` | Ban `find -exec` / `-execdir` (use dedicated tools) |
| `banOutdatedYearInSearch` | Ban web searches containing recent but outdated years (2020+ but before current) |
| `banAbsolutePaths` | Ban absolute paths under cwd in Bash commands (use relative paths) |
| `banHomeDirAbsolutePaths` | Ban absolute paths under home directory in Bash commands (use `~/...`) |
| `banWrongPackageManager` | Ban using wrong package manager for the project |
| `requireCoAuthorshipProof` | Require co-authorship proof PIN for Co-authored-by commits |
| `logToolUse` | Log non-read-only tool usage |

**MCP server flags:**

| Flag | Description |
|---|---|
| `claudex` | Register the claudex MCP server in `~/.claude.json` |

Setting `hooks: true` enables all recommended checks and registers hooks in `~/.claude/settings.json`. Setting `hooks: { ... }` enables only listed checks; any truthy value triggers hook registration. When `hooks` is not set (default), all recommended checks are enabled.

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

## Memory Search

Search across Claude Code conversation transcripts for past sessions:

```bash
claudex-memory-search <pattern>
```

Searches all sessions for the current project by default. Supports both literal string and regex matching.

### Options

| Flag | Description |
|---|---|
| `-u, --user` | Search user messages |
| `-a, --assistant` | Search assistant text responses |
| `-c, --bash-command` | Search bash commands |
| `-o, --bash-output` | Search bash output/results |
| `-t, --tool-use` | Search tool use (any tool name + input) |
| `-r, --tool-result` | Search tool results (non-Bash) |
| `--project <path>` | Project path (defaults to cwd) |
| `--session <id>` | Search only a specific session |
| `-C, --context <n>` | Context lines around matches |
| `-B, --before-context <n>` | Context lines before matches |
| `-A, --after-context <n>` | Context lines after matches |
| `--max-results <n>` | Max results (default: 50) |
| `--max-line-width <n>` | Max output line width, 0 for unlimited (default: 200) |
| `--json` | JSON output |
| `-i, --ignore-case` | Case-insensitive search |

```bash
# Search all message types for a pattern
claudex-memory-search 'fix the tests'

# Search only bash commands, case-insensitive
claudex-memory-search -c -i 'yarn test'

# Show 2 lines of context around each match
claudex-memory-search -C 2 'TypeError'

# JSON output for scripting
claudex-memory-search --json 'pattern'
```

## Development

### Requirements

- Node.js 18, 20, or 22
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

## Binaries

- `claudex` - Main CLI wrapper
- `claudex-in-docker` - Docker container entry point
- `claudex-mcp` - MCP server for requirements tracking
- `claudex-memory-search` - Search Claude Code conversation transcripts
- `claudex-hook-pre-tool-use` - Pre-tool-use hook handler
- `claudex-hook-user-prompt-submit` - User prompt event handler
- `claudex-hook-notification` - Notification event handler (desktop notifications)
- `claudex-hook-stop` - Stop event handler (task completion notifications)
- `claudex-submit-co-authorship-proof` - Co-authorship proof submission tool

## Contributing

Contributions are welcome! Please ensure:

- All tests pass (`yarn test`)
- Code follows XO linting standards
- TypeScript compiles without errors
- New features include appropriate tests
