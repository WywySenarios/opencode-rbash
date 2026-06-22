/**
 * Command validation for restricted bash tool.
 *
 * Parses a command string (supporting compound operators, pipes,
 * subshells, heredocs, here strings, inline comments, line
 * continuations, arithmetic expansion, and variable assignment
 * prefixes) and validates each executable against an allowlist
 * with optional pipe_target rules.
 *
 * Step A — Executable check: every command_name must be in allowlist
 * Step B — Pipe chain check: every pipe A | B must satisfy A's pipe_to
 *
 * Normalization pipeline (applied in order):
 *   1. normalizeContinuations() — join \ + newline
 *   2. stripInlineComments()    — remove #… outside quotes/nesting
 *   3. parsePipelineGroups()    — split by compounds → pipes
 *
 * Note: This module uses a lightweight token-based parser rather than
 * tree-sitter for synchronous operation. Tree-sitter integration is
 * planned for a future refactor to handle edge cases in bash grammar.
 */

import type { AllowConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationResult = {
  valid: boolean
  error?: string
}

type ParsedExecutable = {
  name: string
  isPath: boolean
  isDynamic: boolean
}

type PipePair = { source: string; target: string }

type SubshellResult = {
  execs: ParsedExecutable[]
  pipePairs: PipePair[]
}

// ---------------------------------------------------------------------------
// Shared parse state (quoting, nesting depth)
// ---------------------------------------------------------------------------

/**
 * Tracks quoting state and subshell nesting depth during character-by-character
 * iteration through a command string. Shared between the compound-splitter
 * and pipe-splitter to avoid duplicated logic.
 */
class ParseState {
  inSingleQuote = false
  inDoubleQuote = false
  depth = 0

  /** Update state for the current character. Returns true if the character
   * was consumed by state tracking (caller should skip further processing). */
  update(ch: string, next: string): boolean {
    if (!this.inDoubleQuote && ch === "'") {
      this.inSingleQuote = !this.inSingleQuote
      return true
    }
    if (!this.inSingleQuote && ch === '"') {
      this.inDoubleQuote = !this.inDoubleQuote
      return true
    }
    if (this.inSingleQuote || this.inDoubleQuote) return false

    // $( — command substitution (subshell). NOT $(( which is arithmetic.
    if (ch === "$" && next === "(") {
      this.depth++
      return true
    }
    // standalone ( — start of subshell (not double-(( which is arithmetic)
    if (ch === "(" && next !== "(") {
      this.depth++
      return true
    }
    if (ch === ")") {
      if (this.depth > 0) this.depth--
      return true
    }
    return false
  }

  /** True when inside a quote, subshell, or heredoc body. */
  get isInside(): boolean {
    return this.depth > 0 || this.inSingleQuote || this.inDoubleQuote
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeContinuations(cmd: string): string {
  return cmd.replace(/\\\n/g, " ")
}

/**
 * Strip inline comments (# ...) from a command string, respecting
 * quoting and nesting. A # character starts a comment only when
 * outside single/double quotes and outside $() subshell nesting.
 *
 * Applied at the top level in validateCommand() and recursively
 * in extractAllExecutablesFromString() for subshell inner content.
 */
function stripInlineComments(cmd: string): string {
  let result = ""
  const state = new ParseState()
  let i = 0

  while (i < cmd.length) {
    const ch = cmd[i]
    const next = cmd[i + 1] ?? ""

    // Skip escaped characters (treat as literal, advance past both)
    if (ch === "\\" && i + 1 < cmd.length) {
      result += ch + cmd[i + 1]
      i += 2
      continue
    }

    // $(( — arithmetic expansion, NOT a subshell or two separate ( groups
    if (ch === "$" && next === "(" && cmd[i + 2] === "(") {
      result += "$(("
      i += 3
      continue
    }

    // Update state (quoting / nesting)
    if (state.update(ch, next)) {
      result += ch
      if (ch === "$" && next === "(") {
        result += next
        i += 2
      } else {
        i++
      }
      continue
    }

    // If we hit # outside quotes/nesting, skip to end of line
    if (!state.isInside && ch === "#") {
      while (i < cmd.length && cmd[i] !== "\n") {
        i++
      }
      // Preserve the newline character (affects heredoc tracking downstream)
      if (i < cmd.length && cmd[i] === "\n") {
        result += "\n"
        i++
      }
      continue
    }

    result += ch
    i++
  }

  return result
}

// ---------------------------------------------------------------------------
// Parser — compound / pipeline splitting
// ---------------------------------------------------------------------------

/**
 * Parses a command string into pipeline groups.
 *
 * First splits at compound operators (&&, ||, ;) respecting quotes
 * and nesting, then splits each segment by pipe (|).
 *
 * Returns: array of pipeline groups, each being an array of command strings.
 */
function parsePipelineGroups(cmd: string): string[][] {
  const compoundSegments = splitCompounds(cmd)
  return compoundSegments.map((seg) => splitPipes(seg))
}

/**
 * Splits a command by compound operators (&&, ||, ;), tracking
 * quoting, nesting, and heredoc boundaries.
 */
function splitCompounds(cmd: string): string[] {
  const segments: string[] = []
  let current = ""
  const state = new ParseState()
  let inHereDoc = false
  let heredocDelim: string | null = null
  let i = 0

  while (i < cmd.length) {
    const ch = cmd[i]
    const next = cmd[i + 1] ?? ""

    // Skip escaped characters
    if (ch === "\\" && i + 1 < cmd.length) {
      current += ch + cmd[i + 1]
      i += 2
      continue
    }

    // $(( — arithmetic expansion, NOT a subshell or two separate ( groups
    if (ch === "$" && next === "(" && cmd[i + 2] === "(") {
      current += "$(("
      i += 3
      continue
    }

    // Update state (quoting / nesting)
    if (state.update(ch, next)) {
      current += ch
      if (ch === "$" && next === "(") {
        current += next
        i += 2
      } else {
        i++
      }
      continue
    }

    // Here string <<< — three < characters, NOT a heredoc
    if (ch === "<" && next === "<" && cmd[i + 2] === "<" && !inHereDoc) {
      current += "<<<"
      i += 3
      continue
    }

    // Heredoc detection and delimiter tracking
    if (ch === "<" && next === "<" && !inHereDoc) {
      inHereDoc = true
      heredocDelim = extractHeredocDelimiter(cmd, i)
      i += 2
      continue
    }

    if (inHereDoc && ch === "\n") {
      const lineEnd = cmd.indexOf("\n", i + 1)
      const line =
        lineEnd === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, lineEnd)
      if (line.trim() === heredocDelim) {
        inHereDoc = false
        heredocDelim = null
      }
    }

    // Split at compound operators (only when not nested/quoted/in heredoc)
    if (!state.isInside && !inHereDoc) {
      const op = matchCompoundOp(cmd, i)
      if (op) {
        if (current.trim()) segments.push(current.trim())
        current = ""
        i += op.length
        continue
      }
    }

    current += ch
    i++
  }

  if (current.trim()) segments.push(current.trim())
  return segments
}

/**
 * Extract the heredoc delimiter after <<.
 * Returns the delimiter string (unquoted).
 */
function extractHeredocDelimiter(cmd: string, start: number): string {
  let j = start + 2
  while (j < cmd.length && cmd[j] === " ") j++
  const quoteChar = cmd[j] === "'" || cmd[j] === '"' ? cmd[j] : null
  if (quoteChar) j++
  const delimStart = j
  while (
    j < cmd.length &&
    cmd[j] !== "\n" &&
    cmd[j] !== "|" &&
    cmd[j] !== ";" &&
    cmd[j] !== "&" &&
    cmd[j] !== ">" &&
    (quoteChar ? cmd[j] !== quoteChar : true)
  ) {
    j++
  }
  return cmd.slice(delimStart, j)
}

/**
 * Check if the given position is a compound operator. Returns the
 * matched operator string or null.
 */
function matchCompoundOp(cmd: string, i: number): string | null {
  const rest = cmd.slice(i)
  if (rest.startsWith("&&")) return "&&"
  if (rest.startsWith("||")) return "||"
  if (cmd[i] === ";" && cmd[i + 1] !== ";") return ";"
  // Single & = background operator (not &&, not &> redirect,
  // not part of 2>&1 redirect, not part of |& pipe)
  if (
    cmd[i] === "&" &&
    cmd[i + 1] !== "&" &&
    cmd[i + 1] !== ">" &&
    cmd[i - 1] !== ">" &&
    cmd[i - 1] !== "|"
  ) {
    return "&"
  }
  return null
}

/**
 * Splits a command segment by pipe (|) operators, respecting quoting and nesting.
 */
function splitPipes(segment: string): string[] {
  const parts: string[] = []
  let current = ""
  const state = new ParseState()
  let i = 0

  while (i < segment.length) {
    const ch = segment[i]
    const next = segment[i + 1] ?? ""

    // Skip escaped characters
    if (ch === "\\" && i + 1 < segment.length) {
      current += ch + segment[i + 1]
      i += 2
      continue
    }

    // $(( — arithmetic expansion, NOT a subshell or two separate ( groups
    if (ch === "$" && next === "(" && segment[i + 2] === "(") {
      current += "$(("
      i += 3
      continue
    }

    // Update state (quoting / nesting)
    if (state.update(ch, next)) {
      current += ch
      if (ch === "$" && next === "(") {
        current += next
        i += 2
      } else {
        i++
      }
      continue
    }

    // Split at pipe (only when not nested/quoted). |& is a single
    // pipe-with-stderr operator, consume both characters as one.
    if (!state.isInside && ch === "|" && next !== "|") {
      if (current.trim()) parts.push(current.trim())
      current = ""
      if (next === "&") {
        i += 2 // consume |& as a single pipe operator
      } else {
        i++ // consume just |
      }
      continue
    }

    current += ch
    i++
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

// ---------------------------------------------------------------------------
// Executable extraction
// ---------------------------------------------------------------------------

/**
 * Extract the next word from a string starting at the given position.
 * Skips leading whitespace, handles quoting and escape sequences.
 * Returns the word and the index after it, or null if no word found.
 */
export function extractWord(
  str: string,
  start: number
): { word: string; nextIndex: number } | null {
  let i = start
  // Skip leading whitespace
  while (i < str.length && (str[i] === " " || str[i] === "\t")) {
    i++
  }
  if (i >= str.length) return null

  let word = ""
  let inQuote = false
  let quoteChar: string | null = null

  for (; i < str.length; i++) {
    const ch = str[i]
    if (ch === "'" || ch === '"') {
      if (!inQuote) {
        inQuote = true
        quoteChar = ch
        continue
      } else if (ch === quoteChar) {
        inQuote = false
        continue
      }
    }
    if (!inQuote && (ch === " " || ch === "\t")) break
    if (ch === "\\" && i + 1 < str.length) {
      word += str[i + 1]
      i++
      continue
    }
    word += ch
  }

  if (!word) return null
  return { word, nextIndex: i }
}

/**
 * Test if a word matches the bash variable assignment pattern:
 * name=[value] or name+=value, where name is [a-zA-Z_][a-zA-Z0-9_]*.
 */
function isVariableAssignment(word: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*\+?=/.test(word)
}

/**
 * Extract the executable name from a pipeline segment string.
 *
 * Skips leading variable assignments (VAR=value, VAR+=value) to find
 * the actual command name. If only assignments are present (no command),
 * returns null — the segment is harmless and has nothing to validate.
 */
function extractExecutable(cmd: string): ParsedExecutable | null {
  const trimmed = cmd.trim()
  if (!trimmed) return null

  let pos = 0

  while (pos < trimmed.length) {
    const result = extractWord(trimmed, pos)
    if (!result) break

    if (isVariableAssignment(result.word)) {
      pos = result.nextIndex
      continue
    }

    // Found non-assignment word — this is the executable
    const firstWord = result.word
    const isDynamic =
      firstWord.startsWith("$") ||
      firstWord.includes("{") ||
      firstWord.includes("}")

    const isPath =
      firstWord.startsWith("/") ||
      firstWord.startsWith("./") ||
      firstWord.startsWith("../")

    const name = isPath ? firstWord.split("/").pop() ?? firstWord : firstWord
    return { name, isPath, isDynamic }
  }

  // Only assignments (or nothing) — no executable to validate
  return null
}

/**
 * Extract all executables and pipe pairs from a command string by running
 * it through the full pipeline / compound parser. Used recursively for
 * subshell inner content.
 */
function extractAllExecutablesFromString(cmd: string): SubshellResult {
  const execs: ParsedExecutable[] = []
  const pipePairs: PipePair[] = []
  const normalized = stripInlineComments(normalizeContinuations(cmd))
  const groups = parsePipelineGroups(normalized)

  for (const pipeline of groups) {
    const cmdsInPipeline: ParsedExecutable[] = []

    for (const part of pipeline) {
      const exec = extractExecutable(part)
      if (exec) cmdsInPipeline.push(exec)
      const sub = extractSubshellExecutables(part)
      execs.push(...sub.execs)
      pipePairs.push(...sub.pipePairs)
    }

    for (let i = 1; i < cmdsInPipeline.length; i++) {
      pipePairs.push({
        source: cmdsInPipeline[i - 1].name,
        target: cmdsInPipeline[i].name,
      })
    }

    execs.push(...cmdsInPipeline)
  }

  return { execs, pipePairs }
}

function extractSubshellExecutables(cmd: string): SubshellResult {
  const execs: ParsedExecutable[] = []
  const pipePairs: PipePair[] = []
  let depth = 0
  let subStart = -1
  let arithDepth = 0

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1] ?? ""

    // $(( — arithmetic expansion, NOT a subshell
    if (ch === "$" && next === "(" && cmd[i + 2] === "(") {
      arithDepth++
      i += 2 // +1 from loop = skip all 3 chars ( $ ( ( )
      continue
    }

    // )) — close arithmetic expansion
    if (ch === ")" && next === ")" && arithDepth > 0) {
      arithDepth--
      i++ // +1 from loop = skip both ) chars
      continue
    }

    // Inside arithmetic — skip subshell detection for any remaining
    // ( or ) characters (e.g. nested parens in expression)
    if (arithDepth > 0) continue

    // $(command) — command substitution
    if (ch === "$" && next === "(") {
      if (depth === 0) subStart = i + 2
      depth++
      i++
      continue
    }

    // <(command) — process substitution (input fd)
    if (ch === "<" && next === "(") {
      if (depth === 0) subStart = i + 2
      depth++
      i++
      continue
    }

    // >(command) — process substitution (output fd)
    if (ch === ">" && next === "(") {
      if (depth === 0) subStart = i + 2
      depth++
      i++
      continue
    }

    // (command) — subshell (only if not preceded by word char or $)
    if (ch === "(" && !/[\w$]/.test(cmd[i - 1] ?? "")) {
      if (depth === 0) subStart = i + 1
      depth++
      continue
    }

    if (ch === ")" && depth > 0) {
      depth--
      if (depth === 0 && subStart >= 0) {
        const inner = cmd.slice(subStart, i).trim()
        if (inner) {
          // Use full pipeline parser to find ALL executables and pipe
          // pairs in the subshell (handles pipes, &&, ||, ; inside)
          const sub = extractAllExecutablesFromString(inner)
          execs.push(...sub.execs)
          pipePairs.push(...sub.pipePairs)
        }
        subStart = -1
      }
    }
  }

  return { execs, pipePairs }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function rejectNotInAllowlist(name: string): ValidationResult {
  return {
    valid: false,
    error: `Command rejected — executable '${name}' is not in the project allowlist.`,
  }
}

function rejectPath(): ValidationResult {
  return {
    valid: false,
    error: `Command rejected — use PATH-resolved executables only (absolute/relative paths are not allowed).`,
  }
}

function rejectDynamic(name: string): ValidationResult {
  return {
    valid: false,
    error: `Command rejected — '${name}' is a dynamic command name. Only static executables are allowed.`,
  }
}

function rejectPipe(source: string, target: string): ValidationResult {
  return {
    valid: false,
    error: `Command rejected — '${source}' may not pipe to '${target}'. Check .opencode/bash-restricted.jsonc for permitted pipe targets.`,
  }
}

// ---------------------------------------------------------------------------
// Pipe chain validation (shared by top-level and subshell pairs)
// ---------------------------------------------------------------------------

function validatePipePairs(
  pipePairs: PipePair[],
  allowlist: AllowConfig
): ValidationResult | null {
  for (const pair of pipePairs) {
    const srcEntry = allowlist[pair.source]
    if (srcEntry?.pipe_to !== undefined && !srcEntry.pipe_to.includes(pair.target)) {
      return rejectPipe(pair.source, pair.target)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateCommand(
  command: string,
  allowlist: AllowConfig
): ValidationResult {
  const normalized = stripInlineComments(normalizeContinuations(command))
  if (!normalized || !normalized.trim()) {
    return { valid: false, error: "Command is empty" }
  }

  const groups = parsePipelineGroups(normalized)
  if (groups.length === 0) {
    return { valid: false, error: "No executable found in command" }
  }

  const allExecs: ParsedExecutable[] = []
  const allPipePairs: PipePair[] = []

  for (const pipelineCmds of groups) {
    const pipeExecs: ParsedExecutable[] = []

    for (const cmd of pipelineCmds) {
      const exec = extractExecutable(cmd)
      if (exec) pipeExecs.push(exec)
      const sub = extractSubshellExecutables(cmd)
      allExecs.push(...sub.execs)
      allPipePairs.push(...sub.pipePairs)
    }

    allExecs.push(...pipeExecs)

    // Step B — Top-level: cascading pipe chain validation
    for (let i = 0; i < pipeExecs.length; i++) {
      const src = pipeExecs[i]
      const srcEntry = allowlist[src.name]
      if (srcEntry?.pipe_to === undefined) continue

      for (let j = i + 1; j < pipeExecs.length; j++) {
        if (!srcEntry.pipe_to.includes(pipeExecs[j].name)) {
          return rejectPipe(src.name, pipeExecs[j].name)
        }
      }
    }
  }

  // Step B — Subshell pipe pair validation
  const pipeViolation = validatePipePairs(allPipePairs, allowlist)
  if (pipeViolation) return pipeViolation

  // Step A — Executable check (include subshell executables)
  const hasWildcard = "*" in allowlist
  for (const exec of allExecs) {
    // Wildcard "*" in the allowlist means any executable is permitted.
    // Pipe restrictions (Step B) are still enforced for safety.
    if (hasWildcard) continue
    if (exec.isPath) return rejectPath()
    if (exec.isDynamic) return rejectDynamic(exec.name)
    if (!(exec.name in allowlist)) return rejectNotInAllowlist(exec.name)
  }

  return { valid: true }
}
