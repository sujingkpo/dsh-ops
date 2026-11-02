/** Guards the local optimizations this fork keeps on top of upstream so a merge cannot silently drop them. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const read = rel => fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')

await test('the workspace-confinement optimization stays wired', () => {
  const prep = read('src/workspace-preparation.ts')
  assert.match(prep, /export async function confineWorkspace\b/, 'workspace-preparation must export confineWorkspace')
  assert.match(prep, /export function missingWriteOwner\b/, 'workspace-preparation must export missingWriteOwner')

  const session = read('src/shells/session-execution.ts')
  assert.match(session, /import\s*\{[^}]*confineWorkspace[^}]*\}\s*from\s*'\.\.\/workspace-preparation\.js'/, 'session-execution must import confineWorkspace')
  assert.match(session, /confineWorkspace\(/, 'session-execution must call confineWorkspace instead of preparing unconditionally')

  const jobs = read('src/execution/jobs.ts')
  assert.match(jobs, /confineWorkspace/, 'jobs must confine through confineWorkspace')
})

await test('the bounded assembly re-entry optimization stays wired', () => {
  const guard = read('src/assemble-reentry.ts')
  assert.match(guard, /export function mayReenterAssembly\b/, 'assemble-reentry must export mayReenterAssembly')

  const shells = read('src/session-shells.ts')
  assert.match(shells, /mayReenterAssembly/, 'session-shells must bound re-entry via mayReenterAssembly')
})

await test('the changelog keeps the local optimization entries', () => {
  const changelog = read('docs/CHANGELOG.md')
  assert.match(changelog, /session-shells/i, 'changelog must keep the session-shells re-entry entry')
  assert.match(changelog, /confinement helper/i, 'changelog must keep the confinement-helper entry')
})

report('local-optimizations')
