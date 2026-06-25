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

import type { Plugin, ToolContext, ToolResult } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, type Config } from "./config.js";
import { validateCommand } from "./validate.js";
import { validateScriptCommand, SCRIPTS_TOOL_NAME } from "./scripts.js";
import { filterTrustedAgents, isTrustedAgent } from "./agent-auth.js";
import { initSymlinks, type InitResult } from "./init.js";
import {
  captureOutput,
  executeCommand,
  type ExecuteResult,
  type ExecuteOptions,
} from "./execute.js";
import { createWriteLock } from "./write-lock.js";

// ---------------------------------------------------------------------------
// Plugin-scoped zod instance
// ---------------------------------------------------------------------------

/**
 * Runtime zod instance from the plugin SDK.
 * Using `tool.schema` ensures the `_zod.version.minor` brand (4 vs 1) is
 * consistent with the SDK's compiled types, avoiding TS2322 assignment errors
 * on `ZodRawShape` at the `tool()` call site.
 */
const z = tool.schema;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RBASH_PATH = "/usr/bin/rbash";
const BASH_PATH = "/bin/bash";

// ---------------------------------------------------------------------------
// Input schema — individual ZodType values forming a ZodRawShape.
// Intentionally NOT wrapped in z.object() to avoid Zod 4's enumerable
// `def`/`type` property leak on ZodObject instances (github #28704).
// ---------------------------------------------------------------------------

const inputShape = {
  command: z
    .string()
    .min(1, "Command must not be empty")
    .describe(
      "Shell command to execute." +
        "Only executables on the project's allowlist are permitted. " +
        "See .opencode/bash-restricted.jsonc or ~/.config/opencode/bash-restricted.jsonc for the current allowlist.",
    ),
  description: z
    .string()
    .optional()
    .describe("Concise description of what this command does"),
  workdir: z
    .string()
    .optional()
    .describe(
      "Working directory relative to project root. Defaults to project root.",
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .max(600000)
    .optional()
    .describe(
      "Timeout in milliseconds (default: project config setting, max: 10 min)",
    ),
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
      "Docker container name. When specified, the command is executed inside the container via docker exec.",
    ),
} as const;

