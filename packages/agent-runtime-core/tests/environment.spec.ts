import { afterEach, describe, expect, it } from 'vitest'
import { childEnvironment } from '../src/index.ts'

describe('an agent runtime child starts without the daemon\'s credentials (INV-8)', () => {
  const set = (vars: Record<string, string>) => Object.assign(process.env, vars)
  const added = ['SYSTEM_MCP_TOKEN', 'OPENAI_API_KEY', 'DB_PASSWORD', 'APP_SECRET', 'DSH_HOME_HINT', 'SYSTEM_TEST_PLAIN']
  afterEach(() => {
    for (const name of added) delete process.env[name]
  })

  it('drops credential-shaped and DSH_* names, and keeps the rest (PATH, HOME, plain names)', () => {
    set({ SYSTEM_MCP_TOKEN: 'gateway-token', OPENAI_API_KEY: 'k', DB_PASSWORD: 'p', APP_SECRET: 's', DSH_HOME_HINT: 'h', SYSTEM_TEST_PLAIN: 'plain' })
    const env = childEnvironment()
    for (const name of ['SYSTEM_MCP_TOKEN', 'OPENAI_API_KEY', 'DB_PASSWORD', 'APP_SECRET', 'DSH_HOME_HINT']) expect(env).not.toHaveProperty(name)
    expect(env).toMatchObject({ SYSTEM_TEST_PLAIN: 'plain', PATH: process.env.PATH })
  })

  it('forwards a credential only when the operator names it, and explicit values win', () => {
    set({ SYSTEM_MCP_TOKEN: 'gateway-token', OPENAI_API_KEY: 'k' })
    expect(childEnvironment(['SYSTEM_MCP_TOKEN'])).toMatchObject({ SYSTEM_MCP_TOKEN: 'gateway-token' })
    expect(childEnvironment(['SYSTEM_MCP_TOKEN'])).not.toHaveProperty('OPENAI_API_KEY')
    expect(childEnvironment(['SYSTEM_MCP_TOKEN'], { SYSTEM_MCP_TOKEN: 'explicit' })).toMatchObject({ SYSTEM_MCP_TOKEN: 'explicit' })
    // A forwarded name the daemon does not set is simply absent.
    expect(childEnvironment(['NOT_SET_ANYWHERE_TOKEN'])).not.toHaveProperty('NOT_SET_ANYWHERE_TOKEN')
  })
})
