/**
 * Config loader for restricted bash tool.
 *
 * Reads `.opencode/bash-restricted.jsonc` from the project root,
 * with fallback to a global config file at `~/.config/opencode/`,
 * then to a dotfiles-managed config at `$HOME/dotfiles/.opencode/`.
 * Validates structure and applies defaults for missing settings.
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

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentDescriptor } from "./agent-auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AllowEntry = {
  pipe_to?: string[];
};

export type AllowConfig = Record<string, AllowEntry>;

export type Config = {
  allow: AllowConfig;
  /** Script path patterns (glob-style, e.g. "scripts/**"). Matched against
   * the command's first word. Executables in "allow" take precedence. */
  scripts?: string[];
  script_interpreters?: string[];
  locked_scripts?: string[];
  trusted_agents?: string[];
  /** Agent descriptors with mode info, used at boot to filter trusted_agents
   * to only primary-mode agents. */
  agents?: AgentDescriptor[];
  settings?: {
    timeout_ms?: number;
    workdir_policy?: string;
  };
};

type LoadConfigOptions = {
  projectRoot: string;
  globalConfigPath?: string;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WORKDIR_POLICY = "project";
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const VALID_WORKDIR_POLICIES = ["project", "any"];

// ---------------------------------------------------------------------------
// JSONC helpers
// ---------------------------------------------------------------------------

/**
 * Strips single-line comments (// ...) and trailing commas from JSONC text
 * so it can be parsed with standard JSON.parse.
 */
function preprocessJsonc(raw: string): string {
  // Remove single-line comments (but not inside strings — simplified)
  const noComments = raw.replace(/\/\/.*$/gm, "");
  // Remove trailing commas before closing braces/brackets
  const noTrailing = noComments.replace(/,(\s*[}\]])/g, "$1");
  return noTrailing;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function configFilePath(projectRoot: string): string {
  return resolve(projectRoot, ".opencode", "bash-restricted.jsonc");
}

function readConfigFileSync(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const cleaned = preprocessJsonc(content);
    return JSON.parse(cleaned);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse config file at ${path}: ${err.message}`);
    }
    // Unexpected error reading file
    return null;
  }
}

function validateConfig(config: Config, source: string): void {
  // Check allow is present and non-empty
  if (!config.allow || typeof config.allow !== "object") {
    throw new Error(
      `Config at ${source} is invalid: missing or invalid "allow" object`,
    );
  }

  const allowKeys = Object.keys(config.allow);
  if (allowKeys.length === 0) {
    throw new Error(
      `Config at ${source} has an empty allowlist — at least one executable must be allowed`,
    );
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
          `Config at ${source}: timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
        );
      }
    }

    if (config.settings.workdir_policy !== undefined) {
      if (!VALID_WORKDIR_POLICIES.includes(config.settings.workdir_policy)) {
        throw new Error(
          `Config at ${source}: workdir_policy must be one of: ${VALID_WORKDIR_POLICIES.join(", ")}`,
        );
      }
    }
  }

  // Validate scripts if present
  if (config.scripts !== undefined) {
    if (!Array.isArray(config.scripts)) {
      throw new Error(
        `Config at ${source}: scripts must be an array of strings`,
      );
    }
    for (const item of config.scripts) {
      if (typeof item !== "string") {
        throw new Error(
          `Config at ${source}: scripts entries must be strings, got ${typeof item}`,
        );
      }
    }
  }

  // Validate script_interpreters if present
  if (config.script_interpreters !== undefined) {
    if (!Array.isArray(config.script_interpreters)) {
      throw new Error(
        `Config at ${source}: script_interpreters must be an array of strings`,
      );
    }
    if (config.script_interpreters.length === 0) {
      throw new Error(
        `Config at ${source}: script_interpreters must be a non-empty array`,
      );
    }
    for (const item of config.script_interpreters) {
      if (typeof item !== "string") {
        throw new Error(
          `Config at ${source}: script_interpreters entries must be strings, got ${typeof item}`,
        );
      }
    }
  }

  // Validate locked_scripts if present
  if (config.locked_scripts !== undefined) {
    if (!Array.isArray(config.locked_scripts)) {
      throw new Error(
        `Config at ${source}: locked_scripts must be an array of strings`,
      );
    }
    for (const item of config.locked_scripts) {
      if (typeof item !== "string") {
        throw new Error(
          `Config at ${source}: locked_scripts entries must be strings, got ${typeof item}`,
        );
      }
    }
  }

  // Validate trusted_agents if present
  if (config.trusted_agents !== undefined) {
    if (!Array.isArray(config.trusted_agents)) {
      throw new Error(
        `Config at ${source}: trusted_agents must be an array of strings`,
      );
    }
    for (const item of config.trusted_agents) {
      if (typeof item !== "string") {
        throw new Error(
          `Config at ${source}: trusted_agents entries must be strings, got ${typeof item}`,
        );
      }
    }
  }

  // Validate agents if present
  if (config.agents !== undefined) {
    if (!Array.isArray(config.agents)) {
      throw new Error(`Config at ${source}: agents must be an array`);
    }
    for (const item of config.agents) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.name !== "string" ||
        !["primary", "subagent", "all"].includes(item.mode)
      ) {
        throw new Error(
          `Config at ${source}: each agent entry must have a string name and a mode of 'primary', 'subagent', or 'all'`,
        );
      }
    }
  }

  // Validate each allow entry
  for (const [name, entry] of Object.entries(config.allow)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (entry.pipe_to !== undefined && !Array.isArray(entry.pipe_to)) {
        throw new Error(
          `Config at ${source}: allow.${name}.pipe_to must be an array of strings`,
        );
      }
    } else if (entry !== undefined && entry !== null) {
      throw new Error(
        `Config at ${source}: allow.${name} must be an object (with optional pipe_to)`,
      );
    }
  }
}

