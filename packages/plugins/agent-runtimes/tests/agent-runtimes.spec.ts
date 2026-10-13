import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { dshHome } from '@tsuuanmi/system-libs'
import { afterEach, describe, expect, it } from 'vitest'
import { agentRuntimesConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import AgentRuntimeRegistry, { type Config } from '../src/index.ts'

agentRuntimesConformance('@tsuuanmi/system-agent-runtimes', AgentRuntimeRegistry)

describe('the read confinement of agent children (ADR-0024, INV-8)', () => {
  const credentials = process.env.CREDENTIALS_DIRECTORY
  afterEach(() => {
    if (credentials === undefined) delete process.env.CREDENTIALS_DIRECTORY
    else process.env.CREDENTIALS_DIRECTORY = credentials
  })
  const boot = async (config?: Config) => {
    const ctx = new Context()
    await ctx.plugin(AgentRuntimeRegistry, config)
    return ctx
  }

  it('always hides the DSH home and the service\'s credentials directory, and keeps operator tools readable', async () => {
    process.env.CREDENTIALS_DIRECTORY = '/run/credentials/system.service'
    const ctx = await boot()
    expect(ctx.agentRuntimes.confinement(['/home/op/.dsh/system/codex-home'])).toEqual({
      bwrap: 'bwrap',
      hide: [dshHome(), '/run/credentials/system.service'],
      readOnly: [join(dshHome(), 'system', 'tools')],
      writable: ['/home/op/.dsh/system/codex-home'],
    })
  })

  it('adds operator paths to hide, and never drops the DSH home', async () => {
    delete process.env.CREDENTIALS_DIRECTORY
    const ctx = await boot({ bwrap: '/usr/bin/bwrap', hide: ['/keys/vault.key'], readOnly: ['$DSH_HOME/tools', '/opt/agents'] })
    expect(ctx.agentRuntimes.confinement()).toEqual({
      bwrap: '/usr/bin/bwrap', hide: [dshHome(), '/keys/vault.key'], readOnly: [join(dshHome(), 'tools'), '/opt/agents'], writable: [],
    })
  })
})
