/** Trusted cache metadata comes from the host, never tool arguments or selected operation roots. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy, ConfinedArgv } from '../adapter/dsh/types.js'
import type { WorkerStorage } from '../execution/protocol.js'
import { workerEnvelope } from '../execution/protocol.js'
import { CAPABILITIES } from '../capabilities/registry.js'
import { publicToolName } from '../policy.js'
import { confineWorkspace } from '../workspace-preparation.js'
import { resultSessionNonce, registerResultCleanup } from './result-lifecycle.js'
import type { ResultSession } from './result-lifecycle.js'

interface Subprocess {
  spawn(spec: { argv: string[]; cwd: string; stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }; graceMs: number; signal: AbortSignal }): {
    done: Promise<{ exitCode: number | null; signal?: unknown }>
    collected: { stdout: { readFrom(offset: number): { text: string; lossy?: boolean } } }
  }
}
export interface StorageHost {
  root?: object
  get(name: 'sandbox'): { confine(argv: string[], policy: SandboxExecutionPolicy & { mode: 'read-only' | 'workspace-write' }, signal?: AbortSignal): Promise<ConfinedArgv>; prepareResultStorage?(argv: string[], policy: SandboxExecutionPolicy & { mode: 'workspace-write' }, signal?: AbortSignal): Promise<ConfinedArgv> } | undefined
  get(name: 'sandboxPolicy'): { resolve(input: { session: ResultSession }): SandboxExecutionPolicy } | undefined
  get(name: 'tools'): { schemas(scope: unknown): { name: string }[]; get(name: string, scope: unknown): unknown } | undefined
  get(name: 'subprocess'): Subprocess | undefined
}
type Location = { root: string; windowsWriteSid?: string }
const locations = new WeakMap<object, Map<string, Location>>()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Parse only the runner's pre-separator contract, not the wrapped program's arguments. */
export function windowsCacheLocation(argv: readonly string[]): Location | undefined {
  const separator = argv.indexOf('--')
  if (separator < 1) return undefined
  const flags = argv.slice(1, separator)
  const one = (flag: string): string | undefined => {
    const index = flags.indexOf(flag)
    return index >= 0 && flags.lastIndexOf(flag) === index ? flags[index + 1] : undefined
  }
  const root = one('--temp'), sid = one('--temp-write-sid')
  const match = /^S-1-4-([1-9][0-9]*)-([1-9][0-9]*)-1$/.exec(sid ?? '')
  if (!root || !path.win32.isAbsolute(root) || root.includes('\0') || !match
    || match.slice(1).some(part => Number(part) > 1073741823)) return undefined
  return { root, windowsWriteSid: sid }
}
/**
 * bwrap gives workspace-write children a private tmpfs over /tmp, which hides the host-created
 * cache below tmpdir(). Re-expose exactly that one private directory; every other runner, and
 * read-only bwrap (no tmpfs), already sees it and is returned unchanged.
 */
export function exposePosixCache(argv: readonly string[], storage: WorkerStorage | undefined): string[] {
  const separator = argv.indexOf('--')
  if (!storage || storage.windowsWriteSid !== undefined || separator < 1 || path.basename(argv[0]) !== 'bwrap'
    || !argv.slice(1, separator).some(option => option === '--tmpfs' || option.startsWith('--tmpfs='))
    || !path.isAbsolute(storage.root)) return [...argv]
  return [...argv.slice(0, separator), '--bind', storage.root, storage.root, ...argv.slice(separator)]
}
/**
 * The cache root a full-access session owns without asking the sandbox for one.
 *
 * 'windows-acl' confinement would create a private random directory as a side effect, but it
 * also materializes the runner's workspace and temp ACEs (and, on a workspace it has never
 * prepared, an interpreter run). A full-access session already executes without those ACEs,
 * and purge() below skips confinement for exactly the same reason, so the directory alone is
 * what the cache needs. Same shape posixCacheLocation enforces: a random leaf under the
 * canonical temp root, created without following any caller path.
 */
