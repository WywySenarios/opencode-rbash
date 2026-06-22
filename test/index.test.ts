/**
 * Tests for the plugin entry point (src/index.ts)
 *
 * Verifies:
 * - Plugin registers "bash" tool via Hooks.tool
 * - Tool schema accepts valid input
 * - Tool schema rejects invalid input
 * - Tool description mentions allowlist restrictions
 * - Plugin function signature matches expected Plugin type
 */
import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import plugin from "../src/index"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PLUGIN_INPUT: PluginInput = {
  client: {} as any,
  project: { id: "test", name: "test" } as any,
  directory: "/tmp/test-project",
  worktree: "/tmp/test-project",
  experimental_workspace: {} as any,
  serverUrl: new URL("http://localhost"),
  $: {} as any,
}

// ---------------------------------------------------------------------------
// Plugin structure
// ---------------------------------------------------------------------------

describe("plugin entry point", () => {
  it("exports a default Plugin function", () => {
    expect(typeof plugin).toBe("function")
  })

  it("returns a Hooks object with a tool property", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    expect(hooks).toBeDefined()
    expect(hooks.tool).toBeDefined()
  })

  it("registers a tool named 'bash'", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    expect(hooks.tool).toHaveProperty("bash")
  })
})

// ---------------------------------------------------------------------------
// Tool structure
// ---------------------------------------------------------------------------

describe("plugin — tool definition", () => {
  it("tool has a description string", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    expect(typeof bashTool.description).toBe("string")
    expect(bashTool.description.length).toBeGreaterThan(0)
  })

  it("tool has an args property with Zod schema", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    expect(bashTool.args).toBeDefined()
    expect(bashTool.args._def).toBeDefined() // is a Zod schema
  })

  it("tool args schema includes an optional container field", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const args = bashTool.args as z.ZodObject<any>
    expect(args.shape).toHaveProperty("container")
  })

  it("tool has an execute function", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    expect(typeof bashTool.execute).toBe("function")
  })

  it("tool description references the allowlist", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    expect(bashTool.description.toLowerCase()).toMatch(/allow.?list|restrict|permit/i)
  })

  it("tool description mentions the tool executes commands within the allowlist", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const desc = bashTool.description.toLowerCase()
    expect(desc).toMatch(/execute|run/)
    expect(desc).toMatch(/allow.?list|available/)
  })

  it("tool description mentions rbash or equivalent restriction", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    expect(bashTool.description.toLowerCase()).toMatch(/rbash|restrict/i)
  })

  it("tool description does not leak implementation details", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const desc = bashTool.description.toLowerCase()
    // The agent should know what's available, not how it's configured
    expect(desc).not.toMatch(/bash-restricted\.jsonc/)
    expect(desc).not.toMatch(/pipe_to/)
  })

  it("tool description mentions max_lines/max_bytes instead of head/tail", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const desc = bashTool.description
    expect(desc).toMatch(/max_lines|max_bytes/)
  })

  it("tool description contains each allowed executable from the config", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const desc = bashTool.description.toLowerCase()
    expect(desc).toMatch(/ls/)
    expect(desc).toMatch(/echo/)
    expect(desc).toMatch(/cat/)
  })

  it("tool description lists pipe_to targets for executables with pipe restrictions", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const desc = bashTool.description.toLowerCase()
    // cat is configured with pipe_to: ["grep", "wc", "sort"]
    expect(desc).toMatch(/grep/)
    expect(desc).toMatch(/wc/)
    expect(desc).toMatch(/sort/)
  })

  it("tool description changes when the allowlist changes", async () => {
    const hooksDefault = await plugin(MOCK_PLUGIN_INPUT)
    const defaultDesc = hooksDefault.tool!.bash.description

    const minimalInput: PluginInput = {
      ...MOCK_PLUGIN_INPUT,
      directory: "/tmp/test-project-minimal",
      worktree: "/tmp/test-project-minimal",
    }
    const hooksMinimal = await plugin(minimalInput)
    const minimalDesc = hooksMinimal.tool!.bash.description

    // Minimal config has no "cat" — its description should differ
    expect(minimalDesc).not.toBe(defaultDesc)
    expect(minimalDesc.toLowerCase()).not.toMatch(/cat/)
    // But it should still list its own executables
    expect(minimalDesc.toLowerCase()).toMatch(/ls/)
    expect(minimalDesc.toLowerCase()).toMatch(/echo/)
  })
})

// ---------------------------------------------------------------------------
// Input schema validation
// ---------------------------------------------------------------------------

