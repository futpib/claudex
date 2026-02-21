# Architecture Review

This document identifies structural issues in the claudex codebase and proposes
concrete refactoring steps, ordered from lowest-effort / highest-impact to
higher-effort improvements.

---

## 1. ~~Split the God-File `src/index.ts`~~ ✅ Done

Split into `docker/build.ts`, `docker/run.ts`, `ssh/agent.ts`, `ssh/known-hosts.ts`,
`port-proxy/host.ts`, `port-proxy/container.ts`, `launcher.ts`, `in-docker.ts`, `safety.ts`.

---

## 2. ~~Remove the Duplicate `parseJsonWithSchema`~~ ✅ Done

Removed the private copy from `src/index.ts` and imported from `hooks/shared.ts`.

---

## 3. ~~Fix the Semantic Inconsistency in `resolveHooks(undefined)`~~ ✅ Done

The code behavior (hooks on by default with recommended settings) was correct.
Updated the README to match.

---

## 4. ~~Replace the Custom Argument Parser in `config-cli.ts`~~ ✅ Done

Commander subcommands in `index.ts` now construct `ParsedArgs` directly and pass
to `configMain`. The raw-args reconstruction hack is eliminated. `parseArgs` is
kept as a private helper behind `configMainFromArgv` for internal callers.

---

## 5. Split `src/config.ts` by Concern (~920 lines)

**Impact: medium | Effort: low-medium**

`config.ts` mixes four distinct concerns:

| Concern | Suggested file |
|---|---|
| Zod schemas + TypeScript types | `src/config/schema.ts` |
| Config merge helpers | `src/config/merge.ts` |
| Config file I/O (read, write, find) | `src/config/io.ts` |
| Path / env expansion utilities | `src/config/expand.ts` |
| SSH utilities (getSshKeys, getSshHosts, getFilteredKnownHosts) | `src/ssh/known-hosts.ts` |
| Git utilities (getGitRoot, getGitWorktreeParentPath) | `src/git.ts` |

A re-export barrel `src/config/index.ts` keeps all existing import paths
working while the internals become navigable.

---

## 6. Consolidate Tilde-Collapse Helpers

**Impact: low | Effort: very low**

Three near-identical implementations exist:

| File | Function |
|---|---|
| `src/config.ts` | `expandTilde(path)` |
| `src/utils.ts` | `collapseHomedir(value)` |
| `src/config-cli.ts` | `collapseTilde(filePath)` (uses `fs.realpathSync`) |

Only one canonical pair (`expand` / `collapse`) should live in `src/utils.ts`;
callers import from there.

---

## 7. Deduplicate the `settingsSchema` / Settings Types

**Impact: low | Effort: very low**

The shape of `~/.claude/settings.json` is defined twice:

* `src/hooks.ts` — full `claudeSettingsSchema` with hook event names
* `src/index.ts` lines 933–941 — a slimmer `settingsSchema` used only by
  `setupHookSymlinks`

Both should use a single schema exported from `src/hooks.ts` (or a new
`src/claude-settings.ts`).

---

## 8. Add Index Files for Subdirectories

**Impact: low | Effort: very low**

`src/hooks/rules/index.ts` is the only subdirectory barrel today.
`src/host-socket/`, `src/mcp/`, `src/memory-search/`, and the proposed
`src/docker/`, `src/ssh/` should each export a public surface via `index.ts` so
callers use `import { startHostSocketServer } from './host-socket/index.js'`
rather than deep paths.

---

## 9. Increase Unit-Test Coverage of Core Logic

**Impact: high | Effort: medium**

The most critical paths have no or limited tests:

| Module | What to test |
|---|---|
| `config.ts` — `mergeBaseConfigs` | Profile/group/project precedence, PATH merge |
| `config.ts` — `getMergedConfig` | Worktree parent resolution, profile volume exclusion |
| `memory.ts` | `createClaudeCodeMemory` output, backup logic |
| `secrets.ts` | `shieldEnvVars` when gitleaks absent/present |
| `index.ts` — `isUnsafeDirectory` | Each unsafe-reason branch |
| `index.ts` — `buildAddDirArgs` | Exclusion of profile volumes |

The helper injection pattern already used in `dispatch.ts` (injecting `execa`)
makes tests straightforward without mocking the module system.

---

## 10. Adopt a Consistent Error-Handling Strategy

**Impact: medium | Effort: medium**

Currently the codebase mixes three patterns:

1. Silent swallow in empty `catch {}` blocks (e.g. reading missing config files)
2. `console.warn` + continue (e.g. hook symlink creation)
3. Re-throw / `invariant` assertion (e.g. `ensureHookSetup`)

A lightweight decision rule would reduce ambiguity:

* **Expected-absent resources** (config file doesn't exist yet) → silent skip,
  no log.
* **Degraded-but-recoverable** (hook symlink creation fails) → `console.warn`
  with context.
* **Fatal precondition** (hook binary not on PATH) → throw / `invariant`.

Document the rule in `CONTRIBUTING.md` and apply it consistently.