// ---------------------------------------------------------------------------
// System helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Resolve executable path via system `which`. */
async function systemWhich(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [name], {
      encoding: "utf-8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Wire an abort signal so the child process is killed when the signal fires.
 * This is a no-op when no signal is provided.
 */
function killOnAbort(
  signal: AbortSignal | undefined,
  proc: import("node:child_process").ChildProcess,
): void {
  signal?.addEventListener(
    "abort",
    () => {
      proc.kill();
    },
    { once: true },
  );
}

/** Create an executor that spawns commands via rbash with a restricted PATH. */
function createExecutor(binDir: string) {
  return {
    spawn: (
      command: string,
      options: ExecuteOptions,
    ): Promise<ExecuteResult> => {
      const proc = spawn(RBASH_PATH, ["-c", command], {
        cwd: options.workdir,
        env: { PATH: binDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      killOnAbort(options.signal, proc);
      return captureOutput(proc, command, options.workdir ?? process.cwd());
    },
  };
}

/** Create an executor that spawns commands via docker exec.
 * Sets the working directory inside the container via `-w` when specified. */
function createDockerExecutor(container: string) {
  return {
    spawn: (
      command: string,
      options: ExecuteOptions,
    ): Promise<ExecuteResult> => {
      const dockerArgs = ["exec"];
      if (options.workdir) {
        dockerArgs.push("-w", options.workdir);
      }
      dockerArgs.push(container, "bash", "-c", command);

      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      killOnAbort(options.signal, proc);
      return captureOutput(
        proc,
        command,
        options.workdir ?? process.cwd(),
        `docker exec for container '${container}'`,
      );
    },
  };
}

/** Create an executor that spawns commands via regular bash with the system
 * PATH (no rbash restrictions). Used by the run_script tool so scripts can
 * access the full system PATH — not just allowlisted executables. */
function createBashExecutor() {
  return {
    spawn: (
      command: string,
      options: ExecuteOptions,
    ): Promise<ExecuteResult> => {
      const proc = spawn(BASH_PATH, ["-c", command], {
        cwd: options.workdir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      killOnAbort(options.signal, proc);
      return captureOutput(proc, command, options.workdir ?? process.cwd());
    },
  };
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

/**
 * Builds a dynamic tool description from the allowlist config.
 * Lists allowed executables (with pipe targets) and script path
 * patterns so the agent knows exactly what is available — no
 * implementation details leaked.
 */
function buildDescription(config: Config): string {
  const lines: string[] = ["rbash shell.", "", "Allow-listed executables:"];

  const entries = Object.entries(config.allow);
  for (const [name, entry] of entries) {
    if (entry.pipe_to && entry.pipe_to.length > 0) {
      lines.push(`  ${name} (can pipe to: ${entry.pipe_to.join(", ")})`);
    } else {
      lines.push(`  ${name}`);
    }
  }

  if (config.scripts && config.scripts.length > 0) {
    lines.push("", "Allow-listed scripts:");
    for (const pattern of config.scripts) {
      lines.push(`  ${pattern}`);
    }
  }

  lines.push(
    "",
    "Use max_lines / max_bytes parameters to cap output.",
    "opencode's built-in tools are preferred over running grep in bash.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Script tool description builder
// ---------------------------------------------------------------------------

/**
 * Builds a dynamic tool description for the run_script tool.
 * Lists configured script interpreters so the agent knows what's available.
 */
function buildScriptToolDescription(config: Config): string {
  const interpreters = config.script_interpreters ?? [];
  const lines: string[] = [
    "Run a script via a configured interpreter.",
    "",
    "Available interpreters:",
    ...interpreters.map((name) => `  ${name}`),
    "",
    "Usage: <interpreter> <script-path> (exactly one argument — the script path).",
    "The script path may be a bare filename, relative path, or absolute path.",
    "Flags and inline code (-c, -m, etc.) are not supported.",
  ];

  return lines.join("\n");
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
  args: {
    command: string;
    workdir?: string;
    timeout?: number;
    max_lines?: number;
    max_bytes?: number;
    container?: string;
  },
  config: Config,
  projectRoot: string,
  initRef: { current: InitResult | null },
  useBash?: boolean,
  userWritableTargetsRef?: { current: string[] },
): Promise<ExecuteResult> {
  if (!initRef.current) {
    const tInit = process.hrtime.bigint();
    initRef.current = await initSymlinks({
      config,
      projectRoot,
      resolver: { which: systemWhich },
    });
    perf("initSymlinks (first call)", tInit);
    // Propagate discovered user-writable targets so the write-lock hook
    // can block writes through symlinks to those paths
    if (userWritableTargetsRef) {
      userWritableTargetsRef.current = initRef.current.userWritableTargets;
    }
  }

  const executor = useBash
    ? createBashExecutor()
    : args.container
      ? createDockerExecutor(args.container)
      : createExecutor(initRef.current.binDir);
  return await executeCommand(args.command, {
    config,
    binDir: initRef.current.binDir,
    executor,
    workdir: args.workdir,
    timeout: args.timeout,
    max_lines: args.max_lines,
    max_bytes: args.max_bytes,
    projectRoot,
  });
}

/**
 * Formats execution output with warnings and exit status.
 */
function formatOutput(result: ExecuteResult, cachedInit: InitResult): string {
  const warningsText =
    cachedInit.warnings.length > 0
      ? `\n\nWarnings:\n${cachedInit.warnings.map((w) => `- ${w}`).join("\n")}`
      : "";
  return result.timedOut
    ? `${result.output}${warningsText}\n\nCommand timed out before completion.`
    : `${result.output}${warningsText}\n\nCommand exited with code ${result.exitCode}.`;
}

// ---------------------------------------------------------------------------
// Startup instrumentation
// ---------------------------------------------------------------------------

/**
 * When `OPCODE_BASH_PERF=1` is set, log timing information for key startup
 * phases to stderr. Each line is prefixed with `[perf]` for easy grepping.
 */
const PERF_ENABLED = !!process.env.OPCODE_BASH_PERF;

function perf(label: string, start: bigint): void {
  if (!PERF_ENABLED) return;
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  console.error(`[perf] ${label}: ${elapsed.toFixed(2)} ms`);
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const plugin: Plugin = async (input) => {
  const t0 = process.hrtime.bigint();
  let cachedConfig: Config | null = null;

  // Load config eagerly so the tool description can be built dynamically
  const projectRoot = input.worktree || input.directory;
  const t1 = process.hrtime.bigint();
  cachedConfig = loadConfig({ projectRoot });
  perf("loadConfig", t1);

  // Filter trusted_agents to only primary-mode agents (silently excludes
  // non-primary agents configured by name). Falls back to the raw list when
  // no agent descriptors are provided (backward compat).
  const effectiveTrustedAgents = cachedConfig.agents
    ? filterTrustedAgents(
        cachedConfig.trusted_agents ?? [],
        cachedConfig.agents,
      )
    : (cachedConfig.trusted_agents ?? []);

  // Mutable ref for lazy symlink initialisation, shared by both tools
  const initRef: { current: InitResult | null } = { current: null };
  // Mutable ref for user-writable symlink targets discovered by initSymlinks
  const userWritableRef: { current: string[] } = { current: [] };

  const t2 = process.hrtime.bigint();
  const tools: Record<string, ReturnType<typeof tool>> = {
    bash: tool({
      description: buildDescription(cachedConfig),
      // ZodRawShape — individual ZodType values, no z.object() wrapper
      // (avoids enumuerable `def`/`type` property leak, github #28704).
      args: inputShape,
      async execute(
        args,
        ctx: ToolContext,
      ): Promise<ToolResult> {
        const projectRoot = ctx.worktree || ctx.directory;

        // Check if the calling agent is trusted (bypasses bash restrictions)
        const isTrusted = isTrustedAgent(ctx.agent, effectiveTrustedAgents);

        // Validate command against allowlist (skipped for trusted agents)
        let matchedScript = false;
        if (!isTrusted) {
          const validation = validateCommand(
            args.command,
            cachedConfig.allow,
            cachedConfig.scripts,
          );
          if (!validation.valid) {
            return {
              title: "Command Rejected",
              output: `Error: ${validation.error}`,
              metadata: { command: args.command, rejected: true },
            };
          }
          matchedScript = validation.matchedScript ?? false;
        }

        // Execute via shared logic (initRef lazily caches symlinks)
        // Trusted agents and script-pattern commands use regular bash with
        // system PATH (no rbash restrictions — rbash rejects path-based
        // commands like "scripts/true.sh").
        const useBash = isTrusted || matchedScript;
        const result = await executeWithConfig(
          args,
          cachedConfig,
          projectRoot,
          initRef,
          useBash,
          userWritableRef,
        );

        return Object.assign(
          { output: formatOutput(result, initRef.current!) },
          {
            command: result.command,
            cwd: result.cwd,
            exitCode: result.exitCode,
            truncated: result.truncated,
            ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
            ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
            ...(result.timedOut ? { timedOut: true } : {}),
            ...(initRef.current!.warnings.length > 0
              ? { warnings: initRef.current!.warnings }
              : {}),
          },
        );
      },
    }),
  };

  // Conditionally register run_script tool if script_interpreters is configured
  if (
    cachedConfig.script_interpreters &&
    cachedConfig.script_interpreters.length > 0
  ) {
    tools[SCRIPTS_TOOL_NAME] = tool({
      description: buildScriptToolDescription(cachedConfig),
      args: inputShape,
      async execute(
        args,
        ctx: ToolContext,
      ): Promise<ToolResult> {
        const projectRoot = ctx.worktree || ctx.directory;

        // Validate script command against configured interpreters
        const validation = validateScriptCommand(
          args.command,
          cachedConfig.script_interpreters!,
        );
        if (!validation.valid) {
          return {
            title: "Script Rejected",
            output: `Error: ${validation.error}`,
            metadata: { command: args.command, rejected: true },
          };
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
        );

        return Object.assign(
          { output: formatOutput(result, initRef.current!) },
          {
            command: result.command,
            cwd: result.cwd,
            exitCode: result.exitCode,
            truncated: result.truncated,
            ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
            ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
            ...(result.timedOut ? { timedOut: true } : {}),
            ...(initRef.current!.warnings.length > 0
              ? { warnings: initRef.current!.warnings }
              : {}),
          },
        );
      },
    });
  }

  perf("buildDescription", t2);

  const t3 = process.hrtime.bigint();
  const writeLock = createWriteLock({
    projectRoot,
    lockedPaths: cachedConfig.locked_scripts ?? [],
    dynamicPathsRef: userWritableRef,
  });
  perf("createWriteLock", t3);
  perf("plugin() total", t0);

  return {
    tool: tools,
    ...writeLock,
  };
};

export default plugin;
