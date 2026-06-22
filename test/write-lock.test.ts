/**
 * Tests for the write-lock helper (src/write-lock.ts)
 *
 * Verifies:
 * - createWriteLock returns empty object when no paths are locked
 * - createWriteLock returns a tool.execute.before hook when paths are locked
 * - The hook blocks write tool calls to locked paths
 * - The hook allows write tool calls to non-locked paths
 * - The hook allows non-write tools regardless of path
 * - Path resolution is relative to projectRoot
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { resolve } from "node:path"

// The helper — will fail to import until implemented
import { createWriteLock } from "../src/write-lock.js"
import { initSymlinks, type ExecutableResolver } from "../src/init"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/tmp/test-project"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWriteLock", () => {
  describe("with no locked paths", () => {
    const result = createWriteLock({ projectRoot: PROJECT_ROOT, lockedPaths: [] })

    it("returns an empty object", () => {
      expect(result).toEqual({})
    })
  })

  describe("with locked paths", () => {
    const result = createWriteLock({
      projectRoot: PROJECT_ROOT,
      lockedPaths: ["scripts/deploy.py", "scripts/build.sh"],
    })
    const handler = result["tool.execute.before"]

    it("returns a tool.execute.before hook", () => {
      expect(handler).toBeDefined()
      expect(typeof handler).toBe("function")
    })

    it("blocks write to a locked path", async () => {
      await expect(
        handler!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { filePath: resolve(PROJECT_ROOT, "scripts/deploy.py") } },
        ),
      ).rejects.toThrow(/locked|cannot write|protected|blocked/i)
    })

    it("blocks write to another locked path", async () => {
      await expect(
        handler!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { filePath: resolve(PROJECT_ROOT, "scripts/build.sh") } },
        ),
      ).rejects.toThrow(/locked|cannot write|protected|blocked/i)
    })

    it("allows write to a non-locked path", async () => {
      await expect(
        handler!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { filePath: resolve(PROJECT_ROOT, "unlocked_file.txt") } },
        ),
      ).resolves.toBeUndefined()
    })

    it("allows write to a path that partially matches a locked name", async () => {
      await expect(
        handler!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { filePath: resolve(PROJECT_ROOT, "scripts/deploy.py.bak") } },
        ),
      ).resolves.toBeUndefined()
    })

    it("allows non-write tools", async () => {
      await expect(
        handler!(
          { tool: "bash", sessionID: "s1", callID: "c1" },
          { args: { command: "echo hello" } },
        ),
      ).resolves.toBeUndefined()
    })

    it("silently skips when filePath is not a string", async () => {
      await expect(
        handler!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { filePath: undefined } },
        ),
      ).resolves.toBeUndefined()
    })

    it("silently skips when filePath is absent", async () => {
      await expect(
        handler!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: {} },
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe("integration with initSymlinks — discovered user-writable targets", () => {
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs")
    const { join } = require("node:path")
    const tmpDir = "/tmp/test-write-lock-discovered"

    beforeAll(() => {
      rmSync(tmpDir, { recursive: true, force: true })
      mkdirSync(tmpDir, { recursive: true })
    })

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it("blocks write to a path discovered as user-writable by initSymlinks", async () => {
      // Create a user-writable executable
      const userToolPath = join(tmpDir, "my-script")
      writeFileSync(userToolPath, "#!/bin/bash\necho real", { mode: 0o755 })

      const resolver: ExecutableResolver = {
        which: async (name: string) => {
          if (name === "myscript") return userToolPath
          return null
        },
      }

      // initSymlinks discovers that my-script's target is user-writable
      const initResult = await initSymlinks({
        config: { allow: { myscript: {} } },
        projectRoot: tmpDir,
        resolver,
      })

      const discoveredPaths: string[] = (initResult as any).userWritableTargets ?? []
      expect(discoveredPaths).toContain(userToolPath)

      // Feed the discovered paths into the write-lock helper
      const hook = createWriteLock({
        projectRoot: tmpDir,
        lockedPaths: discoveredPaths,
      })["tool.execute.before"]!

      // The hook must block writes to the user-writable target
      await expect(
        hook(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { filePath: userToolPath } },
        ),
      ).rejects.toThrow(/locked|cannot write|protected|blocked/i)
    })

    it("creates a hook with no locked paths when no user-writable targets exist", async () => {
      const resolver: ExecutableResolver = {
        which: async (name: string) => {
          if (name === "ls") return "/usr/bin/ls"
          return null
        },
      }

      const initResult = await initSymlinks({
        config: { allow: { ls: {} } },
        projectRoot: tmpDir,
        resolver,
      })

      const discoveredPaths: string[] = (initResult as any).userWritableTargets ?? []
      expect(discoveredPaths).not.toContain("/usr/bin/ls")

      const result = createWriteLock({
        projectRoot: tmpDir,
        lockedPaths: discoveredPaths,
      })

      // No locked paths → no hook → empty object
      expect(result).toEqual({})
    })
  })
})
