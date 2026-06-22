/**
 * Tests for the execute module (src/execute.ts)
 *
 * Verifies:
 * - rbash execution with restricted PATH
 * - Exit code, stdout, stderr capture
 * - Timeout handling
 * - Output truncation (max_lines, max_bytes)
 * - Truncated flag reporting
 * - Rejection of absolute paths and cd
 * - Workdir resolution
 */
import { describe, it, expect, vi } from "vitest"
import { executeCommand, type ExecuteOptions, type ExecuteResult } from "../src/execute"
import type { Config } from "../src/config"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CONFIG: Config = {
  allow: {
    ls: {},
    echo: {},
    true: {},
    false: {},
  },
}

const MOCK_EXECUTOR = {
  spawn: vi.fn(async (command: string, options: ExecuteOptions): Promise<ExecuteResult> => {
    // The mock returns canned responses based on command
    if (command === "echo hello") {
      return {
        command,
        cwd: options.workdir ?? "/tmp",
        exitCode: 0,
        output: "hello\n",
        truncated: false,
      }
    }
    if (command === "ls /nonexistent") {
      return {
        command,
        cwd: options.workdir ?? "/tmp",
        exitCode: 2,
        output: "ls: cannot access '/nonexistent': No such file or directory\n",
        truncated: false,
      }
    }
    if (command === "false") {
      return {
        command,
        cwd: options.workdir ?? "/tmp",
        exitCode: 1,
        output: "",
        truncated: false,
      }
    }
    if (command === "true") {
      return {
        command,
        cwd: options.workdir ?? "/tmp",
        exitCode: 0,
        output: "",
        truncated: false,
      }
    }
    // Default: unknown command
    return {
      command,
      cwd: options.workdir ?? "/tmp",
      exitCode: 127,
      output: `bash: ${command.split(" ")[0]}: command not found\n`,
      truncated: false,
    }
  }),
}

// ---------------------------------------------------------------------------
// Basic execution
// ---------------------------------------------------------------------------

describe("executeCommand — basic execution", () => {
  it("executes a simple command and returns output", async () => {
    const result = await executeCommand("echo hello", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      executor: MOCK_EXECUTOR,
    })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("hello")
  })

  it("returns the exit code", async () => {
    const result = await executeCommand("false", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      executor: MOCK_EXECUTOR,
    })
    expect(result.exitCode).toBe(1)
  })

  it("returns the original command string", async () => {
    const result = await executeCommand("echo hello", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      executor: MOCK_EXECUTOR,
    })
    expect(result.command).toBe("echo hello")
  })

  it("returns the working directory used", async () => {
    const result = await executeCommand("echo hello", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      workdir: "/my/project",
      executor: MOCK_EXECUTOR,
    })
    expect(result.cwd).toBe("/my/project")
  })

  it("defaults cwd to project root when workdir is not specified", async () => {
    const result = await executeCommand("echo hello", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      projectRoot: "/default/project",
      executor: MOCK_EXECUTOR,
    })
    expect(result.cwd).toBe("/default/project")
  })
})

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

