/**
 * Agent authorisation for the restricted bash tool.
 *
 * Provides boot-time filtering and runtime trust checks:
 * - Boot-time: silently excludes non-primary agents from the trusted list
 * - Runtime: checks if a given agent name is in the trusted list
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentDescriptor = {
  name: string
  mode: "primary" | "subagent" | "all"
}

// ---------------------------------------------------------------------------
// Boot-time filtering
// ---------------------------------------------------------------------------

/**
 * Filters the configured trusted agent names to only those that correspond
 * to agents with mode `"primary"`. Non-primary and unknown agent names are
 * silently excluded — no error is thrown.
 *
 * Call this once at plugin boot to resolve the effective trusted agents list.
 *
 * @param configuredNames - Agent names listed in the `trusted_agents` config
 * @param agents           - All configured agents with their modes
 * @returns The subset of `configuredNames` whose agents have mode "primary"
 */
export function filterTrustedAgents(
  configuredNames: string[],
  agents: AgentDescriptor[]
): string[] {
  return configuredNames.filter((name) => {
    const agent = agents.find((a) => a.name === name)
    return agent !== undefined && agent.mode === "primary"
  })
}

// ---------------------------------------------------------------------------
// Runtime trust check
// ---------------------------------------------------------------------------

/**
 * Determines whether a given agent name is trusted to bypass bash restrictions.
 *
 * This is a simple membership check against the trusted agents list.
 *
 * @param agentName    - The name of the calling agent (from ToolContext)
 * @param trustedAgents - The trusted agents list
 * @returns true if the agent is trusted
 */
export function isTrustedAgent(
  agentName: string,
  trustedAgents: string[]
): boolean {
  if (!agentName || !trustedAgents) return false
  return trustedAgents.includes(agentName)
}
