/**
 * Command execution for restricted bash tool.
 *
 * Runs commands via an injectable executor (which the real plugin
 * bridges to rbash with restricted PATH). Handles:
 *   - Output truncation (max_lines, max_bytes)
 *   - Timeout (via Promise.race)
 *   - Capturing stdout/stderr
 *   - Merged output with truncation notice
 */

import type { Config } from "./config.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  workdir?: string
  timeout?: number
  max_lines?: number
  max_bytes?: number
}

export type ExecuteResult = {
  command: string
  cwd: string
  exitCode: number
  output: string
  truncated: boolean
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  timedOut?: boolean
}

export type Executor = {
  spawn: (
    command: string,
    options: ExecuteOptions
  ) => Promise<ExecuteResult>
}

// ---------------------------------------------------------------------------
// Process output capture
// ---------------------------------------------------------------------------

/**
 * Spawns a child process and captures its stdout/stderr output.
 * Returns a promise that resolves when the process exits (or fails to spawn).
 *
 * If the process fails to spawn, the error event is handled and the promise
 * resolves with a structured error result rather than hanging indefinitely.
 *
 * @param proc     - The child process to capture output from
 * @param command  - The command string (stored in the result)
 * @param cwd      - The working directory (stored in the result)
 * @param errorLabel - Optional label used in the error message when spawn fails
 *                     (defaults to "process")
 */
export function captureOutput(
  proc: import("node:child_process").ChildProcess,
  command: string,
  cwd: string,
  errorLabel?: string
): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8")
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8")
    })

    proc.on("error", (err) => {
      const label = errorLabel ?? "process"
      resolve({
        command,
        cwd,
        exitCode: -1,
        output: `Error: ${label} spawn failed: ${err.message}`,
        truncated: false,
      })
    })

    proc.on("close", () => {
      resolve({
        command,
        cwd,
        exitCode: proc.exitCode ?? -1,
        output: stdout + stderr,
        truncated: false,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

function truncateByLines(text: string, maxLines: number): string {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join("\n")
}

function truncateByBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.byteLength(text, "utf-8")
  if (encoded <= maxBytes) return text
  // Binary-search approach: gradually reduce until under limit
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return text.slice(0, low)
}

const TRUNCATION_NOTICE =
  "\n[Output truncated at the requested limit]"

// ---------------------------------------------------------------------------
// Execute command
// ---------------------------------------------------------------------------

/**
 * Executes a command via the provided executor and applies output
 * truncation / timeout handling.
 */
export async function executeCommand(
  command: string,
  options: {
    config: Config
    binDir: string
    executor: Executor
    workdir?: string
    timeout?: number
    max_lines?: number
    max_bytes?: number
    projectRoot?: string
  }
): Promise<ExecuteResult> {
  const {
    config,
    executor,
    workdir,
    timeout,
    max_lines,
    max_bytes,
    projectRoot,
  } = options

  // Resolve working directory
  const resolvedCwd = workdir ?? projectRoot ?? process.cwd()

  // Determine timeout: explicit param > config default > built-in default
  const effectiveTimeout =
    timeout ?? config.settings?.timeout_ms ?? 120_000

  const execOptions: ExecuteOptions = {
    workdir: resolvedCwd,
    timeout: effectiveTimeout,
  }

  // Execute with timeout
  let result: ExecuteResult
  try {
    const execPromise = executor.spawn(command, execOptions)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new TimeoutError()),
        effectiveTimeout
      )
    )
    result = await Promise.race([execPromise, timeoutPromise])
  } catch (err) {
    if (err instanceof TimeoutError) {
      return {
        command,
        cwd: resolvedCwd,
        exitCode: -1,
        output: "",
        truncated: false,
        timedOut: true,
      }
    }
    throw err
  }

  // Apply output truncation
  let output = result.output
  let truncated = result.truncated

  if (max_lines !== undefined) {
    const before = output.split("\n").length
    output = truncateByLines(output, max_lines)
    const after = output.split("\n").length
    if (after < before) {
      truncated = true
      output += TRUNCATION_NOTICE
    }
  }

  if (max_bytes !== undefined) {
    const before = Buffer.byteLength(output, "utf-8")
    output = truncateByBytes(output, max_bytes)
    const after = Buffer.byteLength(output, "utf-8")
    if (after < before) {
      truncated = true
      output += TRUNCATION_NOTICE
    }
  }

  return {
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    output,
    truncated,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }
}

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor() {
    super("Command timed out")
    this.name = "TimeoutError"
  }
}
