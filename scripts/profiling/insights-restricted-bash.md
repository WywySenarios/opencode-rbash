# Insights for a Restricted Bash Tool

Generated from profiling 2,077 bash toolcalls (4,062 individual commands, 257 unique executables) in the opencode agent's SQLite DB.

---

## 1. The 80/20 — executables your tool must support

Nine executables account for **73% of all commands**:

| Executable | Share | Typical flags / subcommands | Role in a restricted tool |
|------------|-------|----------------------------|---------------------------|
| `echo` | 12.9% | free-text messages | Logging, status, `\|\| echo "not found"` fallbacks. Trivial. |
| `git` | 10.9% | `diff` (23%), `status` (18%), `log` (17%), `add` (9.5%), `show` (6%), `ls-files` (3%), `commit` (2%) | Read-heavy VCS. Only `commit` (2%) writes. |
| run.sh | 10.5% | `agentic test -- -k "TestName"` | Project-specific test runner. Hardcoded path. Needs a generic "run an arbitrary script" escape hatch. |
| `ls` | 10.2% | `-la` (51%), no flags (41%), `-laR` (2%) | Directory listing. Simple, safe. |
| `grep` | 6.8% | `-E` (18%), `-v` (15%), `-n` (14%), `-i` (7%), `-r` (5%) | Content search. Reads only. |
| `head` | 4.6% | `-5` (27%), `-20` (23%), `-10` (12%), `-30` (10%), `-50` (8%) | Output truncation. |
| `find` | 4.6% | `-name`, `-type`, `-maxdepth 3`, `-exec` | File discovery across known roots. |
| `cat` | 3.7% | file paths (config files, `package.json`, state) | Raw file reading. |
| `tail` | 2.5% | `-30` (16%), `-40` (14%), `-80` (12%), `-5` (11%), `-10` (11%) | Output truncation (tail end). |

### Secondary tier (another ~14%)

| Executable | Share | Notes |
|------------|-------|-------|
| `cd` | 2.7% | Directory navigation. Two roots only. |
| `docker` | 2.9% | `compose up/down`, `exec`, `ps`, `logs`, `volume ls` |
| `python3` | 2.5% | `-c` inline scripts, `-m pytest`, `-m pip install` |
| `stat` | 1.3% | `-c '%a %U:%G'` — permission/ownership inspection |
| `mkdir` | 1.1% | `-p` always |
| `chmod` | 1.0% | `+x`, `664`, `2750` |
| `rm` | 1.0% | Mostly cleanup |
| `which` | 1.0% | Tool availability checks |
| `sudo` | 0.8% | Privileged operations (chown, chmod, apt) |
| `npx` | 0.9% | Astro dev server, linting |
| `npm` | 0.5% | `install`, `run` |
| `curl` | 0.3% | API health checks inside containers |

---

## 2. Compound commands — the hard engineering problem

**44.4%** of all toolcalls chain multiple commands together. A restricted bash tool cannot just run a single executable — it needs a mini-shell that parses and executes compound chains with proper semantics.

| Operator | % of toolcalls | Example |
|----------|---------------|---------|
| `\|` (pipe) | 20.2% | `git diff \| head -20` |
| `&&` (AND) | 16.9% | `cd dir && python3 -m pytest` |
| `\|\|` (OR) | 9.5% | `stat file \|\| echo "not found"` |
| `;` (semicolon) | 11.1% | `echo "==="; git status` |
| 2+ operators | 11.4% | `cmd1 && cmd2 \|\| cmd3 \| cmd4` |

### Key architectural implications

