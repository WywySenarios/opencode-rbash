/**
 * Config loader for restricted bash tool.
 *
 * Reads `.opencode/bash-restricted.jsonc` from the project root,
 * with fallback to a global config file. Validates structure and
 * applies defaults for missing settings.
 *
 * The `allow` field accepts two shapes:
 *   - `Record<string, AllowEntry>` — object form with optional pipe_to rules
 *   - `Array<string>` — migrated shorthand; each string becomes an entry with
 *     no pipe_to restriction (converted to Record at load time)
 *
 * Note: This module uses synchronous I/O because it is called from
 * synchronous test code (plugin startup). Config files are small
 * and read once at startup, so the blocking is negligible.
 */

import { readFileSync, existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AllowEntry = {
  pipe_to?: string[]
}

export type AllowConfig = Record<string, AllowEntry>

export type Config = {
  allow: AllowConfig
  script_interpreters?: string[]
  locked_scripts?: string[]
  settings?: {
    timeout_ms?: number
    workdir_policy?: string
  }
}

type LoadConfigOptions = {
  projectRoot: string
  globalConfigPath?: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_WORKDIR_POLICY = "project"
const MAX_TIMEOUT_MS = 600_000
const MIN_TIMEOUT_MS = 1_000
const VALID_WORKDIR_POLICIES = ["project", "any"]

// ---------------------------------------------------------------------------
// JSONC helpers
// ---------------------------------------------------------------------------

/**
 * Strips single-line comments (// ...) and trailing commas from JSONC text
 * so it can be parsed with standard JSON.parse.
 */
function preprocessJsonc(raw: string): string {
  // Remove single-line comments (but not inside strings — simplified)
  const noComments = raw.replace(/\/\/.*$/gm, "")
  // Remove trailing commas before closing braces/brackets
  const noTrailing = noComments.replace(/,(\s*[}\]])/g, "$1")
  return noTrailing
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function configFilePath(projectRoot: string): string {
  return resolve(projectRoot, ".opencode", "bash-restricted.jsonc")
}

function readConfigFileSync(path: string): Config | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    const cleaned = preprocessJsonc(raw)
    const parsed = JSON.parse(cleaned)
    return parsed
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `Failed to parse config file at ${path}: ${err.message}`
      )
    }
    // Unexpected error reading file
    return null
  }
}

function validateConfig(config: Config, source: string): void {
  // Check allow is present and non-empty
  if (!config.allow || typeof config.allow !== "object") {
    throw new Error(
      `Config at ${source} is invalid: missing or invalid "allow" object`
    )
  }

  const allowKeys = Object.keys(config.allow)
  if (allowKeys.length === 0) {
    throw new Error(
      `Config at ${source} has an empty allowlist — at least one executable must be allowed`
    )
  }

  // Validate settings if present
  if (config.settings) {
    if (config.settings.timeout_ms !== undefined) {
      if (
        !Number.isInteger(config.settings.timeout_ms) ||
        config.settings.timeout_ms < MIN_TIMEOUT_MS ||
        config.settings.timeout_ms > MAX_TIMEOUT_MS
      ) {
        throw new Error(
          `Config at ${source}: timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`
        )
      }
    }

    if (config.settings.workdir_policy !== undefined) {
      if (!VALID_WORKDIR_POLICIES.includes(config.settings.workdir_policy)) {
        throw new Error(
          `Config at ${source}: workdir_policy must be one of: ${VALID_WORKDIR_POLICIES.join(", ")}`
        )
      }
    }
  }

  // Validate script_interpreters if present
  if (config.script_interpreters !== undefined) {
    if (!Array.isArray(config.script_interpreters)) {
      throw new Error(
        `Config at ${source}: script_interpreters must be an array of strings`
      )
    }
    if (config.script_interpreters.length === 0) {
      throw new Error(
        `Config at ${source}: script_interpreters must be a non-empty array`
      )
    }
    for (const item of config.script_interpreters) {
      if (typeof item !== "string") {
        throw new Error(
          `Config at ${source}: script_interpreters entries must be strings, got ${typeof item}`
        )
      }
    }
  }

  // Validate locked_scripts if present
  if (config.locked_scripts !== undefined) {
    if (!Array.isArray(config.locked_scripts)) {
      throw new Error(
        `Config at ${source}: locked_scripts must be an array of strings`
      )
    }
    for (const item of config.locked_scripts) {
      if (typeof item !== "string") {
        throw new Error(
          `Config at ${source}: locked_scripts entries must be strings, got ${typeof item}`
        )
      }
    }
  }

  // Validate each allow entry
  for (const [name, entry] of Object.entries(config.allow)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (entry.pipe_to !== undefined && !Array.isArray(entry.pipe_to)) {
        throw new Error(
          `Config at ${source}: allow.${name}.pipe_to must be an array of strings`
        )
      }
    } else if (entry !== undefined && entry !== null) {
      throw new Error(
        `Config at ${source}: allow.${name} must be an object (with optional pipe_to)`
      )
    }
  }
}

