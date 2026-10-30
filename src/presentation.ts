/** Inspect public presentation before publishing a replacement. Inspection is
 * marked by exact context identity and never becomes a provider request. */
import type { AssembleContext, PromptAssembly, SystemPrompt } from './adapter/dsh/types.js'

const probes = new WeakSet<AssembleContext>()
export function isPresentationProbe(context: AssembleContext): boolean { return probes.has(context) }
export async function inspectPresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<PromptAssembly> {
  const context: AssembleContext = { scope, signal }
  probes.add(context)
  try {
    return await prompt.assemble(context)
  } finally { probes.delete(context) }
}

export async function isNativePresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<boolean> {
  const assembly = await inspectPresentation(prompt, scope, signal)
  return !assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
}

/**
 * Reuse one full assembly across the rows that need the same verdict.
 *
 * Both the discovery row and the PTC row must decide "is this Agent's presentation
 * ptc-only?", and each used to run its own complete `prompt.assemble`. A cold
 * assembly renders the whole tool SDK document (one jsonSchemaToTs pass over every
 * tool schema) and costs ~1.3s at ~150 tools, so a session creation paid that
 * twice, synchronously, before the host could finish creating the session.
 *
 * The memo is keyed by the Agent plus a cheap `signature` the caller derives from
 * the visible tool names and the resolved sandbox mode. Any tool or mode change
 * alters that signature, so a stale verdict is never returned; a tiny per-Agent
 * ring keeps the most recent few.
 */
interface AssemblyMemo { signature: string; assembly: PromptAssembly }
const assemblyMemo = new WeakMap<object, AssemblyMemo[]>()
export async function inspectPresentationShared(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signature: string, signal?: AbortSignal): Promise<PromptAssembly> {
  const list = assemblyMemo.get(scope) ?? []
  const hit = list.find(entry => entry.signature === signature)
  if (hit) { return hit.assembly }
  const assembly = await inspectPresentation(prompt, scope, signal)
  list.unshift({ signature, assembly })
  if (list.length > 3) { list.length = 3 }
  assemblyMemo.set(scope, list)
  return assembly
}

/** Drop the memo for one Agent (used when its surface is deliberately rebuilt). */
export function forgetPresentation(scope: object): void { assemblyMemo.delete(scope) }
