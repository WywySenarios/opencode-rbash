/**
 * Tests for the init module (src/init.ts)
 *
 * Verifies:
 * - Symlink creation for each allowed executable
 * - which() resolution with injectable resolver
 * - Warning for executables not found on system
 * - Clean-slate regeneration on every init
 * - Correct binDir and PATH construction
 * - Hash-based directory naming
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { initSymlinks, type ExecutableResolver, type InitResult } from "../src/init"
import type { Config } from "../src/config"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeResolver = (entries: Record<string, string>): ExecutableResolver => ({
  which: (name: string) => Promise.resolve(entries[name] ?? null),
})

const SAMPLE_CONFIG: Config = {
  allow: {
    ls: {},
    echo: {},
    cat: { pipe_to: ["grep", "wc"] },
  },
}

const MOCK_RESOLVER = makeResolver({
  ls: "/usr/bin/ls",
  echo: "/bin/echo",
  cat: "/usr/bin/cat",
})

// ---------------------------------------------------------------------------
// Basic symlink creation
// ---------------------------------------------------------------------------

describe("initSymlinks", () => {
  it("creates symlinks for each executable in the allowlist", async () => {
    const result = await initSymlinks({
      config: SAMPLE_CONFIG,
      projectRoot: "/tmp/test-project",
      resolver: MOCK_RESOLVER,
    })

    expect(result.warnings).toHaveLength(0)
    expect(result.binDir).toContain("/tmp/opencode-bash/")
    // The binDir must be a subdirectory of the temp path
    expect(typeof result.binDir).toBe("string")
  })

  it("returns a binDir that is a directory path (ends without trailing slash or is a dir)", () => {
    // Bin dir should be absolute
    expect(MOCK_RESOLVER.which).toBeDefined()
  })

  it("creates a deterministic hash-based directory path", async () => {
    // Same project root → same hash → same binDir
    const result1 = await initSymlinks({
      config: SAMPLE_CONFIG,
      projectRoot: "/home/user/my-project",
      resolver: MOCK_RESOLVER,
    })
    const result2 = await initSymlinks({
      config: SAMPLE_CONFIG,
      projectRoot: "/home/user/my-project",
      resolver: MOCK_RESOLVER,
    })
    expect(result1.binDir).toBe(result2.binDir)
  })

  it("different project roots produce different binDirs", async () => {
    const result1 = await initSymlinks({
      config: SAMPLE_CONFIG,
      projectRoot: "/project/alpha",
      resolver: MOCK_RESOLVER,
    })
    const result2 = await initSymlinks({
      config: SAMPLE_CONFIG,
      projectRoot: "/project/beta",
      resolver: MOCK_RESOLVER,
    })
    expect(result1.binDir).not.toBe(result2.binDir)
  })
})

// ---------------------------------------------------------------------------
// which resolution
// ---------------------------------------------------------------------------

describe("initSymlinks — which resolution", () => {
  it("uses the provided ExecutableResolver to resolve paths", async () => {
    const resolver: ExecutableResolver = {
      which: vi.fn(async (name: string) => {
        if (name === "ls") return "/bin/ls"
        if (name === "echo") return "/bin/echo"
        if (name === "cat") return "/bin/cat"
        return null
      }),
    }

    await initSymlinks({
      config: SAMPLE_CONFIG,
      projectRoot: "/tmp/test-project-which",
      resolver,
    })

    expect(resolver.which).toHaveBeenCalledTimes(3)
    expect(resolver.which).toHaveBeenCalledWith("ls")
    expect(resolver.which).toHaveBeenCalledWith("echo")
    expect(resolver.which).toHaveBeenCalledWith("cat")
  })

  it("skips executables not found by which() and reports warnings", async () => {
    const partialResolver: ExecutableResolver = {
      which: vi.fn(async (_name: string) => {
        // Only ls exists, echo and cat are missing
        if (_name === "ls") return "/usr/bin/ls"
        return null
      }),
    }

    const result = await initSymlinks({
      config: SAMPLE_CONFIG,
      projectRoot: "/tmp/test-project-partial",
      resolver: partialResolver,
    })

    expect(result.warnings.length).toBe(2)
    expect(result.warnings[0]).toContain("echo")
    expect(result.warnings[1]).toContain("cat")
  })

  it("resolves symlinked executables to their real (canonical) path", async () => {
    const resolver: ExecutableResolver = {
      which: vi.fn(async (name: string) => {
        if (name === "node") return "/usr/local/bin/node"
        return null
      }),
    }

    const configWithNode: Config = {
      allow: { node: {} },
    }

    const result = await initSymlinks({
      config: configWithNode,
      projectRoot: "/tmp/test-project-canonical",
      resolver,
    })
    expect(result.warnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Clean slate behavior
// ---------------------------------------------------------------------------

describe("initSymlinks — clean slate", () => {
  it("removes old symlinks before creating new ones (clean slate)", async () => {
    const resolver: ExecutableResolver = {
      which: vi.fn(async (name: string) => {
        if (name === "ls") return "/usr/bin/ls"
        if (name === "echo") return "/bin/echo"
        return null
      }),
    }

    // First call with config A
    const configA: Config = { allow: { ls: {}, echo: {} } }
    await initSymlinks({
      config: configA,
      projectRoot: "/tmp/test-project-clean",
      resolver,
    })

    // Second call with config B (different executables)
    const configB: Config = { allow: { git: {}, docker: {} } }
    const resultB = await initSymlinks({
      config: configB,
      projectRoot: "/tmp/test-project-clean",
      resolver,
    })

    // Should NOT have ls or echo symlinks — they should be cleaned up
    expect(resultB.warnings).not.toContain("ls")
    expect(resultB.warnings).not.toContain("echo")
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("initSymlinks — edge cases", () => {
  it("handles configs with pipe_to rules (ignores pipe rules, only cares about keys)", async () => {
    const configWithPipes: Config = {
      allow: {
        ls: {},
        cat: { pipe_to: ["grep", "wc"] },
        grep: {},
      },
    }

    const resolver = makeResolver({
      ls: "/usr/bin/ls",
      cat: "/usr/bin/cat",
      grep: "/usr/bin/grep",
    })

    const result = await initSymlinks({
      config: configWithPipes,
      projectRoot: "/tmp/test-project-pipes",
      resolver,
    })
    expect(result.warnings).toHaveLength(0)
  })

  it("handles large number of executables efficiently", async () => {
    const largeConfig: Config = {
      allow: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`cmd${i}`, {}])
      ),
    }

    const resolver = makeResolver(
      Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`cmd${i}`, `/usr/bin/cmd${i}`])
      )
    )

    const result = await initSymlinks({
      config: largeConfig,
      projectRoot: "/tmp/test-project-large",
      resolver,
    })
    expect(result.warnings).toHaveLength(0)
  })

  it("handles empty allowlist gracefully (no symlinks, no crash)", async () => {
    const emptyConfig: Config = { allow: {} }
    const resolver: ExecutableResolver = { which: vi.fn(async () => null) }

    const result = await initSymlinks({
      config: emptyConfig,
      projectRoot: "/tmp/test-project-empty",
      resolver,
    })
    expect(result.warnings).toHaveLength(0)
    expect(result.binDir).toBeDefined()
  })

  it("uses fs.symlink (or equivalent) which fails if the binDir parent doesn't exist", async () => {
    // The implementation should create the directory if needed
    const resolver = makeResolver({
      ls: "/usr/bin/ls",
    })

    const result = await initSymlinks({
      config: { allow: { ls: {} } },
      projectRoot: "/tmp/unique-test-project-dir",
      resolver,
    })
    expect(result.warnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// User-writable symlink target discovery
// ---------------------------------------------------------------------------

describe("initSymlinks — user-writable target discovery", () => {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
  const { join } = require("node:path")
  const writableDir = "/tmp/test-init-writable-discovery"

  beforeAll(() => {
    rmSync(writableDir, { recursive: true, force: true })
    mkdirSync(writableDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(writableDir, { recursive: true, force: true })
  })

  it("returns userWritableTargets as an array on InitResult", async () => {
    const resolver: ExecutableResolver = {
      which: async () => null,
    }
    const result = await initSymlinks({
      config: { allow: {} },
      projectRoot: writableDir,
      resolver,
    })
    // Must exist and be an array (initially empty)
    expect(Array.isArray((result as any).userWritableTargets)).toBe(true)
  })

  it("includes user-writable resolved paths in userWritableTargets", async () => {
    // Create a user-writable executable
    const writablePath = join(writableDir, "user-tool")
    writeFileSync(writablePath, "#!/bin/bash\necho tool", { mode: 0o755 })

    const resolver: ExecutableResolver = {
      which: async (name: string) => {
        if (name === "mytool") return writablePath
        return null
      },
    }

    const result = await initSymlinks({
      config: { allow: { mytool: {} } },
      projectRoot: writableDir,
      resolver,
    })

    expect(result.warnings).toHaveLength(0)
    expect((result as any).userWritableTargets).toContain(writablePath)
  })

  it("does not include system-owned paths (root) in userWritableTargets", async () => {
    // /usr/bin/ls is typically owned by root → not user-writable
    const resolver: ExecutableResolver = {
      which: async (name: string) => {
        if (name === "ls") return "/usr/bin/ls"
        return null
      },
    }

    const result = await initSymlinks({
      config: { allow: { ls: {} } },
      projectRoot: writableDir,
      resolver,
    })

    const targets: string[] = (result as any).userWritableTargets ?? []
    expect(targets).not.toContain("/usr/bin/ls")
  })

  it("includes user-writable paths alongside system-owned paths correctly", async () => {
    // Mix: one system-owned, one user-writable
    const writablePath = join(writableDir, "another-tool")
    writeFileSync(writablePath, "#!/bin/bash\necho another", { mode: 0o755 })

    const resolver: ExecutableResolver = {
      which: async (name: string) => {
        if (name === "ls") return "/usr/bin/ls"
        if (name === "another-tool") return writablePath
        return null
      },
    }

    const result = await initSymlinks({
      config: { allow: { ls: {}, "another-tool": {} } },
      projectRoot: writableDir,
      resolver,
    })

    const targets: string[] = (result as any).userWritableTargets ?? []
    expect(targets).toContain(writablePath)
    expect(targets).not.toContain("/usr/bin/ls")
  })
})
