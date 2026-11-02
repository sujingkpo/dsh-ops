/**
 * Bound how many times one assembly hook may re-enter the whole waterfall.
 *
 * Four hooks (session-shells, ptc, discovery, publication/native) all publish work
 * that the assembly they were handed cannot reflect, so each answers with
 * `prompt.assemble(context)` — a full re-run of EVERY hook, not `next()`. A hook that
 * re-enters re-arms the others, so the waterfall nests: measured 10–18 levels deep,
 * ~11 ms a level, on every session creation. The budget keeps the freshness the hooks
 * were written for while making the depth constant instead of open-ended.
 *
 * The key is the assembly context, which every re-entry passes along unchanged, so the
 * whole nested chain shares one counter per hook. A hook gets its OWN budget rather than
 * sharing one global counter: a hook that re-enters re-runs the whole waterfall, and an
 * earlier hook spending the single shared budget would deny a later hook its one rebuild
 * (dropping, for example, the freshly published Bash section). With a per-hook budget the
 * nesting depth stays bounded by the number of hooks while every hook can still reflect
 * the work it published. A fresh top-level assembly gets a fresh context object and
 * therefore a fresh budget for each hook.
 *
 * @module dsh-ops/assemble-reentry
 */

/** How many re-entries one assembly context may spend per hook. */
const REENTRY_BUDGET = 1

/** Re-entries already spent, per assembly context and per hook. */
const spent = new WeakMap<object, Map<string, number>>()

/**
 * Whether this hook may re-enter the waterfall once more for this assembly.
 * @param context - the `system-prompt/assemble` context handed to the hook.
 * @param hook - a stable tag identifying the calling hook; each hook has its own budget.
 * @returns true when a re-entry is still affordable for this hook.
 */
export function mayReenterAssembly(context: unknown, hook = 'default'): boolean {
  if (context === null || typeof context !== 'object') { return false }
  let budget = spent.get(context)
  if (!budget) { budget = new Map(); spent.set(context, budget) }
  const used = budget.get(hook) ?? 0
  if (used >= REENTRY_BUDGET) { return false }
  budget.set(hook, used + 1)
  return true
}
