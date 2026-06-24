/**
 * Tests for the config module (src/config.ts)
 *
 * Verifies:
 * - Loading config from project and global locations
 * - Fallback behavior when config is missing
 * - Validation of config structure (empty allowlist, malformed JSONC)
 * - Default settings application
 * - pipe_to rule parsing
 */

import { loadConfig, type Config, type AllowConfig } from "../src/config"
import { validateCommand } from "../src/validate"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_VALID_CONFIG = {
  allow: {
    ls: {},
    echo: {},
    cat: { pipe_to: ["grep", "wc", "sort"] },
  },
}

const FULL_VALID_CONFIG: Config = {
  allow: {
    ls: {},
    echo: {},
    git: {},
    cat: { pipe_to: ["grep", "wc", "sort", "sed", "rg", "uniq"] },
    python3: {},
  },
  settings: {
    timeout_ms: 300_000,
    workdir_policy: "project",
  },
}

// ---------------------------------------------------------------------------
// loadConfig — project config exists
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("loads project config when .opencode/bash-restricted.jsonc exists", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project",
      // The test infrastructure provides a config at this location
    })
    expect(config).toBeDefined()
    expect(config.allow).toBeDefined()
    expect(Object.keys(config.allow).length).toBeGreaterThan(0)
  })

  it("returns allow object with executable names as keys", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project",
    })
    expect(config.allow).toHaveProperty("ls")
    expect(config.allow).toHaveProperty("echo")
  })

  it("parses pipe_to rules from config", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project",
    })
    expect(config.allow.cat).toBeDefined()
    expect(config.allow.cat!.pipe_to).toBeDefined()
    expect(config.allow.cat!.pipe_to).toContain("grep")
    expect(config.allow.cat!.pipe_to).toContain("wc")
  })

  it("parses settings with defaults when settings are missing", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-minimal",
    })
    expect(config.settings).toBeDefined()
    expect(config.settings?.timeout_ms).toBe(120_000) // default 2 min
    expect(config.settings?.workdir_policy).toBe("project") // default "project"
  })

  it("uses provided settings when present", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-full",
    })
    expect(config.settings?.timeout_ms).toBe(300_000)
    expect(config.settings?.workdir_policy).toBe("project")
  })

  it("resolves workdir_policy value from config", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-with-any-policy",
    })
    // "any" is a valid alternative
    expect(["project", "any"]).toContain(config.settings?.workdir_policy)
  })

  it("accepts 'any' as a valid workdir_policy", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-any-policy",
    })
    expect(config.settings?.workdir_policy).toBe("any")
  })
})

// ---------------------------------------------------------------------------
// loadConfig — missing/fallback scenarios
// ---------------------------------------------------------------------------

describe("loadConfig — missing config", () => {
  beforeAll(() => {
    // Stub HOME so we don't accidentally find the real system dotfiles config
    vi.stubEnv("HOME", "/tmp/test-missing-config-home")
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it("falls back to global config when project config is missing", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-no-local",
      globalConfigPath: "/tmp/test-global-config",
    })
    expect(config).toBeDefined()
    expect(config.allow).toHaveProperty("ls")
  })

  it("throws when neither project, global, nor dotfiles config exists", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-nonexistent",
        globalConfigPath: "/tmp/test-global-nonexistent",
      })
    ).toThrow("no config found")
  })

  it("throws with paths of all three checked locations in the error message", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-nonexistent",
        globalConfigPath: "/tmp/test-global-nonexistent",
      })
    ).toThrow(/bash-restricted\.jsonc/)
  })

  it("error message includes the dotfiles fallback path", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-nonexistent",
        globalConfigPath: "/tmp/test-global-nonexistent",
      })
    ).toThrow(/dotfiles/)
  })
})

// ---------------------------------------------------------------------------
// loadConfig — validation
// ---------------------------------------------------------------------------

describe("loadConfig — validation", () => {
  it("throws when allowlist is empty", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-empty-allow",
      })
    ).toThrow("allowlist")
  })

  it("throws on malformed JSONC", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-malformed",
      })
    ).toThrow(/parse|malformed|syntax/i)
  })
})

// ---------------------------------------------------------------------------
// loadConfig — project overrides global
// ---------------------------------------------------------------------------

describe("loadConfig — override behavior", () => {
  it("project config takes precedence over global config", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-override",
      globalConfigPath: "/tmp/test-global-override",
    })
    // Project has timeout 500000, global has 120000
    expect(config.settings?.timeout_ms).toBe(500_000)
  })

  it("merges allowlist from project config (does not include global entries)", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-merge",
      globalConfigPath: "/tmp/test-global-merge",
    })
    // Only project-level executable should be present
    expect(config.allow).toHaveProperty("project-only-tool")
    // Global-only executable should NOT be present
    expect(config.allow).not.toHaveProperty("global-only-tool")
  })
})

