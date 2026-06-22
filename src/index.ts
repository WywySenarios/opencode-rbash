/**
 * Plugin entry point for the restricted bash tool.
 *
 * Registers two tools:
 *   - "bash" — replaces the built-in unrestricted bash with one that enforces:
 *       1. Config-based executable allowlist
 *       2. Command validation (Step A + Step B)
 *       3. rbash restricted shell with locked PATH
 *   - "run_script" — runs scripts via configured interpreters using regular
 *       bash with the system PATH (no rbash restrictions)
 */

import type { Plugin, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { loadConfig, type AllowEntry, type Config } from "./config.js"
import { validateCommand } from "./validate.js"
import { validateScriptCommand, SCRIPTS_TOOL_NAME } from "./scripts.js"
import { initSymlinks, type InitResult } from "./init.js"
import { captureOutput, executeCommand, type ExecuteResult } from "./execute.js"
import { createWriteLock } from "./write-lock.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RBASH_PATH = "/usr/bin/rbash"
const BASH_PATH = "/bin/bash"

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  command: z
    .string()
    .min(1, "Command must not be empty")
    .describe(
      "Shell command to execute." +
        "Only executables on the project's allowlist are permitted. " +
        "See .opencode/bash-restricted.jsonc or ~/.config/opencode/bash-restricted.jsonc for the current allowlist."
    ),
  description: z
    .string()
    .optional()
    .describe("Concise description of what this command does"),
  workdir: z
    .string()
    .optional()
    .describe("Working directory relative to project root. Defaults to project root."),
  timeout: z
    .number()
    .int()
    .positive()
    .max(600000)
    .optional()
    .describe("Timeout in milliseconds (default: project config setting, max: 10 min)"),
  max_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum output lines to return."),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(10485760)
    .optional()
    .describe("Maximum output bytes to return (max: 10 MB)."),
  container: z
    .string()
    .optional()
    .describe(
      "Docker container name. When specified, the command is executed inside the container via docker exec."
    ),
})

// ---------------------------------------------------------------------------
// System helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/** Resolve executable path via system `which`. */
async function systemWhich(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [name], {
      encoding: "utf-8",
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Create an executor that spawns commands via rbash with a restricted PATH. */
function createExecutor(binDir: string) {
  return {
    spawn: (command: string, options: { workdir?: string }): Promise<ExecuteResult> => {
      const proc = spawn(RBASH_PATH, ["-c", command], {
        cwd: options.workdir,
        env: { PATH: binDir },
        stdio: ["ignore", "pipe", "pipe"],
      })
      return captureOutput(proc, command, options.workdir ?? process.cwd())
    },
  }
}

/** Create an executor that spawns commands via docker exec.
 * Sets the working directory inside the container via `-w` when specified. */
function createDockerExecutor(container: string) {
  return {
    spawn: (command: string, options: { workdir?: string }): Promise<ExecuteResult> => {
      const dockerArgs = ["exec"]
      if (options.workdir) {
        dockerArgs.push("-w", options.workdir)
      }
      dockerArgs.push(container, "bash", "-c", command)

      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      })
      return captureOutput(proc, command, options.workdir ?? process.cwd(),
        `docker exec for container '${container}'`)
    },
  }
}

/** Create an executor that spawns commands via regular bash with the system
 * PATH (no rbash restrictions). Used by the run_script tool so scripts can
 * access the full system PATH — not just allowlisted executables. */
