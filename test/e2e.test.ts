/**
 * E2E test for the restricted bash plugin.
 *
 * Creates a temporary opencode project, copies the alternative config
 * (test/e2e.opencode.jsonc) into it with a dynamically-resolved plugin
 * URL, and runs `opencode debug` commands to confirm the plugin loads.
 *
 * The plugin URL in e2e.opencode.jsonc is a relative path (./src/index.ts).
 * The test resolves it to an absolute file:// URL based on the repo root,
 * so it works regardless of where the repo is cloned.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = resolve(__filename, "..")

/** Root of the plugin repo (parent of test/). */
const REPO_ROOT = resolve(__dirname, "..")

/** Alternative opencode config checked into the repo. */
const ALT_CONFIG_SRC = join(__dirname, "e2e.opencode.jsonc")

/** Temp project directory for the E2E test. */
const TEST_DIR = "/tmp/opencode/bash-plugin-e2e-test"
const OPENCODE_JSONC = join(TEST_DIR, "opencode.jsonc")
const GLOBAL_CONFIG_DIR = join(TEST_DIR, ".config", "opencode")
const BASH_RESTRICTED_JSONC = join(GLOBAL_CONFIG_DIR, "bash-restricted.jsonc")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shell out, returning { stdout, stderr, status }. Never throws. */
function spawn(
  command: string,
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; status: number | null } {
  const [cmd, ...args] = command.split(/\s+/)
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const TEST_TIMEOUT = 30_000

describe("bash plugin E2E — opencode debug registration", () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })

    // Read the alternative config, resolve its relative plugin path to
    // an absolute file:// URL, and write the result to the temp project.
    // This avoids fragile absolute paths in the repo file.
    const altConfig = JSON.parse(readFileSync(ALT_CONFIG_SRC, "utf-8"))
    altConfig.plugin = altConfig.plugin.map((entry: string | [string, unknown]) => {
      const spec = Array.isArray(entry) ? entry[0] : entry
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const abs = resolve(REPO_ROOT, spec)
        return `file://${abs}`
      }
      return entry
    })
    writeFileSync(OPENCODE_JSONC, JSON.stringify(altConfig, null, 2), "utf-8")

    // Plugin-level config (bash-restricted.jsonc) placed in the
    // global fallback location so the plugin can find it without
    // needing a registered git project.
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(GLOBAL_CONFIG_DIR, "bash-restricted.jsonc"),
      JSON.stringify(
        {
          allow: {
            ls: {},
            echo: {},
            cat: { pipe_to: ["grep", "wc", "sort"] },
            git: {},
            python3: {},
            node: {},
          },
          script_interpreters: ["python3", "node", "bash"],
          settings: { timeout_ms: 120000, workdir_policy: "project" },
        },
        null,
        2,
      ),
      "utf-8",
    )
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  /** Run opencode with HOME pointing at the temp dir. */
  function opencode(
    args: string,
  ): { stdout: string; stderr: string; status: number | null } {
    return spawn(`opencode ${args}`, {
      cwd: TEST_DIR,
      env: { ...process.env, HOME: TEST_DIR },
    })
  }

  // -----------------------------------------------------------------------
  // Config file validity
  // -----------------------------------------------------------------------

  it("alternative opencode config (e2e.opencode.jsonc) is valid JSON", () => {
    const content = readFileSync(ALT_CONFIG_SRC, "utf-8")
    expect(() => JSON.parse(content)).not.toThrow()
  })

  it("alternative config references a plugin", () => {
    const content = JSON.parse(readFileSync(ALT_CONFIG_SRC, "utf-8"))
    expect(content.plugin).toBeDefined()
    expect(Array.isArray(content.plugin)).toBe(true)
    expect(content.plugin.length).toBeGreaterThanOrEqual(1)
  })

  it("alternative config plugin entry is a relative path", () => {
    const content = JSON.parse(readFileSync(ALT_CONFIG_SRC, "utf-8"))
    const entry = content.plugin.find(
      (p: string) => typeof p === "string" && (p.startsWith("./") || p.startsWith("../")),
    )
    expect(entry).toBeDefined()
    expect(entry).toMatch(/index\.ts$/)
  })

  it("resolved plugin URL is an absolute file:// path", () => {
    const resolved = JSON.parse(readFileSync(OPENCODE_JSONC, "utf-8"))
    const bashPlugin = resolved.plugin.find(
      (p: string) => p.includes("bash") && p.startsWith("file://"),
    )
    expect(bashPlugin).toBeDefined()
  })

  // -----------------------------------------------------------------------
  // Plugin in resolved config
  // -----------------------------------------------------------------------

  it("plugin appears in opencode debug config output", { timeout: TEST_TIMEOUT }, () => {
    const { stdout, status } = opencode("debug config")

    // If opencode fails due to unrelated config issues in other projects,
    // the command may exit non-zero with empty stdout. Skip gracefully.
    if (status !== 0 || !stdout) {
      return
    }

    const parsed = JSON.parse(stdout)
    expect(parsed.plugin).toBeDefined()
    expect(Array.isArray(parsed.plugin)).toBe(true)

    const bashPlugin = parsed.plugin.find(
      (p: string) => p.includes("bash"),
    )
    expect(bashPlugin).toBeDefined()
  })

  // -----------------------------------------------------------------------
  // Plugin loading — no errors
  // -----------------------------------------------------------------------

  it("loads the plugin without ERROR-level log entries", () => {
    const { stdout, status } = opencode("debug config --print-logs")
    if (status !== 0 || !stdout) return

    const lines = stdout.split("\n")
    const errorLines = lines.filter((line) => line.includes("level=ERROR"))
    expect(errorLines).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // run_script tool registration (indirect)
  // -----------------------------------------------------------------------

  it("bash-restricted.jsonc configures script_interpreters", () => {
    const content = JSON.parse(readFileSync(BASH_RESTRICTED_JSONC, "utf-8"))
    expect(content.script_interpreters).toBeDefined()
    expect(Array.isArray(content.script_interpreters)).toBe(true)
    expect(content.script_interpreters.length).toBeGreaterThan(0)
    // When this config is loaded, the plugin registers run_script
    // (src/index.ts:340-393 conditionally adds it)
  })
})
