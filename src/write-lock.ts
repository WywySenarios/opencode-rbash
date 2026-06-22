/**
 * Write-lock helper for creating no-edit zones.
 *
 * Provides a `createWriteLock` function that returns a `tool.execute.before`
 * hook capable of blocking `write` tool calls to specified file paths.
 *
 * Use this to protect critical files (scripts, configs, etc.) from being
 * overwritten by agents via the platform `write` tool.
 */

import { resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WriteLockInput = {
  tool: string
  sessionID: string
  callID: string
}

export type WriteLockOutput = {
  args: any
}

export type WriteLockHandler = (
  input: WriteLockInput,
  output: WriteLockOutput,
) => Promise<void>

export type WriteLockOptions = {
  /** Root directory for resolving relative locked paths */
  projectRoot: string
  /** File paths (relative or absolute) that should reject writes */
  lockedPaths: string[]
  /**
   * Optional mutable ref for paths discovered at runtime
   * (e.g., user-writable symlink targets from initSymlinks).
   * Checked on every hook invocation in addition to `lockedPaths`.
   */
  dynamicPathsRef?: { current: string[] }
}

export type WriteLockResult =
  | { "tool.execute.before": WriteLockHandler }
  | Record<string, never>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a `tool.execute.before` hook that blocks writes to the given paths.
 *
 * Supports both static paths (configured at creation time) and dynamic paths
 * (discovered at runtime via a mutable ref, e.g. from initSymlinks).
 *
 * Returns an empty object when no paths are provided and no dynamic source
 * is configured, making it safe to spread into a Hooks return value.
 *
 * Usage:
 * ```ts
 * return {
 *   tool: tools,
 *   ...createWriteLock({
 *     projectRoot,
 *     lockedPaths: config.locked_scripts ?? [],
 *     dynamicPathsRef: userWritableRef,
 *   }),
 * }
 * ```
 */
export function createWriteLock(options: WriteLockOptions): WriteLockResult {
  const { projectRoot, lockedPaths, dynamicPathsRef } = options
  const lockedAbsPaths = lockedPaths.map((s) => resolve(projectRoot, s))

  // Register a hook only if there are static paths or a dynamic source
  if (lockedAbsPaths.length === 0 && !dynamicPathsRef) return {}

  return {
    "tool.execute.before": async (
      input: WriteLockInput,
      output: WriteLockOutput,
    ): Promise<void> => {
      if (input.tool !== "write") return

      const filePath: unknown = output.args?.filePath
      if (typeof filePath !== "string") return

      const resolvedTarget = resolve(projectRoot, filePath)

      // Check static paths (configured at creation time)
      if (lockedAbsPaths.some((locked) => locked === resolvedTarget)) {
        throw new Error(
          `Cannot write to locked file: ${resolvedTarget}. This path is protected.`,
        )
      }

      // Check dynamic paths (discovered at runtime, e.g. by initSymlinks)
      if (dynamicPathsRef) {
        const current = dynamicPathsRef.current
        if (current.some((d) => d === resolvedTarget)) {
          throw new Error(
            `Cannot write to locked file: ${resolvedTarget}. This path is protected.`,
          )
        }
      }
    },
  }
}
