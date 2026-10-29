/** Discovery narrows attributed OPS changes locally and never re-probes the whole roster on an unattributed one. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discovery from '../lib/components/discovery/index.js'
import { withToolChange } from '../lib/tool-changes.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const foreignTool = name => ({
  name,
  description: `probe memo fixture ${name}`,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

await test('attributed unrelated changes and unattributed host notifications both keep the cached verdict', () => withTempDir('discovery', async dir => {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    await ctx.plugin(discovery, { required: true })
    const agent = { id: 'probe-memo', session: { id: 'probe-memo', mode: 'danger-full-access', header: { cwd: dir } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent, source: 'startup' })

    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    let probes = 0
    prompt.assemble = context => { if (isPresentationProbe(context)) ++probes; return assemble(context) }
    try {
      // A prompt registry change is the signal that genuinely owes a fresh verdict.
      await ctx.serial('system-prompt/change')
      await wait(300)
      const settled = probes
      assert.ok(settled > 0, 'a prompt registry change probes the agent at least once (precondition)')
      // Package-owned sibling changes carry exact scope attribution; they cannot
      // affect this root agent, unlike an unknown external provider.
      await withToolChange([{}], () => ctx.serial('tools/change', {}))
      await wait(300)
      assert.equal(probes, settled, 'unrelated OPS registration must not re-probe')
      // An unattributed notification no longer drops the cached verdicts: dropping them
      // re-assembled the prompt once per live Agent, so creating one session cost N+1
      // assemblies. The step and execution probes are still fresh and remain the
      // authority on whether discovery may publish.
      await ctx.serial('tools/change', {})
      await wait(300)
      assert.equal(probes, settled, 'unknown registry notifications keep the cached verdict off the creation path')
    } finally { prompt.assemble = assemble }
  } finally { await shutdown(ctx) }
}))

report('discovery-probe-memo')