describe("plugin — input schema", () => {
  let bashArgs: z.ZodObject<any>

  beforeAll(async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    bashArgs = hooks.tool!.bash.args as z.ZodObject<any>
  })

  it("accepts a valid command", () => {
    const result = bashArgs.safeParse({ command: "ls -la" })
    expect(result.success).toBe(true)
  })

  it("rejects missing command", () => {
    const result = bashArgs.safeParse({})
    expect(result.success).toBe(false)
  })

  it("rejects empty command", () => {
    const result = bashArgs.safeParse({ command: "" })
    expect(result.success).toBe(false)
  })

  it("rejects non-string command", () => {
    const result = bashArgs.safeParse({ command: 123 })
    expect(result.success).toBe(false)
  })

  it("accepts command with all optional fields", () => {
    const result = bashArgs.safeParse({
      command: "git status",
      description: "Check git status",
      workdir: "./src",
      timeout: 60000,
      max_lines: 100,
      max_bytes: 10000,
    })
    expect(result.success).toBe(true)
  })

  it("accepts command with only command field", () => {
    const result = bashArgs.safeParse({ command: "echo hi" })
    expect(result.success).toBe(true)
  })

  it("accepts optional description field", () => {
    const result = bashArgs.safeParse({
      command: "ls -la",
      description: "List files with details",
    })
    expect(result.success).toBe(true)
  })

  it("accepts optional workdir field", () => {
    const result = bashArgs.safeParse({
      command: "ls",
      workdir: "/some/dir",
    })
    expect(result.success).toBe(true)
  })

  it("accepts optional container field as a string", () => {
    const result = bashArgs.safeParse({
      command: "ls -la",
      container: "my-container",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveProperty("container")
      expect(result.data.container).toBe("my-container")
    }
  })

  it("command without container parses successfully for backward compatibility", () => {
    const result = bashArgs.safeParse({ command: "ls" })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Input schema — timeout validation
// ---------------------------------------------------------------------------

describe("plugin — timeout validation", () => {
  let bashArgs: z.ZodObject<any>

  beforeAll(async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    bashArgs = hooks.tool!.bash.args as z.ZodObject<any>
  })

  it("rejects negative timeout", () => {
    const result = bashArgs.safeParse({ command: "echo", timeout: -1 })
    expect(result.success).toBe(false)
  })

  it("rejects zero timeout", () => {
    const result = bashArgs.safeParse({ command: "echo", timeout: 0 })
    expect(result.success).toBe(false)
  })

  it("rejects float timeout", () => {
    const result = bashArgs.safeParse({ command: "echo", timeout: 60.5 })
    expect(result.success).toBe(false)
  })

  it("rejects timeout over max (600000ms)", () => {
    const result = bashArgs.safeParse({ command: "echo", timeout: 600001 })
    expect(result.success).toBe(false)
  })

  it("accepts timeout exactly at max boundary", () => {
    const result = bashArgs.safeParse({ command: "echo", timeout: 600000 })
    expect(result.success).toBe(true)
  })

  it("accepts valid timeout values", () => {
    const result = bashArgs.safeParse({ command: "echo", timeout: 120000 })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Input schema — max_lines / max_bytes validation
// ---------------------------------------------------------------------------

describe("plugin — max_lines / max_bytes validation", () => {
  let bashArgs: z.ZodObject<any>

  beforeAll(async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    bashArgs = hooks.tool!.bash.args as z.ZodObject<any>
  })

  it("rejects negative max_lines", () => {
    const result = bashArgs.safeParse({ command: "echo", max_lines: -5 })
    expect(result.success).toBe(false)
  })

  it("rejects zero max_lines", () => {
    const result = bashArgs.safeParse({ command: "echo", max_lines: 0 })
    expect(result.success).toBe(false)
  })

  it("accepts positive max_lines", () => {
    const result = bashArgs.safeParse({ command: "echo", max_lines: 10 })
    expect(result.success).toBe(true)
  })

  it("rejects negative max_bytes", () => {
    const result = bashArgs.safeParse({ command: "echo", max_bytes: -100 })
    expect(result.success).toBe(false)
  })

  it("rejects zero max_bytes", () => {
    const result = bashArgs.safeParse({ command: "echo", max_bytes: 0 })
    expect(result.success).toBe(false)
  })

  it("rejects max_bytes over 10MB (10485760)", () => {
    const result = bashArgs.safeParse({ command: "echo", max_bytes: 10485761 })
    expect(result.success).toBe(false)
  })

  it("accepts max_bytes at 10MB boundary", () => {
    const result = bashArgs.safeParse({ command: "echo", max_bytes: 10485760 })
    expect(result.success).toBe(true)
  })

  it("accepts valid max_bytes", () => {
    const result = bashArgs.safeParse({ command: "echo", max_bytes: 1024 })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Execute integration
// ---------------------------------------------------------------------------

describe("plugin — execute function", () => {
  it("execute is called with parsed args and context", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const args = { command: "ls -la" }

    const context = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test-agent",
      directory: "/tmp/test-project",
      worktree: "/tmp/test-project",
      abort: new AbortController().signal,
      metadata: vi.fn(),
      ask: vi.fn(),
    }

    const result = await bashTool.execute(args, context)
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
  })

  it("execute returns output as string or ToolResult", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const context = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test-agent",
      directory: "/tmp/test-project",
      worktree: "/tmp/test-project",
      abort: new AbortController().signal,
      metadata: vi.fn(),
      ask: vi.fn(),
    }

    const result = await bashTool.execute({ command: "echo hello" }, context)
    if (typeof result === "string") {
      expect(result.length).toBeGreaterThan(0)
    } else {
      expect(result).toHaveProperty("output")
    }
  })

  it("execute handles commands with all optional params", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const context = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test-agent",
      directory: "/tmp/test-project",
      worktree: "/tmp/test-project",
      abort: new AbortController().signal,
      metadata: vi.fn(),
      ask: vi.fn(),
    }

    const result = await bashTool.execute(
      {
        command: "npm test",
        description: "Run tests",
        workdir: ".",
        timeout: 120000,
        max_lines: 500,
        max_bytes: 100000,
      },
      context
    )
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Container execution
// ---------------------------------------------------------------------------

describe("plugin — container execution", () => {
  it("rejects disallowed command even when container is specified", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const context = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test-agent",
      directory: "/tmp/test-project",
      worktree: "/tmp/test-project",
      abort: new AbortController().signal,
      metadata: vi.fn(),
      ask: vi.fn(),
    }

    const result = await bashTool.execute(
      { command: "nonexistent-cmd", container: "some-container" },
      context
    )
    expect(result).toBeDefined()
    if (typeof result !== "string") {
      // Should be rejected because nonexistent-cmd is not in allowlist
      expect(result.metadata?.rejected).toBe(true)
    }
  })

  it("execute returns a result when container is specified with an allowed command", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    const context = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test-agent",
      directory: "/tmp/test-project",
      worktree: "/tmp/test-project",
      abort: new AbortController().signal,
      metadata: vi.fn(),
      ask: vi.fn(),
    }

    const result = await bashTool.execute(
      { command: "echo hello", container: "test-container" },
      context
    )
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// run_script tool registration
// ---------------------------------------------------------------------------

describe("plugin — run_script tool", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-project-with-scripts"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        script_interpreters: ["python", "node", "deno"],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("registers a 'run_script' tool when script_interpreters is configured", async () => {
    const scriptsInput: PluginInput = {
      ...MOCK_PLUGIN_INPUT,
      directory: testDir,
      worktree: testDir,
    }
    const hooks = await plugin(scriptsInput)
    expect(hooks.tool).toHaveProperty("run_script")
  })

  it("run_script tool has a description string", async () => {
    const scriptsInput: PluginInput = {
      ...MOCK_PLUGIN_INPUT,
      directory: testDir,
      worktree: testDir,
    }
    const hooks = await plugin(scriptsInput)
    const scriptTool = hooks.tool!.run_script
    expect(typeof scriptTool.description).toBe("string")
    expect(scriptTool.description.length).toBeGreaterThan(0)
  })

  it("run_script description mentions script interpreters", async () => {
    const scriptsInput: PluginInput = {
      ...MOCK_PLUGIN_INPUT,
      directory: testDir,
      worktree: testDir,
    }
    const hooks = await plugin(scriptsInput)
    const desc = hooks.tool!.run_script.description.toLowerCase()
    expect(desc).toMatch(/python/)
    expect(desc).toMatch(/node/)
    expect(desc).toMatch(/deno/)
  })

  it("run_script tool has an execute function", async () => {
    const scriptsInput: PluginInput = {
      ...MOCK_PLUGIN_INPUT,
      directory: testDir,
      worktree: testDir,
    }
    const hooks = await plugin(scriptsInput)
    expect(typeof hooks.tool!.run_script.execute).toBe("function")
  })

  it("does not register run_script when script_interpreters is absent", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    // Default test-project fixture has no script_interpreters
    expect(hooks.tool).not.toHaveProperty("run_script")
  })

  it("run_script uses regular bash (not rbash) for script execution", async () => {
    // rbash restricts PATH to the symlink directory (only allowlist entries).
    // Regular bash uses the system PATH, so non-allowlisted system executables
    // are accessible. This test verifies that run_script uses regular bash.
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
    const { join } = require("node:path")

    const bashTestDir = "/tmp/test-project-run-script-bash"
    rmSync(bashTestDir, { recursive: true, force: true })
    mkdirSync(join(bashTestDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(bashTestDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        script_interpreters: ["bash"],
        settings: { timeout_ms: 60000, workdir_policy: "project" },
      }),
      "utf-8"
    )

    // Create a bash script that calls 'uname' — a system executable that is
    // NOT a bash builtin and NOT in the project allowlist.
    // Under rbash with restricted PATH, 'uname' won't be found (no symlink).
    // Under regular bash with system PATH, 'uname' will be found.
    const scriptPath = "/tmp/test-bash-nonallowlisted.sh"
    writeFileSync(scriptPath, "#!/bin/bash\nuname -r\n", "utf-8")

    try {
      const hooks = await plugin({
        ...MOCK_PLUGIN_INPUT,
        directory: bashTestDir,
        worktree: bashTestDir,
      })
      const scriptTool = hooks.tool!.run_script
      const context = {
        sessionID: "test-session",
        messageID: "test-msg",
        agent: "test-agent",
        directory: bashTestDir,
        worktree: bashTestDir,
        abort: new AbortController().signal,
        metadata: vi.fn(),
        ask: vi.fn(),
      }

      const result = await scriptTool.execute(
        { command: `bash ${scriptPath}` },
        context
      )

      expect(result).toBeDefined()
      if (typeof result !== "string") {
        // rbash+restricted PATH → 'uname' not found → exit code != 0
        // regular bash+system PATH → 'uname' found → exit code === 0
        expect(result.exitCode).toBe(0)
      }
    } finally {
      rmSync(bashTestDir, { recursive: true, force: true })
      rmSync(scriptPath, { force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Write lock — locked scripts protection
// ---------------------------------------------------------------------------

describe("plugin — write lock for locked scripts", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-project-locked-scripts"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    mkdirSync(join(testDir, "scripts"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {}, python3: {} },
        script_interpreters: ["python3"],
        locked_scripts: ["scripts/deploy.py", "scripts/build.sh"],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const lockedInput: PluginInput = {
    ...MOCK_PLUGIN_INPUT,
    directory: testDir,
    worktree: testDir,
  }

  it("registers a tool.execute.before hook when locked_scripts is configured", async () => {
    // The plugin must register tool.execute.before when locked_scripts is present
    const hooks = await plugin(lockedInput)
    expect(hooks["tool.execute.before"]).toBeDefined()
  })

  it("registers a tool.execute.before hook even when locked_scripts is absent", async () => {
    // The hook is always registered because the plugin also protects
    // user-writable symlink targets discovered at runtime
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    expect(hooks["tool.execute.before"]).toBeDefined()
  })

  it("tool.execute.before blocks write to a locked script path", async () => {
    // When write targets a path listed in locked_scripts, the hook must throw
    const hooks = await plugin(lockedInput)
    const beforeHook = hooks["tool.execute.before"]!

    const lockedPath = join(testDir, "scripts/deploy.py")
    await expect(
      beforeHook(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { filePath: lockedPath } }
      )
    ).rejects.toThrow(/locked|cannot write|protected|blocked/i)
  })

  it("tool.execute.before does not block write to a non-locked path", async () => {
    // Writes to paths not in locked_scripts must proceed normally
    const hooks = await plugin(lockedInput)
    const beforeHook = hooks["tool.execute.before"]!

    const unlockedPath = join(testDir, "unlocked_file.txt")
    await expect(
      beforeHook(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { filePath: unlockedPath } }
      )
    ).resolves.toBeUndefined()
  })

  it("tool.execute.before does not block non-write tools", async () => {
    // Non-write tools (e.g. bash) must not be intercepted
    const hooks = await plugin(lockedInput)
    const beforeHook = hooks["tool.execute.before"]!

    await expect(
      beforeHook(
        { tool: "bash", sessionID: "s1", callID: "c1" },
        { args: { command: "echo hello" } }
      )
    ).resolves.toBeUndefined()
  })
})
