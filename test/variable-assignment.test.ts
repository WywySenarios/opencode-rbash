/**
 * Tests for variable assignment prefix in commands (VAR=value cmd).
 *
 * In bash, variable assignments before a command set environment
 * variables for that command. The executable is the word AFTER
 * the assignments, not the assignment itself.
 *
 * Current parser limitation: extractExecutable() takes the first
 * word as the executable name, so "FOO=bar ls" would reject
 * "FOO=bar" instead of extracting "ls".
 */

import { validateCommand } from "../src/validate"
import type { AllowConfig } from "../src/config"

const ALLOWLIST: AllowConfig = {
  ls: {},
  cat: { pipe_to: ["grep"] },
  grep: {},
  wc: {},
  echo: {},
  true: {},
}

// ---------------------------------------------------------------------------
// Basic assignment + command
// ---------------------------------------------------------------------------

describe("validateCommand — variable assignment prefix", () => {
  it("allows a command prefixed by a variable assignment", () => {
    // The executable should be "ls", not "FOO=bar"
    const result = validateCommand("FOO=bar ls -la", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows a command with multiple variable assignments", () => {
    const result = validateCommand("A=1 B=2 C=3 ls -la", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows a standalone variable assignment (no command)", () => {
    // In bash, "FOO=bar" is valid — sets a shell variable
    // There's no executable to validate, so it should pass
    const result = validateCommand("FOO=bar", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("rejects a disallowed command after variable assignment", () => {
    // vim is not in the allowlist, should be rejected
    const result = validateCommand("FOO=bar vim file.txt", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })

  it("allows variable assignments with PATH-like variable name", () => {
    const result = validateCommand("PATH=/custom/bin ls", ALLOWLIST)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Assignment + pipe / compound
// ---------------------------------------------------------------------------

describe("validateCommand — assignment with pipes and compounds", () => {
  it("validates pipe chain correctly after assignment", () => {
    // "ls" pipes to "grep" — allowed per cat's rules? No, cat has pipe_to, not ls.
    // ls has no pipe_to restriction, so piping to grep is allowed
    const result = validateCommand(
      "MY_VAR=data ls -la | grep pattern",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })

  it("rejects pipe violation after assignment", () => {
    // cat has pipe_to: ["grep"] only, piped to wc should fail
    const result = validateCommand("X=1 cat data.txt | wc -l", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pipe/i)
  })

  it("validates compound chains with assignment", () => {
    const result = validateCommand(
      "EDITOR=vim echo hi && FOO=bar ls",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })

  it("rejects disallowed command in compound chain after assignment", () => {
    const result = validateCommand(
      "DEBUG=1 ls && EDITOR=x vim file.txt",
      ALLOWLIST
    )
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })
})
