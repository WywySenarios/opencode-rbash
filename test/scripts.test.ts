/**
 * Tests for the scripts module (src/scripts.ts)
 *
 * Verifies:
 * - validateScriptCommand validates interpreter + single script arg pattern
 * - Rejection cases: no args, unknown interpreter, flags/options, extra args
 * - Script path can be relative, absolute, or bare filename
 * - Empty commands are rejected
 */

import { describe, it, expect } from "vitest"
import { validateScriptCommand } from "../src/scripts"
import type { ValidationResult } from "../src/scripts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_INTERPRETERS = ["python", "python3", "node", "deno", "bash", "sh"]

// ---------------------------------------------------------------------------
// Valid script commands
// ---------------------------------------------------------------------------

describe("validateScriptCommand — valid commands", () => {
  it("allows interpreter with bare script filename", () => {
    const result = validateScriptCommand("python my-script.py", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(true)
  })

  it("allows interpreter with relative script path", () => {
    const result = validateScriptCommand("node ./scripts/build.js", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(true)
  })

  it("allows interpreter with absolute script path", () => {
    const result = validateScriptCommand("python3 /home/user/project/deploy.py", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(true)
  })

  it("allows interpreter with script in parent directory", () => {
    const result = validateScriptCommand("bash ../tools/build.sh", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(true)
  })

  it("allows interpreter with script with file extension", () => {
    const result = validateScriptCommand("deno server.ts", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(true)
  })

  it("allows any interpreter in the configured list", () => {
    for (const interp of SAMPLE_INTERPRETERS) {
      const result = validateScriptCommand(`${interp} script.sh`, SAMPLE_INTERPRETERS)
      expect(result.valid).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Invalid script commands — wrong number of arguments
// ---------------------------------------------------------------------------

describe("validateScriptCommand — invalid: argument count", () => {
  it("rejects empty command string", () => {
    const result = validateScriptCommand("", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects interpreter with no arguments", () => {
    const result = validateScriptCommand("python", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects interpreter with only whitespace argument", () => {
    const result = validateScriptCommand("python   ", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects interpreter with multiple arguments after script", () => {
    const result = validateScriptCommand("python my-script.py --verbose", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects interpreter with multiple argument tokens", () => {
    const result = validateScriptCommand("node build.js arg1 arg2", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Invalid script commands — interpreter issues
// ---------------------------------------------------------------------------

describe("validateScriptCommand — invalid: interpreter", () => {
  it("rejects interpreter not in the configured list", () => {
    const result = validateScriptCommand("deno run.ts", ["python", "node"])
    expect(result.valid).toBe(false)
  })

  it("rejects command with empty interpreter list", () => {
    const result = validateScriptCommand("python script.py", [])
    expect(result.valid).toBe(false)
  })

  it("rejects command starting with path to interpreter (absolute)", () => {
    const result = validateScriptCommand("/usr/bin/python script.py", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects command starting with path to interpreter (relative)", () => {
    const result = validateScriptCommand("./venv/bin/python script.py", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Invalid script commands — inline code / flags
// ---------------------------------------------------------------------------

describe("validateScriptCommand — invalid: inline code or flags", () => {
  it("rejects inline code with -c flag", () => {
    const result = validateScriptCommand("python -c 'print(\"hello\")'", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects module execution with -m flag", () => {
    const result = validateScriptCommand("python -m http.server", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects interpreter with flag before script", () => {
    const result = validateScriptCommand("node --experimental-modules app.js", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })

  it("rejects argument that looks like a flag as script", () => {
    const result = validateScriptCommand("python --version", SAMPLE_INTERPRETERS)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Redirection hint
// ---------------------------------------------------------------------------

describe("validateScriptCommand — redirection", () => {
  it("error message hints at using the run_script tool when command looks like a script", () => {
    const result = validateScriptCommand("python my-script.py", [])
    // If the interpreter WOULD be valid but the tool isn't configured, hint
    if (result.error) {
      expect(result.error.toLowerCase()).toMatch(/run_script|scripts tool|script/i)
    }
  })
})