function applyDefaults(config: Config): Config {
  return {
    ...config,
    settings: {
      timeout_ms: config.settings?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      workdir_policy: config.settings?.workdir_policy ?? DEFAULT_WORKDIR_POLICY,
    },
  };
}

/**
 * Resolves a global config path that may be a file, a directory (in which
 * case we look for bash-restricted.jsonc inside it), or non-existent.
 */
function resolveGlobalConfigPath(path: string): string {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      // Try bash-restricted.jsonc at the top level, then .opencode subdir
      const direct = join(path, "bash-restricted.jsonc");
      if (existsSync(direct)) return direct;
      const nested = join(path, ".opencode", "bash-restricted.jsonc");
      if (existsSync(nested)) return nested;
      // Directory exists but no config file inside — return it as-is
      // so the caller can report the correct error
      return path;
    }
  } catch {
    // Path doesn't exist — use as-is
  }
  return path;
}

/**
 * Type predicate: value is a non-null object (Record<string, unknown>).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Type predicate: value is a non-empty string array.
 */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((v): v is string => typeof v === "string")
  );
}

/**
 * Type predicate: value is a valid AllowEntry object with optional pipe_to.
 */
function isAllowEntry(value: unknown): value is AllowEntry {
  if (typeof value !== "object" || value === null) return false;
  // value is object
  if (!("pipe_to" in value)) return true; // no pipe_to is valid
  // value is object & { pipe_to: unknown }
  return isStringArray(value.pipe_to);
}

/**
 * Type predicate: value is a valid AllowConfig (Record<string, AllowEntry>).
 */
function isAllowConfig(value: unknown): value is AllowConfig {
  if (typeof value !== "object" || value === null) return false;
  for (const val of Object.values(value)) {
    if (!isAllowEntry(val)) return false;
  }
  return true;
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
        `Config at ${source} has an empty allowlist — at least one executable must be allowed`,
      );
    }
    if (!isStringArray(raw)) {
      throw new Error(
        `Config at ${source}: allow array entries must be strings, got unexpected types`,
      );
    }
    const result: AllowConfig = {};
    for (const item of raw) {
      result[item] = {};
    }
    return result;
  }
  if (isAllowConfig(raw)) {
    return raw;
  }
  throw new Error(
    `Config at ${source}: allow must be an object or array of strings`,
  );
}

/**
 * Reads a single optional string array field from a raw object.
 * Throws when the field is present but not a valid string array.
 * Returns undefined when the field is absent.
 */
function readOptionalStringArray(
  obj: object,
  key: string,
  source: string,
): string[] | undefined {
  if (!(key in obj)) return undefined;
  const val: unknown = Reflect.get(obj, key);
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) {
    throw new Error(`Config at ${source}: ${key} must be an array of strings`);
  }
  if (val.every((v): v is string => typeof v === "string")) {
    return val;
  }
  throw new Error(`Config at ${source}: ${key} entries must be strings`);
}

/**
 * Reads a single optional AgentDescriptor array field from a raw object.
 * Throws when the field is present but not a valid agents array.
 * Returns undefined when the field is absent.
 */
