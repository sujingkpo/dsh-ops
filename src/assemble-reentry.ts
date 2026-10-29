/**
 * Bound how many times one assembly may re-enter the whole waterfall.
 *
 * Four hooks (`session-shells`, `ptc`, `discovery`, `publication/native`) all publish work
 * that the assembly they were handed cannot reflect, so each answers with
 * `prompt.assemble(context)` — a full re-run of EVERY hook, not `next()`. A hook that
 * re-enters re-arms the others, so the waterfall nests: measured 10–18 levels deep,
 * ~11 ms a level, on every session creation. The budget keeps the freshness the hooks
 * were written for while making the depth constant instead of open-ended.
 *
 * The key is the assembly context, which every re-entry passes along unchanged, so the
 * whole nested chain shares one counter. A fresh top-level assembly gets a fresh object
 * and therefore a fresh budget.
 *
 * @module dsh-ops/assemble-reentry
 */

/** How many re-entries one assembly context may spend. */
const REENTRY_BUDGET = 1

/** Re-entries already spent, per assembly context. */
const spent = new WeakMap<object, number>()

/**
 * Whether this assembly may re-enter the waterfall once more.
 * @param {object} context - the `system-prompt/assemble` context handed to the hook.
 * @returns {boolean} true when a re-entry is still affordable.
 */
export function mayReenterAssembly(context: unknown): boolean {
  if (context === null || typeof context !== 'object') { return false }
  const used = spent.get(context) ?? 0
  if (used >= REENTRY_BUDGET) { return false }
  spent.set(context, used + 1)
  return true
}
