/**
 * Runtime symlink setup for restricted bash tool.
 *
 * Creates a temporary directory at /tmp/opencode-bash/<hash>/ containing
 * symlinks for every allowed executable, resolved via an injectable
 * ExecutableResolver (typically wrapping the system `which` command).
 *
 * The directory is regenerated from scratch on every call, ensuring
 * config changes are reflected immediately.
 */

import { mkdir, symlink, rm, access, constants } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { Config } from "./config.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable executable resolver. The real implementation uses the system
 * `which` command; tests provide a mock.
 */
export type ExecutableResolver = {
  which: (name: string) => Promise<string | null>
}

export type InitResult = {
  /** Path to the bin directory (to be set as PATH) */
  binDir: string
  /** Warnings for executables that could not be resolved */
  warnings: string[]
  /**
   * Symlink targets that the current user can write to.
   * These paths are vulnerable to write-through attacks and
   * should be locked down by the plugin's write-lock mechanism.
   */
  userWritableTargets: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_DIR = "/tmp/opencode-bash"

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Compute a short deterministic hash from a project root path.
 * Uses SHA-256 and takes the first 12 hex characters.
 */
function hashProjectRoot(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 12)
}

/**
 * Creates the symlink directory at /tmp/opencode-bash/<hash>/,
 * populating it with symlinks for each executable in the allowlist.
 *
 * @param options.config - The parsed config (only allow keys matter here)
 * @param options.projectRoot - The project root path (used for hashing)
 * @param options.resolver - Injectable which() resolver
 * @returns InitResult with binDir path and any warnings
 */
export async function initSymlinks(options: {
  config: Config
  projectRoot: string
  resolver: ExecutableResolver
}): Promise<InitResult> {
  const { config, projectRoot, resolver } = options
  const hash = hashProjectRoot(projectRoot)
  const binDir = join(BASE_DIR, hash)

  // Clean slate: remove old contents, then recreate directory
  await rm(binDir, { recursive: true, force: true })
  await mkdir(binDir, { recursive: true })

  const warnings: string[] = []
  const userWritableTargets: string[] = []

  // Collect all executable names: from allowlist + script interpreters (deduped)
  const execNames = new Set(Object.keys(config.allow))
  if (config.script_interpreters) {
    for (const name of config.script_interpreters) {
      execNames.add(name)
    }
  }

  for (const execName of execNames) {
    const realPath = await resolver.which(execName)
    if (realPath === null) {
      warnings.push(`Warning: '${execName}' not found in PATH — skipping symlink.`)
      continue
    }
    const linkPath = join(binDir, execName)
    try {
      await symlink(realPath, linkPath)
    } catch (err) {
      warnings.push(
        `Warning: Failed to create symlink for '${execName}' → ${realPath}: ${err}`
      )
    }

    // Check if the symlink target is user-writable (write-through risk)
    try {
      await access(realPath, constants.W_OK)
      userWritableTargets.push(realPath)
    } catch {
      // Path is not writable by this user — not a write-through risk
    }
  }

  return { binDir, warnings, userWritableTargets }
}