function applyDefaults(config: Config): Config {
  return {
    ...config,
    settings: {
      timeout_ms: config.settings?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      workdir_policy:
        config.settings?.workdir_policy ?? DEFAULT_WORKDIR_POLICY,
    },
  }
}

/**
 * Resolves a global config path that may be a file, a directory (in which
 * case we look for bash-restricted.jsonc inside it), or non-existent.
 */
function resolveGlobalConfigPath(path: string): string {
  try {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      // Try bash-restricted.jsonc at the top level, then .opencode subdir
      const direct = join(path, "bash-restricted.jsonc")
      if (existsSync(direct)) return direct
      const nested = join(path, ".opencode", "bash-restricted.jsonc")
      if (existsSync(nested)) return nested
      // Directory exists but no config file inside — return it as-is
      // so the caller can report the correct error
      return path
    }
  } catch {
    // Path doesn't exist — use as-is
  }
  return path
}

/**
 * Normalises a raw allowlist value (which may be an Array<string> or a
 * Record<string, AllowEntry>) into the canonical AllowConfig shape.
 *
 * When the allowlist is an array of strings (migrated shape), each string
 * becomes a key with an empty AllowEntry (no pipe_to restriction).
 */
function normalizeAllowlist(raw: unknown, source: string): AllowConfig {
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error(
        `Config at ${source} has an empty allowlist — at least one executable must be allowed`
      )
    }
    const result: AllowConfig = {}
    for (const item of raw) {
      if (typeof item !== "string") {
        throw new Error(
          `Config at ${source}: allow array entries must be strings, got ${typeof item}`
        )
      }
      result[item] = {}
    }
    return result
  }
  return raw as AllowConfig
}

/**
 * Reads, normalises, validates, and applies defaults for a single config file.
 * Returns null if the file does not exist.
 */
function loadFromPath(path: string): Config | null {
  const raw = readConfigFileSync(path)
  if (!raw) return null
  const bag = raw as Record<string, unknown>
  bag.allow = normalizeAllowlist(bag.allow, path)
  validateConfig(bag as Config, path)
  return applyDefaults(bag as Config)
}

/**
 * Loads the restricted bash config from the project directory,
 * falling back to a global config file if the project config is missing.
 *
 * Synchronous — called once at plugin startup.
 */
export function loadConfig(options: LoadConfigOptions): Config {
  const { projectRoot, globalConfigPath } = options

  // Try project config first
  const projectConfigPath = configFilePath(projectRoot)
  const projectConfig = loadFromPath(projectConfigPath)
  if (projectConfig) return projectConfig

  // Fall back to global config
  const rawGlobalPath =
    globalConfigPath ??
    join(homedir(), ".config", "opencode", "bash-restricted.jsonc")

  const globalPath = resolveGlobalConfigPath(rawGlobalPath)
  const globalConfig = loadFromPath(globalPath)
  if (globalConfig) return globalConfig

  // Neither exists — panic
  throw new Error(
    `Restricted bash tool cannot start — no config found.\n` +
      `Checked:\n` +
      `  - ${projectConfigPath} (project)\n` +
      `  - ${globalPath} (global)\n` +
      `Create one of these files with an executable allowlist.`
  )
}
