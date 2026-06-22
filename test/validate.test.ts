/**
 * Tests for the validation module (src/validate.ts)
 *
 * Verifies:
 * - Executable allowlist checking (Step A)
 * - Pipe chain validation (Step B)
 * - Compound command parsing (&&, ||, ;, |)
 * - Dynamic command rejection ($PROG)
 * - Error message formatting
 * - Entire-chain rejection on any single violation
 */

import { validateCommand } from "../src/validate"
import type { AllowConfig } from "../src/config"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ALLOWLIST: AllowConfig = {
  ls: {},
  echo: {},
  git: {},
  cat: { pipe_to: ["grep", "wc", "sort", "sed", "rg", "uniq"] },
  wc: {},
  grep: {},
  sort: {},
  sed: {},
  rg: {},
  uniq: {},
  mkdir: {},
  rm: {},
  cp: {},
  mv: {},
  touch: {},
  chmod: {},
  docker: {},
  python3: {},
  npm: {},
  npx: {},
  curl: {},
  true: {},
  false: {},
  stat: {},
  getent: {},
  id: {},
  getfacl: {},
  setfacl: {},
}

type ValidationResult = ReturnType<typeof validateCommand>

// ---------------------------------------------------------------------------
// Step A — Executable allowlist check
// ---------------------------------------------------------------------------

describe("validateCommand — executable allowlist (Step A)", () => {
  it("allows a simple allowed command", () => {
    const result = validateCommand("ls -la", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("rejects a disallowed command", () => {
    const result = validateCommand("head -5 package.json", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/not in.*allowlist/i)
  })

  it("rejects with the executable name in the error message", () => {
    const result = validateCommand("vim file.txt", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })

  it("error message is generic (does not reveal allowlist)", () => {
    const result = validateCommand("vim file.txt", SAMPLE_ALLOWLIST)
    // Should not say "ls is in the allowlist but vim is not"
    expect(result.error).not.toMatch(/ls/)
    // Should not list available executables
    expect(result.error).not.toMatch(/available|permitted.*:.*ls/)
  })

  it("allows commands with arguments and flags", () => {
    const result = validateCommand("git diff --cached --stat", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects empty command string", () => {
    const result = validateCommand("", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  it("rejects command containing only whitespace", () => {
    const result = validateCommand("   ", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Step B — Pipe chain validation
// ---------------------------------------------------------------------------

describe("validateCommand — pipe chain validation (Step B)", () => {
  it("allows pipe to an allowed pipe_target", () => {
    const result = validateCommand("cat package.json | grep version", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects pipe to an unallowed pipe_target", () => {
    const result = validateCommand("cat package.json | python3 -c 'print(1)'", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pipe/i)
  })

  it("error message includes both source and target executable names", () => {
    const result = validateCommand("cat .env | docker exec -i container sh", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("cat")
    expect(result.error).toContain("docker")
  })

  it("allows pipe when source has no pipe_to restriction", () => {
    const result = validateCommand("ls -la | grep test", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("blocks pipe when source has empty pipe_to array (no piping allowed)", () => {
    // echo has pipe_to: [] in the fixture? Actually let me use a restricted exec
    const restrictedAllowList: AllowConfig = {
      ...SAMPLE_ALLOWLIST,
      restricted_cmd: { pipe_to: [] },
    }
    const result = validateCommand("restricted_cmd foo | grep bar", restrictedAllowList)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pipe/i)
  })

  it("allows pipes longer than 2 commands when all targets are valid", () => {
    const result = validateCommand("cat data.csv | grep header | sort | uniq", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects 3+ pipe chain when any link violates pipe_to rule", () => {
    const result = validateCommand("cat data.csv | grep header | python3 -c 'x=1'", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })

  it("allows pipe to executable without pipe_to entry at all (implicit no restriction)", () => {
    const allowListNoPipeRules: AllowConfig = {
      ls: {},
      grep: {},
      wc: {},
    }
    const result = validateCommand("ls | wc", allowListNoPipeRules)
    expect(result.valid).toBe(true)
  })

  it("allows pipe on receiving end (source pipes TO cat, cat has pipe_to)", () => {
    // cat's pipe_to restricts outgoing pipes, not incoming
    const result = validateCommand("git diff | cat", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("blocks pipe chain where a middle command violates its pipe_to", () => {
    const restrictedAllowList: AllowConfig = {
      ...SAMPLE_ALLOWLIST,
      middle_cmd: { pipe_to: ["echo"] },
    }
    const result = validateCommand("echo hello | middle_cmd stuff | cat", restrictedAllowList)
    // middle_cmd can only pipe to echo, but it's piping to cat
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Compound commands
// ---------------------------------------------------------------------------

describe("validateCommand — compound commands", () => {
  it("allows && chain when all commands are allowed", () => {
    const result = validateCommand("git add . && git commit -m 'msg' && git push", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects && chain when one command is disallowed", () => {
    const result = validateCommand("git add . && vim file && git commit", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })

  it("allows || chain when all commands are allowed", () => {
    const result = validateCommand("ls || echo not found", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows ; separated commands when all are allowed", () => {
    const result = validateCommand("ls; echo done; git status", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects ; separated commands when one is disallowed", () => {
    const result = validateCommand("ls; vim file; echo done", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })

  it("handles mix of pipes and compound operators", () => {
    const result = validateCommand(
      "cat log.txt | grep error && echo 'found errors' || echo 'all clear'",
      SAMPLE_ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })

  it("rejects entire chain when compound + pipe mix has one violation", () => {
    const result = validateCommand(
      "cat log.txt | head -5 && echo done",
      SAMPLE_ALLOWLIST
    )
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dynamic command names
// ---------------------------------------------------------------------------

describe("validateCommand — dynamic command names", () => {
  it("rejects commands with variable-based executables", () => {
    const result = validateCommand('$PROG --help', SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })

  it("rejects commands with env-var based executables", () => {
    const result = validateCommand('${EDITOR} file.txt', SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })

  it("rejects commands with brace-expanded executables", () => {
    const result = validateCommand('{ls,echo} --help', SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Absolute paths
// ---------------------------------------------------------------------------

describe("validateCommand — absolute paths", () => {
  it("rejects commands using absolute executable path", () => {
    const result = validateCommand("/bin/ls -la", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/absolute|\//i)
  })

  it("rejects commands using relative executable path", () => {
    const result = validateCommand("./script.sh", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })

  it("rejects commands using parent-relative executable path", () => {
    const result = validateCommand("../bin/script.sh", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("validateCommand — edge cases", () => {
  it("handles heredocs", () => {
    const result = validateCommand("cat << EOF\nhello\nEOF", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("handles subshell commands", () => {
    const result = validateCommand("echo $(git rev-parse HEAD)", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects subshell with disallowed command inside", () => {
    const result = validateCommand("echo $(vim file.txt)", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })

  it("handles line continuations (backslash-newline)", () => {
    const result = validateCommand("git diff \\\n  --cached", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects commands that match only after stripping path", () => {
    const result = validateCommand("/usr/local/bin/ls", SAMPLE_ALLOWLIST)
    expect(result.valid).toBe(false)
  })
})
