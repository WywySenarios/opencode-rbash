/**
 * Tests for agent authorisation module (src/agent-auth.ts).
 *
 * Verifies:
 * - Boot-time filtering: non-primary agents are silently excluded from the
 *   trusted agents list (no panic, no plugin crash)
 * - Unknown agent names are silently excluded
 * - Runtime trust check: isTrustedAgent returns true only for agents in
 *   the trusted list, false for all others
 * - Edge cases: empty list, case sensitivity, undefined inputs
 */

import { describe, it, expect } from "vitest"
import {
  filterTrustedAgents,
  isTrustedAgent,
  type AgentDescriptor,
} from "../src/agent-auth"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRIMARY_AGENTS: AgentDescriptor[] = [
  { name: "plan", mode: "primary" },
  { name: "build", mode: "primary" },
]

const MIXED_AGENTS: AgentDescriptor[] = [
  { name: "plan", mode: "primary" },
  { name: "explore", mode: "subagent" },
  { name: "general", mode: "all" },
]

// ---------------------------------------------------------------------------
// filterTrustedAgents — boot-time agent filtering
// ---------------------------------------------------------------------------

describe("filterTrustedAgents", () => {
  it("returns all names when all configured agents have mode 'primary'", () => {
    const result = filterTrustedAgents(["plan", "build"], PRIMARY_AGENTS)
    expect(result).toEqual(["plan", "build"])
  })

  it("silently excludes a 'subagent' from the result", () => {
    const result = filterTrustedAgents(["explore"], MIXED_AGENTS)
    expect(result).toEqual([])
  })

  it("silently excludes an 'all' mode agent from the result", () => {
    const result = filterTrustedAgents(["general"], MIXED_AGENTS)
    expect(result).toEqual([])
  })

  it("silently excludes an unknown agent name", () => {
    const result = filterTrustedAgents(["nonexistent-agent"], PRIMARY_AGENTS)
    expect(result).toEqual([])
  })

  it("returns only primary agents when list is mixed", () => {
    const result = filterTrustedAgents(["plan", "explore", "general"], MIXED_AGENTS)
    expect(result).toEqual(["plan"])
  })

  it("returns empty array when input list is empty", () => {
    const result = filterTrustedAgents([], PRIMARY_AGENTS)
    expect(result).toEqual([])
  })

  it("does not throw for non-primary agents", () => {
    expect(() => filterTrustedAgents(["explore"], MIXED_AGENTS)).not.toThrow()
  })

  it("does not throw for unknown agents", () => {
    expect(() => filterTrustedAgents(["unknown"], PRIMARY_AGENTS)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// isTrustedAgent — runtime trust check
// ---------------------------------------------------------------------------

describe("isTrustedAgent", () => {
  it("returns true when agent is in the trusted list", () => {
    expect(isTrustedAgent("plan", ["plan", "build"])).toBe(true)
  })

  it("returns true for any agent in a multi-entry trusted list", () => {
    expect(isTrustedAgent("build", ["plan", "build"])).toBe(true)
  })

  it("returns false when agent is not in the trusted list", () => {
    expect(isTrustedAgent("explore", ["plan", "build"])).toBe(false)
  })

  it("returns false when trusted list is empty", () => {
    expect(isTrustedAgent("plan", [])).toBe(false)
  })

  it("is case-sensitive", () => {
    expect(isTrustedAgent("Plan", ["plan"])).toBe(false)
  })

  it("returns false for undefined agent name", () => {
    expect(isTrustedAgent(undefined as unknown as string, ["plan"])).toBe(false)
  })

  it("returns false when trusted list is undefined", () => {
    expect(isTrustedAgent("plan", undefined as unknown as string[])).toBe(false)
  })
})