function readOptionalAgentArray(
  obj: object,
  key: string,
  source: string,
): AgentDescriptor[] | undefined {
  if (!(key in obj)) return undefined;
  const val: unknown = Reflect.get(obj, key);
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) {
    throw new Error(`Config at ${source}: ${key} must be an array`);
  }
  const result: AgentDescriptor[] = [];
  for (const item of val) {
    const desc = normalizeAgentDescriptor(item);
    if (desc === null) {
      // Determine which validation failed for the error message
      if (typeof item !== "object" || item === null) {
        throw new Error(
          `Config at ${source}: each agent entry must be an object`,
        );
      }
      if (!("name" in item) || !("mode" in item)) {
        throw new Error(
          `Config at ${source}: each agent entry must have a string name and mode`,
        );
      }
      throw new Error(
        `Config at ${source}: agent mode must be 'primary', 'subagent', or 'all'`,
      );
    }
    result.push(desc);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Normalises a raw value to an AgentDescriptor, or returns null on mismatch.
 * Uses 'in' operator narrowing and typeof checks — no as-casts.
 */
function normalizeAgentDescriptor(raw: unknown): AgentDescriptor | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("name" in raw) || !("mode" in raw)) return null;
  // raw: object & { name: unknown; mode: unknown }
  if (typeof raw.name !== "string") return null;
  if (typeof raw.mode !== "string") return null;
  // raw: object & { name: string; mode: string }
  // Narrow string to literal union via individual != checks
  if (raw.mode !== "primary" && raw.mode !== "subagent" && raw.mode !== "all")
    return null;
  // raw.mode is now "primary" | "subagent" | "all"
  return { name: raw.name, mode: raw.mode };
}

/**
 * Reads the optional settings block from a raw object.
 * Only copies recognised fields with correct types.
 */
function readSettings(
  raw: unknown,
): { timeout_ms?: number; workdir_policy?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const result: { timeout_ms?: number; workdir_policy?: string } = {};
  if ("timeout_ms" in raw && typeof raw.timeout_ms === "number") {
    result.timeout_ms = raw.timeout_ms;
  }
  if ("workdir_policy" in raw && typeof raw.workdir_policy === "string") {
    result.workdir_policy = raw.workdir_policy;
  }
  return result;
}

/**
 * Reads, normalises, validates, and applies defaults for a single config file.
 * Returns null if the file does not exist.
 */
function loadFromPath(path: string): Config | null {
  const raw = readConfigFileSync(path);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Config at ${path}: must be a JSON object`);
  }
  // raw: object

  const allow = normalizeAllowlist(Reflect.get(raw, "allow"), path);
  const config: Config = {
    allow,
    scripts: readOptionalStringArray(raw, "scripts", path),
    script_interpreters: readOptionalStringArray(
      raw,
      "script_interpreters",
      path,
    ),
    locked_scripts: readOptionalStringArray(raw, "locked_scripts", path),
    trusted_agents: readOptionalStringArray(raw, "trusted_agents", path),
    agents: readOptionalAgentArray(raw, "agents", path),
    settings: readSettings(Reflect.get(raw, "settings")),
  };
  validateConfig(config, path);
  return applyDefaults(config);
}

// Cache keyed by projectRoot (and optionally globalConfigPath) so repeated
// calls — e.g. during hot reload — skip the three-location I/O fallback chain.
const configCache = new Map<string, Config>();

function cacheKey(projectRoot: string, globalConfigPath?: string): string {
  return globalConfigPath
    ? `${projectRoot}\x00${globalConfigPath}`
    : projectRoot;
}

/**
 * Loads the restricted bash config from the project directory,
 * falling back to a global config file (`~/.config/opencode/...`),
 * then to a dotfiles-managed config (`$HOME/dotfiles/.opencode/...`).
 *
 * Synchronous — called once at plugin startup.
 * Results are cached so repeated lookups skip the fallback I/O chain.
 */
export function loadConfig(options: LoadConfigOptions): Config {
  const { projectRoot, globalConfigPath } = options;
  const key = cacheKey(projectRoot, globalConfigPath);
  const cached = configCache.get(key);
  if (cached) return cached;

  // Try project config first
  const projectConfigPath = configFilePath(projectRoot);
  const projectConfig = loadFromPath(projectConfigPath);
  if (projectConfig) {
    configCache.set(key, projectConfig);
    return projectConfig;
  }

  // Fall back to global config
  const rawGlobalPath =
    globalConfigPath ??
    join(homedir(), ".config", "opencode", "bash-restricted.jsonc");

  const globalPath = resolveGlobalConfigPath(rawGlobalPath);
  const globalConfig = loadFromPath(globalPath);
  if (globalConfig) {
    configCache.set(key, globalConfig);
    return globalConfig;
  }

  // Fall back to dotfiles config ($HOME/dotfiles/.opencode/bash-restricted.jsonc)
  const dotfilesPath = join(
    homedir(),
    "dotfiles",
    ".opencode",
    "bash-restricted.jsonc",
  );
  const dotfilesConfig = loadFromPath(dotfilesPath);
  if (dotfilesConfig) {
    configCache.set(key, dotfilesConfig);
    return dotfilesConfig;
  }

  // None found — panic
  throw new Error(
    `Restricted bash tool cannot start — no config found.\n` +
      `Checked:\n` +
      `  - ${projectConfigPath} (project)\n` +
      `  - ${globalPath} (global)\n` +
      `  - ${dotfilesPath} (dotfiles)\n` +
      `Create one of these files with an executable allowlist.`,
  );
}
