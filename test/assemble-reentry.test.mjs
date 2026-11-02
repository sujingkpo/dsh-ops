/** One assembly may re-enter the whole waterfall once, never without bound. */
import { assert, test, report } from './lib/harness.mjs'
import { mayReenterAssembly } from '../lib/assemble-reentry.js'

await test('an assembly context spends a bounded re-entry budget', () => {
  const context = { scope: {} }
  assert.equal(mayReenterAssembly(context), true, 'the first re-entry is affordable')
  assert.equal(mayReenterAssembly(context), false, 'the second is refused')
  assert.equal(mayReenterAssembly(context), false, 'and stays refused for the same context')
  // A fresh top-level assembly gets a fresh context object and therefore a fresh budget.
  assert.equal(mayReenterAssembly({ scope: {} }), true)
})

await test('each hook carries its own budget on the same context', () => {
  const context = { scope: {} }
  assert.equal(mayReenterAssembly(context, 'alpha'), true)
  assert.equal(mayReenterAssembly(context, 'alpha'), false, 'a hook spends its budget once')
  // A later hook must still be able to reflect the work it published; a shared counter
  // would let an earlier hook deny it and drop a freshly published prompt section.
  assert.equal(mayReenterAssembly(context, 'beta'), true, 'a different hook has its own budget')
  assert.equal(mayReenterAssembly(context, 'beta'), false)
})

await test('a missing or non-object context can never re-enter', () => {
  for (const value of [undefined, null, 0, 'context', true]) {
    assert.equal(mayReenterAssembly(value), false, 'refused for ' + String(value))
  }
})

report('assemble-reentry')