function fullAccessCacheLocation(): Location {
  // realpath first: tmpdir() itself may be a junction, and a random leaf below a reparse
  // point would put the cache somewhere the checks below cannot vouch for.
  const parent = fs.realpathSync(tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'dsh-ops-results-'))
  const info = fs.lstatSync(root)
  // Windows reports no POSIX permission bits (a fresh directory reads 0o666), so the identity
  // checks here are directory-ness and no symlink; mkdtemp created the leaf below realpath().
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Result cache root must be a private directory')
  return { root }
}
function posixCacheLocation(key: string, create: boolean): Location | undefined {
  const parent = fs.realpathSync(tmpdir()), root = path.join(parent, `dsh-ops-results-${key}`)
  // Only one fresh leaf under the canonical temp root. No recursive mkdir through caller paths.
  if (create) {
    try { fs.mkdirSync(root, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  if (!fs.existsSync(root)) return undefined
  const info = fs.lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) throw new Error('Result cache parent must be private and owned')
  return { root }
}
function currentTools(ctx: StorageHost, scope: unknown, tool: string): string[] {
  const tools = ctx.get('tools'), visible = new Set(tools?.schemas(scope).map(item => item.name) ?? [])
  return CAPABILITIES.filter(item => item.rawName === tool
    || (visible.has(publicToolName(item.rawName)) && tools?.get(publicToolName(item.rawName), scope)))
    .map(item => item.rawName)
}
async function purge(ctx: StorageHost, session: ResultSession, file: string, storage: WorkerStorage,
  original: SandboxExecutionPolicy): Promise<void> {
  const policyService = ctx.get('sandboxPolicy'), subprocess = ctx.get('subprocess')
  const policy = policyService?.resolve({ session })
  if (!policy || !subprocess || policy.mode === 'read-only' || policy.workspaceRoot !== original.workspaceRoot
    || (process.platform === 'win32' && policy.sessionId !== session.id)) throw new Error('Cleanup authority unavailable')
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000)
  timer.unref?.()
  try {
    let argv = [file]
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      const confined = process.platform === 'win32' && sandbox?.prepareResultStorage
        ? await sandbox.prepareResultStorage(argv, { ...policy, mode: 'workspace-write' }, controller.signal)
        : await sandbox?.confine(argv, { ...policy, mode: 'workspace-write' }, controller.signal)
      if (!confined || !['full', 'partial'].includes(confined.enforcement) || !confined.argv.length) throw new Error('Cleanup confinement unavailable')
      if (process.platform === 'win32') {
        const location = windowsCacheLocation(confined.argv)
        if (location?.root !== storage.root || location?.windowsWriteSid !== storage.windowsWriteSid) throw new Error('Cleanup cache grant changed')
      }
      argv = exposePosixCache(confined.argv, storage)
    }
    const latest = policyService?.resolve({ session })
    if (latest?.mode !== policy.mode || latest?.workspaceRoot !== policy.workspaceRoot
      || (process.platform === 'win32' && latest?.sessionId !== session.id)) throw new Error('Cleanup authority changed')
    const envelope = workerEnvelope('ptc', { root: policy.workspaceRoot, scope: session.id, tool: 'result', args: { action: 'purge' }, read_only: false }, 5000, storage)
    const handle = subprocess.spawn({ argv, cwd: policy.workspaceRoot, stdio: { stdin: { data: JSON.stringify(envelope) }, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1000, signal: controller.signal })
    const outcome = await handle.done, output = handle.collected.stdout.readFrom(0)
    const value: unknown = JSON.parse(output.text)
    if (outcome.exitCode !== 0 || outcome.signal || output.lossy || !value || typeof value !== 'object'
      || !('status' in value) || value.status !== 'completed') throw new Error('Cache purge did not complete')
  } finally { clearTimeout(timer) }
}
export async function resultStorage(ctx: StorageHost, session: ResultSession, scope: unknown, file: string,
  tool: string, policy: SandboxExecutionPolicy, denyRoots: string[], denyNames: boolean,
  signal?: AbortSignal, confined?: ConfinedArgv): Promise<WorkerStorage | undefined> {
  const nonce = resultSessionNonce(ctx, session), key = digest([session.id, policy.workspaceRoot, nonce])
  const owner = ctx.root ?? ctx
  let cache = locations.get(owner)
  if (!cache) { cache = new Map(); locations.set(owner, cache) }
  let location = cache.get(key)
  if (process.platform === 'win32') {
    if (!location && policy.mode !== 'read-only') {
      if (policy.sessionId !== session.id) return undefined
      if (policy.mode === 'danger-full-access') {
        // Full access runs unconfined by user choice, so narrowing it back to workspace-write
        // for a cache directory only ever bought the directory itself. Take one directly.
        location = fullAccessCacheLocation()
      } else {
        const cachePolicy = { ...policy, mode: 'workspace-write' as const }
        if (!confined) {
          const sandbox = ctx.get('sandbox')
          if (!sandbox) return undefined
          if (sandbox.prepareResultStorage) confined = await sandbox.prepareResultStorage([file], cachePolicy, signal)
          else {
            // Legacy hosts do not expose cache-only preparation. Prepare the ACL only when
            // confinement reports it missing: the grant outlives the process, so a workspace
            // prepared once never pays for the interpreter again.
            confined = await confineWorkspace(cachePolicy, () => sandbox.confine([file], cachePolicy, signal))
          }
        }
        if (!['full', 'partial'].includes(confined.enforcement)) return undefined
        location = windowsCacheLocation(confined.argv)
      }
    }
  } else location ??= posixCacheLocation(key, policy.mode !== 'read-only')
  if (!location) return undefined
  if (process.platform === 'win32' && confined && policy.mode !== 'read-only') {
    const current = windowsCacheLocation(confined.argv)
    if (current?.root !== location.root || current?.windowsWriteSid !== location.windowsWriteSid) throw new Error('Session cache grant changed')
  }
  cache.set(key, location)
  const storage: WorkerStorage = { ...location, authorityId: digest([nonce, policy.mode, policy.workspaceRoot, denyRoots, denyNames]), allowedTools: currentTools(ctx, scope, tool) }
  registerResultCleanup(ctx, session, key, async () => {
    try { await purge(ctx, session, file, storage, policy) }
    finally { cache.delete(key) }
  })
  return storage
}
