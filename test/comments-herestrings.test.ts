/**
 * Tests for inline comments (#) and here strings (<<<).
 *
 * Current parser limitations:
 * - Inline comments (#) are not stripped, so && inside comments
 *   incorrectly splits commands, and comment text is treated as args.
 * - Here strings (<<<) are confused with heredocs (<<), extracting "<"
 *   as a heredoc delimiter, breaking parsing.
 */

import { validateCommand } from "../src/validate"
import type { AllowConfig } from "../src/config"

const ALLOWLIST: AllowConfig = {
  ls: {},
  echo: {},
  cat: { pipe_to: ["grep", "wc"] },
  grep: {},
  wc: {},
  true: {},
  false: {},
}

// ---------------------------------------------------------------------------
// Inline comments (#)
// ---------------------------------------------------------------------------

describe("validateCommand — inline comments", () => {
  it("allows a command with a trailing comment", () => {
    // # and everything after should be ignored
    const result = validateCommand("ls -la # list files", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("ignores compound operators inside comments", () => {
    // The && is inside the comment, so vim should NOT be validated
    const result = validateCommand("ls # comment && vim file.txt", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("ignores pipe operators inside comments", () => {
    // The | is inside the comment, so only ls should be validated
    const result = validateCommand("ls # comment | vim file.txt", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("does not treat # inside double quotes as comment", () => {
    const result = validateCommand('echo "# not a comment"', ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("does not treat # inside single quotes as comment", () => {
    const result = validateCommand("echo '# not a comment'", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("validates commands after a real comment delimiter", () => {
    // Only "ls" is before the # comment; "echo" is NOT after #,
    // it's in the next compound segment via ;
    const result = validateCommand("ls # comment ; echo hi", ALLOWLIST)
    // After stripping comments, this becomes "ls ; echo hi"
    expect(result.valid).toBe(true)
  })

  it("rejects disallowed command that should not be hidden by comment", () => {
    // vim is before #, so it should be rejected
    const result = validateCommand("vim # this is bad", ALLOWLIST)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("vim")
  })
})

// ---------------------------------------------------------------------------
// Here strings (<<<)
// ---------------------------------------------------------------------------

describe("validateCommand — here strings", () => {
  it("handles <<< here string as a normal argument", () => {
    const result = validateCommand("grep pattern <<< 'hello world'", ALLOWLIST)
    expect(result.valid).toBe(true)
  })

  it("handles <<< in a pipeline", () => {
    const result = validateCommand(
      "grep pattern <<< 'hello world' | wc -w",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })

  it("does not confuse <<< with heredoc <<", () => {
    // <<< should not trigger heredoc mode
    const result = validateCommand(
      "cat <<< 'inline string' | grep test",
      ALLOWLIST
    )
    expect(result.valid).toBe(true)
  })
})