// ---------------------------------------------------------------------------
// loadConfig — edge cases
// ---------------------------------------------------------------------------

describe("loadConfig — edge cases", () => {
  it("handles config with only one executable in allowlist", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-single-entry",
    })
    expect(Object.keys(config.allow).length).toBe(1)
  })

  it("handles pipe_to as empty array (piping from this exec is blocked entirely)", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-no-pipe",
    })
    expect(config.allow.echo!.pipe_to).toEqual([])
  })

  it("handles pipe_to absence as unrestricted piping", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-unrestricted-pipe",
    })
    expect(config.allow.ls!.pipe_to).toBeUndefined()
  })

  it("removes comment lines from JSONC before parsing", () => {
    // JSONC allows // comments, standard JSON.parse would reject them
    const config = loadConfig({
      projectRoot: "/tmp/test-project-jsonc-comments",
    })
    expect(config.allow).toHaveProperty("ls")
  })

  it("handles trailing commas in JSONC", () => {
    const config = loadConfig({
      projectRoot: "/tmp/test-project-jsonc-trailing-comma",
    })
    expect(config.allow).toHaveProperty("ls")
  })

  it("rejects timeout_ms exceeding maximum (600000)", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-timeout-too-high",
      })
    ).toThrow(/timeout/i)
  })

  it("rejects timeout_ms less than minimum (1000)", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-timeout-too-low",
      })
    ).toThrow(/timeout/i)
  })

  it("rejects invalid workdir_policy (not 'project' or 'any')", () => {
    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-invalid-policy",
      })
    ).toThrow(/workdir_policy|invalid/i)
  })
})

// ---------------------------------------------------------------------------
// loadConfig — migrated allowlist shape (Array<string>)
// ---------------------------------------------------------------------------

