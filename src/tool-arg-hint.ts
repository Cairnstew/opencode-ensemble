/**
 * Weak-model tool-argument fumble detection and error hints (issue #39).
 *
 * Some models trained on other harness conventions call OpenCode's built-in
 * tools with aliased parameter names (e.g. `cmd` instead of the `shell`
 * tool's `command`). OpenCode V2 rejects the call with a generic validation
 * error that the model may fail to act on. This module detects that exact
 * dead-call shape and produces an explicit hint appended to the error so
 * the model can self-correct. Arguments are never rewritten — the model
 * stays in the correction loop.
 *
 * V2 only: on V1, argument validation happens at the model-stream parse
 * level, so tool hooks never see the failed call (see issue #39 triage).
 */

/**
 * Canonical parameter plus the aliases weak models emit for it. Only the
 * confirmed failure mode is listed; extend per-tool as reports come in.
 */
const ARG_ALIASES: Readonly<Record<string, { param: string; aliases: readonly string[] }>> = {
  shell: { param: "command", aliases: ["cmd", "bash", "script"] },
}

/**
 * Return the alias a weak model used instead of the tool's canonical
 * parameter, or null when the input is not a recognized fumble. A fumble is
 * only recognized when the canonical parameter is absent and a known alias
 * is present as a non-empty string — i.e. only on calls that are already
 * guaranteed to fail validation.
 */
export function detectArgFumble(tool: string, input: unknown): string | null {
  const entry = ARG_ALIASES[tool]
  if (!entry) return null
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null
  const args = input as Record<string, unknown>
  if (entry.param in args) return null
  for (const alias of entry.aliases) {
    const value = args[alias]
    if (typeof value === "string" && value !== "") return alias
  }
  return null
}

/**
 * Build the hint text for a fumbled tool call, or null when the input is
 * not a recognized fumble.
 */
export function buildArgHint(tool: string, input: unknown): string | null {
  const entry = ARG_ALIASES[tool]
  if (!entry) return null
  const alias = detectArgFumble(tool, input)
  if (!alias) return null
  return (
    `Hint: the "${tool}" tool has no "${alias}" parameter. The correct parameter ` +
    `name is "${entry.param}" — call the tool again with the same arguments, ` +
    `moving the "${alias}" value into "${entry.param}".`
  )
}

/**
 * Append the fumble hint to a failed tool call's error message in place.
 * Returns true when the message was modified. Never throws — a malformed
 * error or input leaves the original message untouched.
 */
export function enrichToolError(tool: string, error: { message?: unknown }, input: unknown): boolean {
  if (typeof error.message !== "string") return false
  const hint = buildArgHint(tool, input)
  if (!hint) return false
  error.message = `${error.message}\n\n${hint}`
  return true
}