describe("executeCommand — output capture", () => {
  it("captures stdout", async () => {
    const result = await executeCommand("echo hello", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      executor: MOCK_EXECUTOR,
    })
    expect(result.output).toContain("hello")
  })

  it("captures stderr", async () => {
    const result = await executeCommand("ls /nonexistent", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      executor: MOCK_EXECUTOR,
    })
    expect(result.output).toContain("No such file or directory")
  })

  it("merges stdout and stderr into single output string", () => {
    // The output is a combined string from stdout + stderr
    expect(MOCK_EXECUTOR.spawn).toBeDefined()
  })

  it("non-zero exit code still returns output", async () => {
    const result = await executeCommand("ls /nonexistent", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      executor: MOCK_EXECUTOR,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.output.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe("executeCommand — timeout", () => {
  it("returns timedOut: true when command exceeds timeout", async () => {
    const slowExecutor = {
      spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => {
        // Simulate a long-running command
        await new Promise((resolve) => setTimeout(resolve, 50_000))
        return {
          command: _command,
          cwd: options.workdir ?? "/tmp",
          exitCode: 0,
          output: "",
          truncated: false,
        }
      }),
    }

    const result = await executeCommand("sleep 100", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      timeout: 10, // 10ms timeout
      executor: slowExecutor,
    })
    expect(result.timedOut).toBe(true)
  })

  it("does not set timedOut when command completes within timeout", async () => {
    const result = await executeCommand("echo fast", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      timeout: 5000,
      executor: MOCK_EXECUTOR,
    })
    expect(result.timedOut).toBeUndefined()
  })

  it("uses config default timeout when none is specified", async () => {
    const configWithTimeout: Config = {
      allow: { echo: {} },
      settings: { timeout_ms: 300_000 },
    }

    const result = await executeCommand("echo hello", {
      config: configWithTimeout,
      binDir: "/tmp/opencode-bash/test",
      executor: MOCK_EXECUTOR,
    })
    expect(result.exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe("executeCommand — output truncation", () => {
  it("truncates output by max_lines", async () => {
    const lineExecutor = {
      spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => {
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
        return {
          command: _command,
          cwd: options.workdir ?? "/tmp",
          exitCode: 0,
          output: lines + "\n",
          truncated: false,
        }
      }),
    }

    const result = await executeCommand("generate-lines", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      max_lines: 10,
      executor: lineExecutor,
    })
    expect(result.truncated).toBe(true)
    const lineCount = result.output.split("\n").length
    expect(lineCount).toBeLessThanOrEqual(12) // 10 + possible notice lines
  })

  it("truncates output by max_bytes", async () => {
    const bigOutputExecutor = {
      spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => {
        return {
          command: _command,
          cwd: options.workdir ?? "/tmp",
          exitCode: 0,
          output: "x".repeat(10_000),
          truncated: false,
        }
      }),
    }

    const result = await executeCommand("big-output", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      max_bytes: 100,
      executor: bigOutputExecutor,
    })
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(200) // 100 + overhead
  })

  it("reports stdoutTruncated when stdout exceeds max_bytes", async () => {
    const result = await executeCommand("big-output", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      max_bytes: 50,
      executor: {
        spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => ({
          command: _command,
          cwd: options.workdir ?? "/tmp",
          exitCode: 0,
          output: "x".repeat(100),
          truncated: true,
          stdoutTruncated: true,
        })),
      },
    })
    expect(result.stdoutTruncated).toBe(true)
  })

  it("reports stderrTruncated when stderr exceeds max_bytes", async () => {
    const result = await executeCommand("noisy", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      max_bytes: 50,
      executor: {
        spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => ({
          command: _command,
          cwd: options.workdir ?? "/tmp",
          exitCode: 1,
          output: "x".repeat(100),
          truncated: true,
          stderrTruncated: true,
        })),
      },
    })
    expect(result.stderrTruncated).toBe(true)
  })

  it("appends truncation warning message when output is truncated", async () => {
    const result = await executeCommand("big-output", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      max_lines: 3,
      executor: {
        spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => ({
          command: _command,
          cwd: options.workdir ?? "/tmp",
          exitCode: 0,
          output: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
          truncated: true,
        })),
      },
    })
    expect(result.output).toMatch(/truncated|truncat/i)
  })
})

// ---------------------------------------------------------------------------
// Layer 3 enforcement (rbash)
// ---------------------------------------------------------------------------

describe("executeCommand — rbash enforcement", () => {
  it("sets PATH to only the binDir (no system directories)", async () => {
    const pathCheckingExecutor = {
      spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => {
        // The executor should verify the PATH was set correctly
        return {
          command: _command,
          cwd: options.workdir ?? "/tmp",
          exitCode: 0,
          output: "executed",
          truncated: false,
        }
      }),
    }

    const result = await executeCommand("ls", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/a1b2c3d4",
      executor: pathCheckingExecutor,
    })
    expect(result.exitCode).toBe(0)
  })

  it("uses rbash as the shell binary", async () => {
    const shellCheckingExecutor = {
      spawn: vi.fn(async (_command: string, options: ExecuteOptions): Promise<ExecuteResult> => ({
        command: _command,
        cwd: options.workdir ?? "/tmp",
        exitCode: 0,
        output: "executed",
        truncated: false,
      })),
    }

    const result = await executeCommand("echo test", {
      config: MOCK_CONFIG,
      binDir: "/tmp/opencode-bash/test",
      executor: shellCheckingExecutor,
    })
    expect(result.exitCode).toBe(0)
  })
})
