# Write-tool symlink tamper — ADR

**Status:** Addressed

## Attack vector

Agent uses the platform `write` tool to modify or replace symlinks in the rbash
PATH directory (`/tmp/opencode-bash/<hash>/`), injecting arbitrary executables.

The `write` tool uses `fs.writeFileString`, which **follows symlinks** — the
content lands at the target, not the link itself. If the target is user-writable
(e.g. `~/.local/bin/mytool`), the overwrite succeeds and the execute bit is
preserved (inode unchanged on `O_TRUNC`). Next invocation of that allowlisted
command runs the corrupted binary.

## Decision: auto-lock user-writable symlink targets

**Modules:** `src/write-lock.ts`, `src/init.ts`, `src/index.ts`

`initSymlinks` (`src/init.ts:108-114`) now checks each resolved executable path
with `fs.access(path, W_OK)`. User-writable paths are returned in a new
`InitResult.userWritableTargets` field.

The plugin (`src/index.ts`) passes these paths into `createWriteLock` via
a `dynamicPathsRef` mutable ref (`src/write-lock.ts:32-41`). The write-lock
hook checks the dynamic paths on every invocation alongside the static
`locked_scripts` config.

This means: if the user configures an allowlisted executable that resolves
to a user-writable location, the plugin **automatically blocks** `write` tool
calls to that path — no manual `locked_scripts` entry needed.

## Defense mapping

| Attempt | Result |
|---------|--------|
| Overwrite a symlink with a malicious script | **Fails** — `writeFileString` follows symlinks |
| Write through to a system binary (`/usr/bin/*`) | **Fails** — target root-owned, `EACCES` |
| Write to a dangling symlink | **Fails** — `ENOENT` |
| Replace symlink with a new file | **Fails** — `write` cannot `unlink` + `symlink` |
| Create fresh file at PATH location | **Fails at execution** — no +x bit |
| Write through symlink to user-writable target | **Fails** — blocked by auto-lock hook |
| Write directly to the target path | **Fails** — blocked by auto-lock hook |

## Residual risk: user misconfiguration

The auto-lock depends on the allowlist being correct:

| Misconfiguration | Risk |
|-----------------|------|
| Interpreter in allowlist (`python3`, `node`, `bash`) | Auto-lock protects the binary, but the interpreter can still execute arbitrary code via `-c` flags. `validate.ts:693-701` never inspects arguments. |
| No allowlist | Plugin won't start — `config.ts:107-111` rejects empty `allow`. |
| User installs a tool post-startup | Auto-lock runs only when `initSymlinks` is first triggered (first command). Newly installed tools are not protected until the plugin restarts. |
| Timing gap before first command | `initSymlinks` hasn't run → `userWritableRef.current` is `[]`. Writes before the first command bypass the auto-lock. |

## See also

- `src/write-lock.ts` — `createWriteLock` helper with `dynamicPathsRef`
- `src/init.ts:108-114` — writability check during symlink creation
- `src/index.ts:397-401` — plugin wiring of the dynamic ref