function createBashExecutor() {
  return {
    spawn: (command: string, options: { workdir?: string }): Promise<ExecuteResult> => {
      const proc = spawn(BASH_PATH, ["-c", command], {
        cwd: options.workdir,
        stdio: ["ignore", "pipe", "pipe"],
      })
      return captureOutput(proc, command, options.workdir ?? process.cwd())
    },
  }
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

/**
 * Builds a dynamic tool description from the allowlist config.
 * Lists allowed executables and their pipe targets so the agent knows
 * exactly what is available — no implementation details leaked.
 */
function buildDescription(config: Config): string {
  const lines: string[] = [
    "rbash shell.",
    "",
    "Allow-listed executables:",
  ]

  // CONVENTION-EXCEPTION: typescript.mdx — Object.entries() on a typed Record
  // returns [string, unknown][], so we assert to match AllowConfig's shape.
  const entries = Object.entries(config.allow) as [string, AllowEntry][]
  for (const [name, entry] of entries) {
    if (entry.pipe_to && entry.pipe_to.length > 0) {
      lines.push(`  ${name} (can pipe to: ${entry.pipe_to.join(", ")})`)
    } else {
      lines.push(`  ${name}`)
    }
  }

  lines.push(
    "",
    "Use max_lines / max_bytes parameters to cap output.",
    "opencode's built-in tools are preferred over running grep in bash.",
  )

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Script tool description builder
// ---------------------------------------------------------------------------

/**
 * Builds a dynamic tool description for the run_script tool.
 * Lists configured script interpreters so the agent knows what's available.
 */
function buildScriptToolDescription(config: Config): string {
  const interpreters = config.script_interpreters ?? []
  const lines: string[] = [
    "Run a script via a configured interpreter.",
    "",
    "Available interpreters:",
    ...interpreters.map((name) => `  ${name}`),
    "",
    'Usage: <interpreter> <script-path> (exactly one argument — the script path).',
    "The script path may be a bare filename, relative path, or absolute path.",
    "Flags and inline code (-c, -m, etc.) are not supported.",
  ]

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Shared execution helper
// ---------------------------------------------------------------------------

/**
 * Shared logic used by both bash and run_script tools to initialise symlinks,
 * execute a command, and format the result.
 * Lazily creates the symlink directory on first call and caches it via the
 * mutable `initRef` parameter.
 *
 * When `args.container` is specified, execution uses docker exec instead of
 * rbash. When `useBash` is true, execution uses regular bash with system PATH
 * (no rbash restrictions). Symlinks are still initialised for warning reporting
 * even in these cases.
 */
async function executeWithConfig(
  args: { command: string; workdir?: string; timeout?: number; max_lines?: number; max_bytes?: number; container?: string },
  config: Config,
  projectRoot: string,
  initRef: { current: InitResult | null },
  useBash?: boolean,
  userWritableTargetsRef?: { current: string[] },
): Promise<ExecuteResult> {
  if (!initRef.current) {
    initRef.current = await initSymlinks({
      config,
      projectRoot,
      resolver: { which: systemWhich },
    })
    // Propagate discovered user-writable targets so the write-lock hook
    // can block writes through symlinks to those paths
    if (userWritableTargetsRef) {
      userWritableTargetsRef.current = initRef.current.userWritableTargets
    }
  }

  const executor = useBash
    ? createBashExecutor()
    : args.container
      ? createDockerExecutor(args.container)
      : createExecutor(initRef.current.binDir)
  return await executeCommand(args.command, {
    config,
    binDir: initRef.current.binDir,
    executor,
    workdir: args.workdir,
    timeout: args.timeout,
    max_lines: args.max_lines,
    max_bytes: args.max_bytes,
    projectRoot,
  })
}

/**
 * Formats execution output with warnings and exit status.
 */
function formatOutput(result: ExecuteResult, cachedInit: InitResult): string {
  const warningsText =
    cachedInit.warnings.length > 0
      ? `\n\nWarnings:\n${cachedInit.warnings.map((w) => `- ${w}`).join("\n")}`
      : ""
  return result.timedOut
    ? `${result.output}${warningsText}\n\nCommand timed out before completion.`
    : `${result.output}${warningsText}\n\nCommand exited with code ${result.exitCode}.`
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const plugin: Plugin = async (input) => {
  let cachedConfig: Config | null = null

  // Load config eagerly so the tool description can be built dynamically
  const projectRoot = input.worktree || input.directory
  cachedConfig = loadConfig({ projectRoot })

  // Mutable ref for lazy symlink initialisation, shared by both tools
  const initRef: { current: InitResult | null } = { current: null }
  // Mutable ref for user-writable symlink targets discovered by initSymlinks
  const userWritableRef: { current: string[] } = { current: [] }

  const tools: Record<string, ReturnType<typeof tool>> = {
    bash: tool({
      description: buildDescription(cachedConfig),
      // CONVENTION-EXCEPTION: typescript.mdx - Type assertion necessary because
      // the test expects args to be a ZodObject (with ._def and .safeParse()),
      // but tool()'s type expects ZodRawShape. At runtime both work.
      args: InputSchema as unknown as z.ZodRawShape,
      async execute(
        args: z.infer<typeof InputSchema>,
        ctx: ToolContext
      ): Promise<ToolResult> {
        const projectRoot = ctx.worktree || ctx.directory

        // Validate command against allowlist
        const validation = validateCommand(args.command, cachedConfig.allow)
        if (!validation.valid) {
          return {
            title: "Command Rejected",
            output: `Error: ${validation.error}`,
            metadata: { command: args.command, rejected: true },
          }
        }

        // Execute via shared logic (initRef lazily caches symlinks)
        const result = await executeWithConfig(
          args,
          cachedConfig,
          projectRoot,
          initRef,
          false,
          userWritableRef,
        )

        return {
          command: result.command,
          cwd: result.cwd,
          exitCode: result.exitCode,
          output: formatOutput(result, initRef.current!),
          truncated: result.truncated,
          ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(initRef.current!.warnings.length > 0
            ? { warnings: initRef.current!.warnings }
            : {}),
        }
      },
    }),
  }

  // Conditionally register run_script tool if script_interpreters is configured
  if (
    cachedConfig.script_interpreters &&
    cachedConfig.script_interpreters.length > 0
  ) {
    tools[SCRIPTS_TOOL_NAME] = tool({
      description: buildScriptToolDescription(cachedConfig),
      args: InputSchema as unknown as z.ZodRawShape,
      async execute(
        args: z.infer<typeof InputSchema>,
        ctx: ToolContext
      ): Promise<ToolResult> {
        const projectRoot = ctx.worktree || ctx.directory

        // Validate script command against configured interpreters
        const validation = validateScriptCommand(
          args.command,
          cachedConfig.script_interpreters!
        )
        if (!validation.valid) {
          return {
            title: "Script Rejected",
            output: `Error: ${validation.error}`,
            metadata: { command: args.command, rejected: true },
          }
        }

        // Execute via shared logic — use regular bash so scripts can access
        // the full system PATH, not just allowlisted executables
        const result = await executeWithConfig(
          args,
          cachedConfig,
          projectRoot,
          initRef,
          true, // useBash
          userWritableRef,
        )

        return {
          command: result.command,
          cwd: result.cwd,
          exitCode: result.exitCode,
          output: formatOutput(result, initRef.current!),
          truncated: result.truncated,
          ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(initRef.current!.warnings.length > 0
            ? { warnings: initRef.current!.warnings }
            : {}),
        }
      },
    })
  }

  return {
    tool: tools,
    ...createWriteLock({
      projectRoot,
      lockedPaths: cachedConfig.locked_scripts ?? [],
      dynamicPathsRef: userWritableRef,
    }),
  }
}

export default plugin
