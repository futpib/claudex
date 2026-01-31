# claudex

[![Coverage Status](https://coveralls.io/repos/github/futpib/claudex/badge.svg?branch=master)](https://coveralls.io/github/futpib/claudex?branch=master)

A CLI wrapper and hook management system for Anthropic's Claude Code that adds safety guardrails, co-authorship tracking, and memory management capabilities.

## Features

- **Safety Layer**: Prevents dangerous git operations (bypassing hooks, amending other developers' commits)
- **Co-Authorship Verification**: Cryptographic proof system to validate Claude's actual contributions to commits
- **Session Tracking**: Comprehensive logging of tool usage and user interactions
- **Memory Management**: Modular CLAUDE.md file generation from organized configuration directory
- **Automatic Updates**: Checks for and installs Claude Code updates
- **Hook System**: Extensible pre-tool-use and user-prompt-submit hooks

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

Replace `claude-code` with `claudex` in your workflow:

```bash
# Instead of: claude-code
claudex

# All arguments are passed through to Claude Code
claudex --help
```

On first run, `claudex` will:
1. Set up required hooks in Claude Code's configuration
2. Generate unified memory file from `~/.config/claudex/CLAUDE.md.d/`
3. Check for Claude Code updates

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
       ├─► Checks for @anthropic/claude-code updates
       │
       └─► Spawns claude
           │
           ├─► pre-tool-use hook validates operations
           └─► user-prompt-submit hook logs interactions
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
- `unset <key> [<value>]` — remove a key, or remove a specific value from an array

### Scope Flags

- *(none)* — current project (`projects[<cwd>]` section)
- `--global` — root-level config
- `--project <path>` — `projects[<path>]` section (explicit)
- `--group <name>` — `groups[<name>]` section
- `--file <path>` — target a specific file (relative to config dir)

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
| `group` | string (project only) | set, unset |

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
```

## Configuration

### Hooks and MCP Servers

Pre-tool-use hook checks and MCP server registration are **off by default**. Enable them in your claudex config:

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
| `banGitAddAll` | Ban `git add -A` / `--all` / `--no-ignore-removal` |
| `banGitCommitAmend` | Ban `git commit --amend` |
| `banGitCommitNoVerify` | Ban `git commit --no-verify` |
| `banGitCheckoutRedundantStartPoint` | Ban redundant start-point in `git checkout -b` on detached HEAD |
| `banBackgroundBash` | Ban `run_in_background` bash commands |
| `banCommandChaining` | Ban `&&`, `\|\|`, `;` command chaining |
| `banPipeToFilter` | Ban piping to filter commands (grep, head, tail, etc.) |
| `banFileOperationCommands` | Ban cat, sed, head, tail, awk (use dedicated tools) |
| `banOutdatedYearInSearch` | Ban web searches containing recent but outdated years (2020+ but before current) |
| `requireCoAuthorshipProof` | Require co-authorship proof PIN for Co-authored-by commits |
| `logToolUse` | Log non-read-only tool usage |

**MCP server flags:**

| Flag | Description |
|---|---|
| `claudex` | Register the claudex MCP server in `~/.claude.json` |

Setting `hooks: true` enables all 12 checks and registers hooks in `~/.claude/settings.json`. Setting `hooks: { ... }` enables only listed checks; any truthy value triggers hook registration. When `hooks` is not set (default), no checks fire and no hooks are registered.

### Hook Configuration

Hooks are configured in `~/.claude/settings.json` when any hook flag is enabled:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/claudex-hook-pre-tool-use"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/claudex-hook-user-prompt-submit"
          }
        ]
      }
    ]
  }
}
```

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

The package provides four executable commands:

- `claudex` - Main CLI wrapper
- `claudex-hook-pre-tool-use` - Pre-tool-use hook handler
- `claudex-hook-user-prompt-submit` - User prompt event handler
- `claudex-submit-co-authorship-proof` - Co-authorship proof submission tool

## Contributing

Contributions are welcome! Please ensure:

- All tests pass (`yarn test`)
- Code follows XO linting standards
- TypeScript compiles without errors
- New features include appropriate tests
