/**
 * Tests for unhandled shell operators.
 *
 * The current token-based parser handles &&, ||, ;, and | but misses:
 * - & (background operator) — should act as a command separator
 * - |& (pipe with stderr) — should not be split at |
 * - ( ) subshell with background & after
 *
 * These tests define the expected behavior BEFORE the parser is fixed,
 * serving as the RED specification.
 */

import { validateCommand } from "../src/validate"
import type { AllowConfig } from "../src/config"

const ALLOWLIST: AllowConfig = {
  ls: {},
  echo: {},
  wait: {},
  cat: { pipe_to: ["grep", "wc"] },
  grep: {},
  wc: {},
}

// ---------------------------------------------------------------------------
// & background operator
// ---------------------------------------------------------------------------

describe("validateCommand — & background operator", () => {
  it("validates command before &", () => {
    const result = validateCommand("ls -la &", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("validates both commands when separated by &", () => {
    const result = validateCommand("ls -la & echo done", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects disallowed command after &", () => {
    const result = validateCommand("ls -la & vim file.txt", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })

  it("rejects disallowed command before &", () => {
    const result = validateCommand("vim file.txt & echo done", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })

  it("validates commands chained with multiple &", () => {
    const result = validateCommand("ls & echo a & echo b & echo c", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("does not confuse & with &&", () => {
    // & (background) and && (AND) are different operators
    const result = validateCommand("ls & echo a && echo b", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("does not split at & inside quoted string", () => {
    const result = validateCommand('echo "foo & bar"', ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("does not split at & inside $() subshell", () => {
    const result = validateCommand("echo $(ls & wait)", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects disallowed command inside subshell with &", () => {
    const result = validateCommand("echo $(ls & vim file.txt)", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })
})

// ---------------------------------------------------------------------------
// Pipe with stderr (|&)
// ---------------------------------------------------------------------------

describe("validateCommand — |& pipe operator", () => {
  it("handles |& as a single operator (pipe with stderr)", () => {
    // |& pipes both stdout and stderr — should be treated as a pipe
    const result = validateCommand("ls -la |& grep txt", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("validates pipe_to rules for |& operator", () => {
    // cat pipe_to only allows grep, wc — should be fine
    const result = validateCommand("cat file.txt |& wc -l", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects pipe_to violation with |& operator", () => {
    // cat cannot pipe to echo
    const result = validateCommand("cat file.txt |& echo hi", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pipe/i)
  })
})

// ---------------------------------------------------------------------------
// Mixed operators
// ---------------------------------------------------------------------------

describe("validateCommand — mixed operators", () => {
  it("handles & followed by | in separate commands", () => {
    // Command1: ls & (background), Command2: cat | grep
    const result = validateCommand("ls & cat file.txt | grep pattern", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("validates all executables across & and && chains", () => {
    const result = validateCommand(
      "ls & echo a && cat file.txt | grep pattern && echo b & wait",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })
})
