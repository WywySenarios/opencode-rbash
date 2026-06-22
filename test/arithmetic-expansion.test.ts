/**
 * Tests for arithmetic expansion $(( ... )) in bash commands.
 *
 * In bash, $((expr)) is arithmetic expansion. The double parens
 * (( are NOT a subshell — they are a separate construct from (.
 *
 * Current parser limitation: ParseState.update() matches $( as a
 * subshell start regardless of the second character. $(( triggers
 * a depth increase for the $('(' pair and then again for the
 * standalone '(', causing the arithmetic expression to be treated
 * as nested subshells and corrupting the parse.
 */

import { validateCommand } from "../src/validate"
import type { AllowConfig } from "../src/config"

const ALLOWLIST: AllowConfig = {
  echo: {},
  ls: {},
  grep: {},
}

// ---------------------------------------------------------------------------
// Arithmetic expansion $((...))
// ---------------------------------------------------------------------------

describe("validateCommand — arithmetic expansion", () => {
  it("allows a command with $(( ... )) arithmetic expansion", () => {
    // $((1 + 2)) is arithmetic, not a subshell
    const result = validateCommand("echo $((1 + 2))", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows $(( ... )) with variable references inside", () => {
    const result = validateCommand("echo $((a + b))", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("allows $(( ... )) as an argument between other args", () => {
    const result = validateCommand(
      'echo "result: $((count + 1))"',
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })

  it("does not confuse $(( with a subshell inside $(())", () => {
    // The inner ( ... ) should not be parsed as a subshell
    const result = validateCommand("echo $(( (1 + 2) * 3 )) ", ALLOWLIST)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Correct subshells (should still work)
// ---------------------------------------------------------------------------

describe("validateCommand — subshells still work alongside arithmetic", () => {
  it("still validates standalone subshells", () => {
    const result = validateCommand("echo $(ls -la)", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("does not confuse $( with $(( when followed by paren", () => {
    // $(( is arithmetic, $( is a subshell — they should be distinct
    const result = validateCommand(
      "echo $((offset + 1)) && echo $(ls)",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })
})