- **Pipe support is mandatory.** 1 in 5 toolcalls pipes output between commands.
- **`&&` is the primary control flow.** Sequential execution on success.
- **`||` is the primary error fallback.** The agent expects non-fatal error handling.
- **Chain lengths vary widely.** Most are 1–3 commands, but the longest chain observed is **60 commands** (a heredoc writing a multi-file implementation plan). The tool should handle arbitrary-length chains.
- **Subshells `$(...)` appear in 2.3%** of commands — used for dynamic values like `DIR=$(mktemp -d)`. The parser must handle nested `$(...)` without splitting on internal spaces.
- **Line continuations** (trailing `\`) appear in 1.3% of commands, mostly in shell scripts passed inline.

---

## 3. Output management — the silent requirement

`head` and `tail` are used aggressively to truncate command output. This is the agent saying *"commands produce too much output, I only want N lines."*

| Line count | `head` usage | `tail` usage |
|-----------|-------------|-------------|
| 5 | 27% | 11% |
| 10 | 12% | 11% |
| 20 | 23% | 10% |
| 30 | 10% | 16% |
| 40 | 4% | 14% |
| 50 | 8% | 8% |
| 80 | 2% | 12% |
| 100 | 3% | 4% |

**Recommendations:**
- **Cap output at ~200 lines by default** (covers most use, the agent can request more).
- **Provide a built-in truncation parameter** so the agent doesn't need `\| head -N` on every command.
- **Merge stderr into stdout by default** (`2>&1` is used in 14.4% of commands). The agent wants to see errors inline.

---

## 4. Error handling — what the agent expects

| Pattern | Prevalence | Meaning |
|---------|------------|---------|
| `2>/dev/null` | 13.6% of commands | Silence expected, benign errors (file not found, permission denied on probe) |
| `\|\| echo "..."` | ~9.5% of toolcalls | On failure, print a message, continue the chain (don't crash) |
| `$?` checks | 0.7% | Manual exit code inspection — rare |
| `2>&1` | 14.4% | Merge stderr into stdout for unified output |

### Design implications

1. **Don't fail-fatally.** The dominant pattern is `cmd || echo "fallback"` — errors are caught and handled inline. A restricted bash tool should:
   - Return stderr in the response body (not as an exception)
   - Set a non-zero exit code in the response metadata, but still return all output
   - Let the calling agent decide whether a failure matters

2. **Default to silent stderr suppression for probe commands.** `ls`, `stat`, `find`, `cat` are often used to check existence — the `2>/dev/null` pattern says "I expect these to fail sometimes, don't bother me."

---

## 5. Patterns worth baking in

### Heredocs
`cat > file << 'EOF'` appears in ~2% of commands (writing plan files, scripts, compose configs). The tool needs to support multi-line input with a delimiter.

### Working directory
`cd` accounts for 2.7% of commands. All observed `cd` targets fall under two roots:
- `/usr/local/Wywy-Website/...` (79%)
- `/etc/Wywy-Website-Control/...` (21%)

The tool should maintain a **persistent working directory** so `cd` + subsequent commands work naturally.

### Env vars
Commands reference `$HOME`, `$USER`, `$DIR`, and project-specific variables. A restricted tool needs to define which environment variables are available, and whether they're pre-populated or settable.

### Docker complexity
`docker` accounts for 2.9% of commands, but those commands are among the most complex:
- `docker compose -f file1 -f file2 up -d --wait`
- `docker exec <container> <command>`
- `docker logs <container> 2>&1 | grep "pattern"`
- `docker ps --filter "name=..." --format "{{.Names}}"`

If you allow `docker`, you essentially allow arbitrary execution inside containers.

---

## 6. Areas to explore further

### A. Filesystem heatmap

We know `cd` targets only 2 roots. But `ls`, `find`, `cat`, `stat`, `grep` also target paths. A full **path distribution analysis** would tell you:
- Exactly which directories are read vs. written
- Whether all paths fall under a small set of prefixes
- Which paths can be read-only vs. read-write

### B. Git workflow graph

The top git subcommands are `diff`, `status`, `log`, `add`, `show`, `ls-files`, `commit`. **Sequence mining** on compound chains would reveal the real workflows:
- `git diff` → `git add` → `git commit`?
- `git log` → `grep` → `git show`?
- `git status` → `git diff`?

### C. Command duration distribution

The profiling DB has a `duration_ms` column per toolcall. Pulling it would distinguish:
- **Fast** (<500ms): `ls`, `cat`, `git status`, `echo`, `head`
- **Medium** (500ms–5s): `grep`, `find`, `git log`, `stat`
- **Slow** (>5s): `run.sh` tests, `docker compose up`, `pip install`, `npx astro`

This tells you where to add timeouts and whether to support async execution.

### D. Failure rate per executable

Some commands clearly expect to fail sometimes (they use `2>/dev/null` or `||`). But what's the actual failure rate?
- `find / -name ... 2>/dev/null` — succeeds but with permission errors
- `docker exec ... || echo "not found"` — container may not be running
- `stat /some/path 2>/dev/null` — path may not exist

Knowing real failure rates would help calibrate the tool's error tolerance.

### E. Command clustering

Do certain commands always appear together? Early observations suggest:

| Cluster | Commands | Purpose |
|---------|----------|---------|
| **Probe** | `ls` → `cat` → `grep` → `head` | Explore and inspect a target |
| **Docker** | `docker compose` → `docker exec` → `docker logs` | Container lifecycle |
| **Permission** | `stat` → `chmod` → `setfacl` → `getfacl` | Fix ownership/permissions |
| **Test** | `cd` → `run.sh` → `head` | Run tests, inspect results |
| **Git** | `git diff` → `git add` → `git commit` | Commit workflow |
| **Plan-write** | `cat > file << 'EOF'` → (60-line heredoc) | Write implementation plans |

A formal **cluster analysis** (co-occurrence matrix) would reveal the actual grammars of the agent's bash usage.

### F. Environment variable usage survey

How many commands reference environment variables?
- `$HOME`, `$USER`, `$DIR`, `$TESTDIR`, `$PIPELINE`
- `DOCKER_GID=$(stat ...)`, `WYWY_FS_ROOT`, `WYWY_FS_GID`
- Docker compose variables, docker exec variables

A restricted tool would need a defined env-var schema.

### G. Write vs. read ratio

Preliminary estimate: **~90% of commands are read-only.** The writes are:
- `git commit` / `git add` (infrequent)
- `mkdir` / `chmod` / `rm` (infrastructure setup)
- `cat > file << 'EOF'` (plan/script writing)
- `docker compose up` / `docker compose down`

Quantifying this ratio would inform the tool's security model — can most commands be sandboxed as read-only?

---

## Methodology

- **Source:** opencode SQLite DB (`~/.local/share/opencode/opencode.db`), `part` and `event` tables
- **Extraction:** `extract-bash-toolcalls.py` — queries DB, writes one command per line to `data/bash_toolcalls.log`
- **Analysis:** `profile-executables.py` — splits compound commands on `&&`, `||`, `|`, `;` (quote-aware), extracts executable (first non-flag, non-assignment token), prints frequency table
- **Compound splitter:** Character-by-character parser respecting single/double quotes, backslash escapes, and `$(...)` nesting depth
- **Executable extractor:** Skips leading `VAR=value` assignments, bare backslash artifacts, and bare flags that are split artifacts
