/**
 * Edge case tests for the validation module (src/validate.ts)
 *
 * Tests scenarios that the token-based parser may not handle
 * correctly, particularly around:
 * - Subshells containing pipes (nested pipelines)
 * - Process substitution <(...) and >(...)
 * - Variables in arguments (allowed)
 * - Chained redirects combined with pipes
 * - Multiple independent subshells
 */

import { validateCommand } from "../src/validate"
import type { AllowConfig } from "../src/config"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALLOWLIST: AllowConfig = {
  ls: {},
  echo: {},
  cat: { pipe_to: ["grep", "wc", "sort", "sed", "rg", "uniq"] },
  wc: {},
  grep: {},
  sort: {},
  diff: {},
  tee: {},
  git: {},
  python3: {},
}

// ---------------------------------------------------------------------------
// Subshells with pipes
// ---------------------------------------------------------------------------

describe("validateCommand — subshell pipes", () => {
  it("extracts all executables from a subshell containing a pipe", () => {
    // Both cmd1 and cmd2 inside the subshell must be validated
    const allowWithCmds: AllowConfig = {
      ...ALLOWLIST,
      cmd1: {},
      cmd2: {},
    }
    const result = validateCommand("echo $(cmd1 | cmd2)", allowWithCmds)
    expect(result.valid).toBe(true)
  })

  it("rejects subshell pipe when one command is disallowed", () => {
    const allowWithCmd1: AllowConfig = {
      ...ALLOWLIST,
      cmd1: {},
      // cmd2 is NOT in the allowlist
    }
    const result = validateCommand("echo $(cmd1 | cmd2)", allowWithCmd1)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("cmd2")
  })

  it("validates pipe_to rules inside subshell pipelines", () => {
    // cat inside subshell has pipe_to restrictions
    const result = validateCommand(
      "echo $(cat data.txt | python3 -c 'x=1')",
      ALLOWLIST
    )
    // python3 is not in cat.pipe_to
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pipe/i)
  })
})

// ---------------------------------------------------------------------------
// Multiple independent subshells
// ---------------------------------------------------------------------------

describe("validateCommand — multiple subshells", () => {
  it("extracts executables from multiple independent subshells", () => {
    const result = validateCommand("echo $(ls) && echo $(wc -l file)", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects if any subshell contains a disallowed command", () => {
    const result = validateCommand("echo $(ls) && echo $(vim file.txt)", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })

  it("handles chained subshells (subshell within subshell)", () => {
    const result = validateCommand(
      "echo $(echo $(git log -1))",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })

  it("rejects chained subshell with disallowed innermost command", () => {
    const result = validateCommand(
      "echo $(echo $(vim file.txt))",
      ALLOWLIST
    )
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Process substitution <(...) and >(...)
// ---------------------------------------------------------------------------

describe("validateCommand — process substitution", () => {
  it("extracts executables from process substitution <(...)", () => {
    const result = validateCommand("diff <(ls dir1) <(ls dir2)", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects disallowed command inside <(...)", () => {
    const result = validateCommand("diff <(vim file) <(ls dir)", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })

  it("extracts executables from process substitution >(...)", () => {
    const result = validateCommand("tee >(grep pattern > out.txt)", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects disallowed command inside >(...)", () => {
    const result = validateCommand("tee >(vim file.txt)", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })
})

// ---------------------------------------------------------------------------
// Variables in arguments (should be allowed)
// ---------------------------------------------------------------------------

describe("validateCommand — variables in arguments", () => {
  it("allows environment variables in arguments", () => {
    const result = validateCommand("echo $HOME", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows command substitution as argument", () => {
    const result = validateCommand("echo $(git rev-parse HEAD)", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows brace expansion in arguments, not executable", () => {
    const result = validateCommand("ls {file1,file2}.txt", ALLOWLIST)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Redirects combined with pipes
// ---------------------------------------------------------------------------

describe("validateCommand — redirects", () => {
  it("allows commands with stderr redirect combined with pipe", () => {
    const result = validateCommand("cat log.txt 2>&1 | grep error", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows commands with stdout redirect to file", () => {
    const result = validateCommand("grep pattern file.txt > output.txt", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows commands with append redirect", () => {
    const result = validateCommand("echo new line >> file.txt", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows multi-stage pipe with redirect in final command", () => {
    const result = validateCommand(
      "cat data.csv | grep header | sort > output.txt",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pipe chain isolation across compound operators
// ---------------------------------------------------------------------------

describe("validateCommand — pipe chain isolation", () => {
  it("validates each pipeline independently across &&", () => {
    // First pipeline: git diff (no pipe)
    // Second pipeline: cat | grep (cat pipes to grep which IS in pipe_to)
    const result = validateCommand(
      "git diff && cat package.json | grep version",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })

  it("blocks pipeline in one segment of &&", () => {
    // cat pipes to vim — vim is not in cat.pipe_to
    const result = validateCommand(
      "git diff && cat package.json | vim -",
      ALLOWLIST
    )
    expect(result.valid).toBe(false)
  })

  it("does not cascade pipe restrictions across && boundary", () => {
    // First: cat pipes to grep (allowed)
    // Second: python3 (no pipe, just standalone)
    const result = validateCommand(
      "cat log.txt | grep error && python3 -c 'x=1'",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })
})
