# Architecture Review

This document identifies structural issues in the claudex codebase and proposes
concrete refactoring steps, ordered from lowest-effort / highest-impact to
higher-effort improvements.

---

## 1. Split the God-File `src/index.ts` (~1,250 lines)

**Impact: high | Effort: low-medium**

`index.ts` currently owns every concern of the host-side entry point:

| Responsibility | Lines (approx.) |
|---|---|
| CLI flag parsing & `main()` | 447–532 |
| `runMain()` orchestrator | 534–917 |
| Docker image building | 137–193 |
| Docker container running | 628–854 |
| SSH agent lifecycle | 69–112 |
| Host-port proxy lifecycle | 1,070–1,124 |
| Port-readiness polling | 1,126–1,148 |
| In-container port forwarding | 1,151–1,212 |
| `mainInDocker()` entry point | 1,214–1,247 |
| Hook symlink setup | 948–1,029 |
| Known-hosts injection | 1,031–1,057 |
| Launcher resolution & building | 374–425 |
| Background Docker stage refresh | 229–318 |
| Directory-safety check | 320–353 |
| Volume / env / SSH spec parsers | 355–373 |
| MCP server config writer | 114–135 |

**Suggested split:**

```
src/
  docker/
    build.ts          # ensureDockerImage, refreshDockerStagesInBackground
    run.ts            # docker run arg assembly, container execution
  ssh/
    agent.ts          # startSshAgent
    known-hosts.ts    # getFilteredKnownHosts → move from config.ts, setupKnownHosts
  port-proxy/
    host.ts           # startHostPortProxies, waitForPort, getDockerBridgeGateway
    container.ts      # setupHostPortForwarding (the in-container side)
  launcher.ts         # resolveLauncherDefinition, buildLauncherCommand (already exported)
  in-docker.ts        # mainInDocker + setupHookSymlinks
  safety.ts           # isUnsafeDirectory
  index.ts            # main(), runMain() wiring only
```

Each new file is cohesive, independently testable, and under ~150 lines.

---

## 2. Remove the Duplicate `parseJsonWithSchema`

**Impact: medium | Effort: very low**

An identical helper exists in two places:

* `src/hooks/shared.ts` — wraps errors with `ParseJsonWithSchemaError`
* `src/index.ts` line 943 — private, plain, no error wrapping

The private copy in `index.ts` is used only by `setupHookSymlinks`.
Delete it and import from `hooks/shared.ts`, or move the shared version to
`src/utils.ts` and import from both callers.

---

## 3. Fix the Semantic Inconsistency in `resolveHooks(undefined)`

**Impact: medium | Effort: very low**

```ts
// src/config.ts  lines 114-130
export function resolveHooks(hooks: HooksConfig | undefined): Required<HooksDetail> {
    if (hooks === true) {
        // returns recommended values ✓
    }
    if (!hooks) {
        // also returns recommended values — but docs say "off by default" ✗
    }
    // explicit object: returns per-key values ✓
}
```

When `hooks` is `undefined` (the user has not configured anything) every rule
with `recommended: true` silently fires. The README says hooks are *off by
default*, which contradicts this behaviour.

**Fix:** when `hooks === undefined` return all-`false`:

```ts
if (!hooks) {
    return Object.fromEntries(allConfigKeys.map(k => [k, false])) as Required<HooksDetail>;
}
```

This also eliminates the dead-code duplication between the `true` and `!hooks`
branches.

---

## 4. Replace the Custom Argument Parser in `config-cli.ts`

**Impact: medium | Effort: low**

`src/config-cli.ts` ships its own `parseArgs()` loop (~100 lines) that
hand-rolls `--global`, `--project`, `--group`, `--profile`, `--file`, and
`--members` detection. Commander is already a declared dependency and is used
in `index.ts`. Rewriting `configMain` to be a proper Commander sub-command tree
(or extending the existing `configCommand` in `index.ts`) would:

* remove duplicated flag-parsing logic
* provide automatic `--help` for each sub-command
* make it consistent with the rest of the CLI surface

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