describe("loadConfig — allowlist as array of strings", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-migrated-allowlist-array"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: ["ls", "echo", "cat", "git"],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("loads config when allow is an array of executable names (migrated shape)", () => {
    // RED: Currently loadConfig rejects allow: ["ls", "echo"] because
    // validateConfig() checks typeof entry === "object" and throws for strings.
    // This test proves the migrated Array<string> shape is NOT yet accepted.
    const config = loadConfig({ projectRoot: testDir })
    expect(config.allow).toHaveProperty("ls")
    expect(config.allow.ls).toBeDefined()
    // When allow is an array, entries should be normalised to { pipe_to?: undefined }
    expect(config.allow.ls?.pipe_to).toBeUndefined()
  })

  it("enables validation against executables from array-form allowlist", () => {
    const config = loadConfig({ projectRoot: testDir })
    const result = validateCommand("ls -la", config.allow)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// loadConfig — script_interpreters
// ---------------------------------------------------------------------------

describe("loadConfig — script_interpreters", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-project-script-interps"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        script_interpreters: ["python", "node", "deno", "bash"],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("loads config with script_interpreters array", () => {
    const config = loadConfig({ projectRoot: testDir })
    expect(config.script_interpreters).toBeDefined()
    expect(config.script_interpreters).toEqual(["python", "node", "deno", "bash"])
  })

  it("script_interpreters entries are strings", () => {
    const config = loadConfig({ projectRoot: testDir })
    for (const interp of config.script_interpreters!) {
      expect(typeof interp).toBe("string")
    }
  })

  it("loadConfig does not reject config without script_interpreters (backward compat)", () => {
    const config = loadConfig({ projectRoot: "/tmp/test-project" })
    // 'allow' still loads fine
    expect(config.allow).toHaveProperty("ls")
    // No script_interpreters should not cause an error
    expect(config.script_interpreters).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// loadConfig — trusted_agents
// ---------------------------------------------------------------------------

describe("loadConfig — trusted_agents", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-project-trusted-agents"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        trusted_agents: ["plan", "build"],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("loads config with trusted_agents array", () => {
    const config = loadConfig({ projectRoot: testDir })
    expect(config.trusted_agents).toBeDefined()
    expect(Array.isArray(config.trusted_agents)).toBe(true)
  })

  it("preserves trusted_agents values in the parsed config", () => {
    const config = loadConfig({ projectRoot: testDir })
    expect(config.trusted_agents).toEqual(["plan", "build"])
  })

  it("trusted_agents entries are strings", () => {
    const config = loadConfig({ projectRoot: testDir })
    for (const name of config.trusted_agents!) {
      expect(typeof name).toBe("string")
    }
  })

  it("rejects trusted_agents with non-array values", () => {
    const badDir = "/tmp/test-project-bad-trusted"
    rmSync(badDir, { recursive: true, force: true })
    mkdirSync(join(badDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(badDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        trusted_agents: "not-an-array",
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    expect(() => loadConfig({ projectRoot: badDir })).toThrow()
    rmSync(badDir, { recursive: true, force: true })
  })

  it("rejects trusted_agents with non-string entries", () => {
    const badDir = "/tmp/test-project-bad-trusted-entries"
    rmSync(badDir, { recursive: true, force: true })
    mkdirSync(join(badDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(badDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        trusted_agents: [123, true],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    expect(() => loadConfig({ projectRoot: badDir })).toThrow()
    rmSync(badDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// loadConfig — agents field
// ---------------------------------------------------------------------------

describe("loadConfig — agents field", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-project-config-agents"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        agents: [
          { name: "plan", mode: "primary" },
          { name: "explore", mode: "subagent" },
          { name: "general", mode: "all" },
        ],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("loads config with agents array", () => {
    const config = loadConfig({ projectRoot: testDir })
    expect(config.agents).toBeDefined()
    expect(Array.isArray(config.agents)).toBe(true)
    expect(config.agents).toHaveLength(3)
  })

  it("preserves agent names and modes in parsed config", () => {
    const config = loadConfig({ projectRoot: testDir })
    expect(config.agents![0]).toEqual({ name: "plan", mode: "primary" })
    expect(config.agents![1]).toEqual({ name: "explore", mode: "subagent" })
    expect(config.agents![2]).toEqual({ name: "general", mode: "all" })
  })

  it("works alongside trusted_agents for filtering", () => {
    const fullDir = "/tmp/test-project-config-agents-full"
    rmSync(fullDir, { recursive: true, force: true })
    mkdirSync(join(fullDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(fullDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        trusted_agents: ["plan", "explore"],
        agents: [
          { name: "plan", mode: "primary" },
          { name: "explore", mode: "subagent" },
        ],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    const config = loadConfig({ projectRoot: fullDir })
    expect(config.trusted_agents).toEqual(["plan", "explore"])
    expect(config.agents).toEqual([
      { name: "plan", mode: "primary" },
      { name: "explore", mode: "subagent" },
    ])
    rmSync(fullDir, { recursive: true, force: true })
  })

  it("rejects agents with non-array value", () => {
    const badDir = "/tmp/test-project-bad-agents"
    rmSync(badDir, { recursive: true, force: true })
    mkdirSync(join(badDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(badDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        agents: "not-an-array",
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    expect(() => loadConfig({ projectRoot: badDir })).toThrow()
    rmSync(badDir, { recursive: true, force: true })
  })

  it("rejects agents with invalid entry (missing name)", () => {
    const badDir = "/tmp/test-project-bad-agents-missing-name"
    rmSync(badDir, { recursive: true, force: true })
    mkdirSync(join(badDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(badDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        agents: [{ mode: "primary" }],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    expect(() => loadConfig({ projectRoot: badDir })).toThrow()
    rmSync(badDir, { recursive: true, force: true })
  })

  it("rejects agents with invalid entry (bad mode)", () => {
    const badDir = "/tmp/test-project-bad-agents-mode"
    rmSync(badDir, { recursive: true, force: true })
    mkdirSync(join(badDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(badDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        agents: [{ name: "plan", mode: "invalid-mode" }],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    expect(() => loadConfig({ projectRoot: badDir })).toThrow()
    rmSync(badDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// loadConfig — dotfiles fallback ($HOME/dotfiles/.opencode/...)
// ---------------------------------------------------------------------------

describe("loadConfig — dotfiles fallback", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/opencode/test-dotfiles-fallback"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    // Create $HOME/dotfiles/.opencode/bash-restricted.jsonc
    // This simulates a dotfiles-managed global fallback config
    mkdirSync(join(testDir, "dotfiles", ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, "dotfiles", ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {}, dotfiles_only_tool: {} },
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it("falls back to $HOME/dotfiles/.opencode/bash-restricted.jsonc when project and standard global config are missing", () => {
    vi.stubEnv("HOME", testDir)

    const config = loadConfig({
      // Project without a local config
      projectRoot: join(testDir, "nonexistent-project"),
      // No globalConfigPath — relies on homedir() to find standard global
    })

    // The config should be loaded from the dotfiles location
    expect(config).toBeDefined()
    expect(config.allow).toHaveProperty("ls")
    expect(config.allow).toHaveProperty("echo")
    // Only the dotfiles config has this entry
    expect(config.allow).toHaveProperty("dotfiles_only_tool")
    // Default settings should be applied
    expect(config.settings?.timeout_ms).toBe(120_000)
    expect(config.settings?.workdir_policy).toBe("project")
  })

  it("dotfiles fallback is lower priority than explicit globalConfigPath", () => {
    // When a globalConfigPath IS provided and has a valid config,
    // it should be used instead of the dotfiles fallback
    vi.stubEnv("HOME", testDir)

    const config = loadConfig({
      projectRoot: join(testDir, "nonexistent-project"),
      globalConfigPath: "/tmp/test-global-config",
    })

    // Should load from the explicitly provided global path,
    // not from the dotfiles location
    expect(config).toBeDefined()
    expect(config.allow).toHaveProperty("ls")
    // The dotfiles-only tool should NOT be present
    expect(config.allow).not.toHaveProperty("dotfiles_only_tool")
  })
})

// ---------------------------------------------------------------------------
// loadConfig — globalConfigPath directory resolution (.opencode subdirectory)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// loadConfig — scripts field
// ---------------------------------------------------------------------------

describe("loadConfig — scripts field", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-project-scripts-field-config"
  const noScriptsDir = "/tmp/test-project-no-scripts-field-config"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        scripts: ["scripts/**", "./scripts/*"],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )

    rmSync(noScriptsDir, { recursive: true, force: true })
    mkdirSync(join(noScriptsDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(noScriptsDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    rmSync(noScriptsDir, { recursive: true, force: true })
  })

  it("loads scripts field from config", () => {
    const config = loadConfig({ projectRoot: testDir })
    expect(config.scripts).toBeDefined()
    expect(Array.isArray(config.scripts)).toBe(true)
    expect(config.scripts).toEqual(["scripts/**", "./scripts/*"])
  })

  it("scripts entries are strings", () => {
    const config = loadConfig({ projectRoot: testDir })
    for (const entry of config.scripts!) {
      expect(typeof entry).toBe("string")
    }
  })

  it("config without scripts field still loads (backward compat)", () => {
    const config = loadConfig({ projectRoot: noScriptsDir })
    expect(config.scripts).toBeUndefined()
  })

  it("rejects scripts with non-array value", () => {
    const badDir = "/tmp/test-project-scripts-bad-type"
    rmSync(badDir, { recursive: true, force: true })
    mkdirSync(join(badDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(badDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        scripts: "not-an-array",
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    expect(() => loadConfig({ projectRoot: badDir })).toThrow()
    rmSync(badDir, { recursive: true, force: true })
  })

  it("rejects scripts with non-string entries", () => {
    const badDir = "/tmp/test-project-scripts-bad-entries"
    rmSync(badDir, { recursive: true, force: true })
    mkdirSync(join(badDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(badDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        scripts: [123, true],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    expect(() => loadConfig({ projectRoot: badDir })).toThrow()
    rmSync(badDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// loadConfig — globalConfigPath as directory with .opencode subdirectory
// ---------------------------------------------------------------------------

describe("loadConfig — globalConfigPath as directory with .opencode subdirectory", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-global-opencode-nested"
  // Use this HOME to prevent the real dotfiles fallback from being found
  const isolatedHome = "/tmp/test-global-opencode-home"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    // Create a directory that ONLY has .opencode/bash-restricted.jsonc
    // (no direct bash-restricted.jsonc at the top level)
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { nested_ls: {} },
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
    vi.stubEnv("HOME", isolatedHome)
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it("resolves a directory path by finding .opencode/bash-restricted.jsonc nested inside", () => {
    // The globalConfigPath points to a directory (not a file).
    // resolveGlobalConfigPath should detect it's a directory and
    // look for .opencode/bash-restricted.jsonc inside it.
    const config = loadConfig({
      projectRoot: "/tmp/test-project-nonexistent",
      globalConfigPath: testDir,
    })

    expect(config).toBeDefined()
    expect(config.allow).toHaveProperty("nested_ls")
  })

  it("falls through when directory contains neither bash-restricted.jsonc nor .opencode/ subdirectory", () => {
    // Create a directory with no config file inside
    const emptyDir = join(testDir, "empty")
    mkdirSync(emptyDir, { recursive: true })

    expect(() =>
      loadConfig({
        projectRoot: "/tmp/test-project-nonexistent",
        globalConfigPath: emptyDir,
      })
    ).toThrow("no config found")
  })
})
