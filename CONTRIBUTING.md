# Contributing to claudex

## Error-Handling Strategy

All error handling in the codebase follows these three rules:

### 1. Expected-absent resources → silent skip, no log

Use an empty `catch` block (or a targeted `isErrnoException(error) && error.code === 'ENOENT'`
guard) when the absent resource is the normal case and no action is required. Examples:

- Config file not yet created by the user
- `.git` directory absent because the CWD is not a git repository
- `known_hosts` file absent on a fresh machine

```ts
try {
  content = await fs.readFile(configPath, 'utf8');
} catch (error) {
  if (!isErrnoException(error) || error.code !== 'ENOENT') {
    throw error;
  }
  // File doesn't exist yet — use defaults
}
```

### 2. Degraded-but-recoverable → `console.warn` with context

Emit a `console.warn` message that includes enough context for the user to act when the
operation fails but claudex can still continue in a reduced capacity. Examples:

- Creating a hook symlink fails (e.g. permission denied)
- Sending a desktop notification fails
- A config file contains invalid JSON and must be overwritten

```ts
try {
  await fs.symlink(targetPath, hookCommand);
} catch (error) {
  console.warn(`Warning: Could not create hook symlink at ${hookCommand}: ${error instanceof Error ? error.message : String(error)}`);
}
```

### 3. Fatal precondition → throw / `invariant`

Throw an error (or use the `invariant` helper) when the program cannot continue correctly
without the resource. Examples:

- A required hook executable is not on `PATH`
- A required environment variable is absent

```ts
invariant(preToolUsePath, 'claudex-hook-pre-tool-use executable must be found');
```

---

Keeping these three patterns consistent makes it easy for contributors and users to understand
what claudex considers "expected", "degraded", and "fatal".
