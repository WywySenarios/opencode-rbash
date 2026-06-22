/**
 * Script validation and execution for the restricted bash tool.
 *
 * Provides a separate tool for running project scripts with configured
 * interpreters (e.g., python, node, deno). The command must match the
 * pattern: <interpreter> <script-path> with exactly one argument.
 */

import { extractWord, type ValidationResult } from "./validate.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPTS_TOOL_NAME = "run_script"

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates a script command against a list of allowed interpreters.
 *
 * A valid script command follows the pattern:
 *   <interpreter> <script-path>
 *
 * where:
 *   - <interpreter> is one of the allowed interpreters (bare name, no path)
 *   - <script-path> is the sole argument (the script file to run)
 *   - there are no additional arguments or flags
 *
 * @param command - The full command string (e.g. "python my-script.py")
 * @param interpreters - List of allowed interpreter names
 * @returns ValidationResult
 */
export function validateScriptCommand(
  command: string,
  interpreters: string[]
): ValidationResult {
  const trimmed = command.trim()
  if (!trimmed) {
    return { valid: false, error: "Command is empty" }
  }

  // Extract interpreter (first word)
  const firstResult = extractWord(trimmed, 0)
  if (!firstResult) {
    return { valid: false, error: "No interpreter found" }
  }

  const interpreter = firstResult.word

  // Interpreter must be a bare name, not a path
  if (
    interpreter.startsWith("/") ||
    interpreter.startsWith("./") ||
    interpreter.startsWith("../")
  ) {
    return {
      valid: false,
      error: `'${interpreter}' is a path, not a bare interpreter name`,
    }
  }

  // Interpreter must be in the configured list
  if (!interpreters.includes(interpreter)) {
    return {
      valid: false,
      error: `'${interpreter}' is not in the configured script interpreters`,
    }
  }

  // Extract the argument (must be exactly one word: the script path)
  const argResult = extractWord(trimmed, firstResult.nextIndex)
  if (!argResult) {
    return {
      valid: false,
      error: `'${interpreter}' is missing a script argument`,
    }
  }

  const scriptArg = argResult.word

  // Check there are no extra arguments after the script
  const extraResult = extractWord(trimmed, argResult.nextIndex)
  if (extraResult) {
    return {
      valid: false,
      error: `'${interpreter} ${scriptArg}' has extra arguments after the script`,
    }
  }

  // The argument must not look like a flag / option
  if (scriptArg.startsWith("-")) {
    return {
      valid: false,
      error: `'${scriptArg}' looks like a flag, not a script path`,
    }
  }

  return { valid: true }
}

export { SCRIPTS_TOOL_NAME }
