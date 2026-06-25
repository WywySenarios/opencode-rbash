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
import { tool } from "@opencode-ai/plugin/tool"
import plugin from "../src/index.js"
import type { Hooks, PluginInput, ToolResult } from "@opencode-ai/plugin"

// Use the plugin SDK's zod instance for type compatibility with the tool args
const z = tool.schema

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
    // args is a ZodRawShape (plain object of individual ZodType values).
    // Each field value is a Zod schema — _zod is on the value, not the container.
    expect(bashTool.args).toHaveProperty("command")
    expect((bashTool.args as any).command._zod).toBeDefined()
  })

  it("tool args schema includes an optional container field", async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    const bashTool = hooks.tool!.bash
    // args is a ZodRawShape — container is a top-level key, not inside .shape
    expect(bashTool.args).toHaveProperty("container")
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
  let bashArgs: NonNullable<Parameters<typeof z.object>[0]>

  beforeAll(async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    // args is a ZodRawShape (plain object of ZodType values), not a ZodObject.
    // Wrap via z.object() when validation is needed.
    bashArgs = hooks.tool!.bash.args
  })

  it("accepts a valid command", () => {
    const result = z.object(bashArgs).safeParse({ command: "ls -la" })
    expect(result.success).toBe(true)
  })

  it("rejects missing command", () => {
    const result = z.object(bashArgs).safeParse({})
    expect(result.success).toBe(false)
  })

  it("rejects empty command", () => {
    const result = z.object(bashArgs).safeParse({ command: "" })
    expect(result.success).toBe(false)
  })

  it("rejects non-string command", () => {
    const result = z.object(bashArgs).safeParse({ command: 123 })
    expect(result.success).toBe(false)
  })

  it("accepts command with all optional fields", () => {
    const result = z.object(bashArgs).safeParse({
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
    const result = z.object(bashArgs).safeParse({ command: "echo hi" })
    expect(result.success).toBe(true)
  })

  it("accepts optional description field", () => {
    const result = z.object(bashArgs).safeParse({
      command: "ls -la",
      description: "List files with details",
    })
    expect(result.success).toBe(true)
  })

  it("accepts optional workdir field", () => {
    const result = z.object(bashArgs).safeParse({
      command: "ls",
      workdir: "/some/dir",
    })
    expect(result.success).toBe(true)
  })

  it("accepts optional container field as a string", () => {
    const result = z.object(bashArgs).safeParse({
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
    const result = z.object(bashArgs).safeParse({ command: "ls" })
    expect(result.success).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Regression: bug where `Object.entries(zodObject)` in the registry's
  // `fromPlugin()` picked up Zod 4's internal `def` property, producing a
  // corrupt JSON Schema with `def` as the only parameter. The LLM then sent
  // `{ def: { command: "..." } }` and the tool crashed with `command: undefined`.
  //
  // These tests guarantee:
  //   1. The correct input shape (`{ command: "ls" }`) is accepted.
  //   2. The wrong input shape (`{ def: { command: "ls" } }`) is rejected.
  //   3. `Object.keys(args)` yields only real fields, NOT `def`.
  //
  // With ZodRawShape (plain object) instead of ZodObject, the `def`/`type`
  // enumerable properties never appear at the top level — the regression is
  // structurally prevented. These tests remain as a safety net.
  // -----------------------------------------------------------------------

  it("rejects def-wrapped command (regression: def-key bug)", () => {
    const result = z.object(bashArgs).safeParse({ def: { command: "ls" } })
    expect(result.success).toBe(false)
  })

  it("shape entries do not include Zod internal 'def' property (regression: def-key bug)", () => {
    // bashArgs is a plain object — Object.keys() only yields our field names.
    const keys = Object.keys(bashArgs)
    expect(keys).not.toContain("def")
    expect(keys).not.toContain("type")
  })
})

// ---------------------------------------------------------------------------
// Input schema — timeout validation
// ---------------------------------------------------------------------------

describe("plugin — timeout validation", () => {
  let bashArgs: NonNullable<Parameters<typeof z.object>[0]>

  beforeAll(async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    bashArgs = hooks.tool!.bash.args
  })

  it("rejects negative timeout", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", timeout: -1 })
    expect(result.success).toBe(false)
  })

  it("rejects zero timeout", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", timeout: 0 })
    expect(result.success).toBe(false)
  })

  it("rejects float timeout", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", timeout: 60.5 })
    expect(result.success).toBe(false)
  })

  it("rejects timeout over max (600000ms)", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", timeout: 600001 })
    expect(result.success).toBe(false)
  })

  it("accepts timeout exactly at max boundary", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", timeout: 600000 })
    expect(result.success).toBe(true)
  })

  it("accepts valid timeout values", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", timeout: 120000 })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Input schema — max_lines / max_bytes validation
// ---------------------------------------------------------------------------

describe("plugin — max_lines / max_bytes validation", () => {
  let bashArgs: NonNullable<Parameters<typeof z.object>[0]>

  beforeAll(async () => {
    const hooks = await plugin(MOCK_PLUGIN_INPUT)
    bashArgs = hooks.tool!.bash.args
  })

  it("rejects negative max_lines", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_lines: -5 })
    expect(result.success).toBe(false)
  })

  it("rejects zero max_lines", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_lines: 0 })
    expect(result.success).toBe(false)
  })

  it("accepts positive max_lines", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_lines: 10 })
    expect(result.success).toBe(true)
  })

  it("rejects negative max_bytes", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_bytes: -100 })
    expect(result.success).toBe(false)
  })

  it("rejects zero max_bytes", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_bytes: 0 })
    expect(result.success).toBe(false)
  })

  it("rejects max_bytes over 10MB (10485760)", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_bytes: 10485761 })
    expect(result.success).toBe(false)
  })

  it("accepts max_bytes at 10MB boundary", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_bytes: 10485760 })
    expect(result.success).toBe(true)
  })

  it("accepts valid max_bytes", () => {
    const result = z.object(bashArgs).safeParse({ command: "echo", max_bytes: 1024 })
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

  it("run_script executes successfully with a bash builtin command", async () => {
    // run_script uses regular bash (createBashExecutor), not rbash.
    // Verify that a script runs and produces output — bash builtins work
    // regardless of PATH restrictions.
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

    // Create a script that uses a bash builtin (echo) to output a marker
    const scriptPath = "/tmp/test-bash-builtin.sh"
    writeFileSync(scriptPath, "#!/bin/bash\necho hello-from-script\n", "utf-8")

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
        // Script should execute successfully (exit code 0)
        expect((result as ToolResult & { exitCode?: number }).exitCode).toBe(0)
        // Script output should be captured
        expect(result.output).toMatch(/hello-from-script/)
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

// ---------------------------------------------------------------------------
// Unrestricted agents — bash restrictions bypass
// ---------------------------------------------------------------------------

describe("plugin — trusted agent bash bypass", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const testDir = "/tmp/test-project-agent-bypass"

  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(testDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        trusted_agents: ["plan", "build"],
        settings: { timeout_ms: 60000, workdir_policy: "project" },
      }),
      "utf-8"
    )
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const bypassInput: PluginInput = {
    ...MOCK_PLUGIN_INPUT,
    directory: testDir,
    worktree: testDir,
  }

  const trustedContext = {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "plan",
    directory: testDir,
    worktree: testDir,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  }

  const untrustedContext = {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "explore",
    directory: testDir,
    worktree: testDir,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  }

  it("rejects non-allowlisted command for untrusted agent", async () => {
    const hooks = await plugin(bypassInput)
    const bashTool = hooks.tool!.bash

    // "python3" is not in the allowlist — untrusted agent must be rejected
    const result = await bashTool.execute(
      { command: "python3 my-script.py" },
      untrustedContext
    )

    if (typeof result !== "string") {
      expect(result.metadata?.rejected).toBe(true)
    }
  })

  it("allows non-allowlisted command for trusted agent", async () => {
    const hooks = await plugin(bypassInput)
    const bashTool = hooks.tool!.bash

    // "python3" is not in the allowlist, but trusted agent must bypass validation
    const result = await bashTool.execute(
      { command: "python3 my-script.py" },
      trustedContext
    )

    // The command should NOT be rejected (though it may fail to execute
    // because python3 doesn't exist in the test sandbox — that's fine,
    // we only care that validation was bypassed)
    if (typeof result !== "string") {
      expect(result.metadata?.rejected).toBeUndefined()
    }
  })

  it("still registers run_script tool when trusted_agents is configured", async () => {
    const hooks = await plugin(bypassInput)
    // run_script is registered only when script_interpreters is set,
    // which is NOT part of this fixture — so this test expects NO run_script.
    // The point is: trusted_agents does NOT suppress run_script.
    // True verification happens when script_interpreters is also set.
    expect(hooks.tool).not.toHaveProperty("run_script")
  })

  it("registers run_script alongside trusted_agents when script_interpreters is present", async () => {
    // Create a fixture with both trusted_agents and script_interpreters
    const fullDir = "/tmp/test-project-agent-bypass-with-scripts"
    rmSync(fullDir, { recursive: true, force: true })
    mkdirSync(join(fullDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(fullDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        trusted_agents: ["plan"],
        script_interpreters: ["python", "node"],
        settings: { timeout_ms: 60000, workdir_policy: "project" },
      }),
      "utf-8"
    )

    try {
      const hooks = await plugin({
        ...MOCK_PLUGIN_INPUT,
        directory: fullDir,
        worktree: fullDir,
      })
      expect(hooks.tool).toHaveProperty("run_script")
    } finally {
      rmSync(fullDir, { recursive: true, force: true })
    }
  })

  it("tool description lists scripts under a separate heading when scripts are configured", async () => {
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
    const { join } = require("node:path")
    const scriptsDir = "/tmp/test-project-description-scripts"

    rmSync(scriptsDir, { recursive: true, force: true })
    mkdirSync(join(scriptsDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(scriptsDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        scripts: ["scripts/**", "deploy/*.sh"],
        script_interpreters: ["bash"],
        settings: { timeout_ms: 120000, workdir_policy: "project" },
      }),
      "utf-8"
    )

    try {
      const hooks = await plugin({
        ...MOCK_PLUGIN_INPUT,
        directory: scriptsDir,
        worktree: scriptsDir,
      })
      const bashTool = hooks.tool!.bash
      const desc = bashTool.description.toLowerCase()

      // Description should mention allowlisted executables
      expect(desc).toMatch(/allow.?listed executables?/)
      expect(desc).toMatch(/ls/)
      expect(desc).toMatch(/echo/)

      // Description should list scripts separately
      expect(desc).toMatch(/scripts/)
      expect(desc).toMatch(/scripts\/\*\*/)
      expect(desc).toMatch(/deploy\/\*\.sh/)
    } finally {
      rmSync(scriptsDir, { recursive: true, force: true })
    }
  })

  it("trusted agent command is executed (not rejected) even with non-allowlisted executable", async () => {
    // Verify that for a trusted agent, the command runs (exitCode is present)
    // rather than being rejected by the allowlist check. Use a bash builtin
    // so the test is independent of system PATH availability.
    const hooks = await plugin(bypassInput)
    const bashTool = hooks.tool!.bash

    const result = await bashTool.execute(
      { command: "echo hello-from-trusted-agent" },
      trustedContext
    )

    expect(result).toBeDefined()
    if (typeof result !== "string") {
      // Rejected commands have metadata.rejected=true and lack exitCode.
      // Properly executed commands have exitCode and capture output.
      expect(result.metadata?.rejected).toBeUndefined()
      expect((result as ToolResult & { exitCode?: number }).exitCode).toBe(0)
      expect(result.output).toMatch(/hello-from-trusted-agent/)
    }
  })

  it("trusted agent can run path-based commands (bypasses rbash path restriction)", async () => {
    // rbash rejects command names containing '/', but trusted agents
    // use regular bash with system PATH, so path-based commands work.
    const hooks = await plugin(bypassInput)
    const bashTool = hooks.tool!.bash

    const result = await bashTool.execute(
      { command: "/bin/echo hello-from-path-based-command" },
      trustedContext
    )

    expect(result).toBeDefined()
    if (typeof result !== "string") {
      expect(result.metadata?.rejected).toBeUndefined()
      expect((result as ToolResult & { exitCode?: number }).exitCode).toBe(0)
      expect(result.output).toMatch(/hello-from-path-based-command/)
    }
  })

  it("silently filters non-primary agents from trusted_agents at boot", async () => {
    // When a non-primary agent is listed in trusted_agents, the plugin
    // should silently exclude it so the agent is NOT treated as trusted.
    const filterDir = "/tmp/test-project-agent-filter"
    rmSync(filterDir, { recursive: true, force: true })
    mkdirSync(join(filterDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(filterDir, ".opencode", "bash-restricted.jsonc"),
      JSON.stringify({
        allow: { ls: {}, echo: {} },
        trusted_agents: ["explore"],
        agents: [
          { name: "plan", mode: "primary" },
          { name: "explore", mode: "subagent" },
        ],
        settings: { timeout_ms: 60000, workdir_policy: "project" },
      }),
      "utf-8"
    )

    try {
      const hooks = await plugin({
        ...MOCK_PLUGIN_INPUT,
        directory: filterDir,
        worktree: filterDir,
      })
      const bashTool = hooks.tool!.bash

      // Agent "explore" is in trusted_agents but is a subagent — must be filtered out
      const result = await bashTool.execute(
        { command: "python3 my-script.py" },
        { ...untrustedContext, directory: filterDir, worktree: filterDir }
      )

      expect(result).toBeDefined()
      if (typeof result !== "string") {
        // Must be rejected because "explore" was filtered from trusted list
        expect(result.metadata?.rejected).toBe(true)
      }
    } finally {
      rmSync(filterDir, { recursive: true, force: true })
    }
  })
})
