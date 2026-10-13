import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import type { Confinement } from '@tsuuanmi/system-agent-runtime-core'
import { AcpAgentRuntime, type AcpConfinement } from '../src/index.ts'

const SCRIPTED = fileURLToPath(new URL('./fixtures/scripted-agent.mjs', import.meta.url))
// The scripted agent runs through the confined command line; a pass-through stands in for
// bubblewrap here, and the real one is used where the hiding itself is under test.
const PASSTHROUGH = fileURLToPath(new URL('../../../agent-runtime-core/conformance/passthrough-bwrap.sh', import.meta.url))
const passthrough: AcpConfinement = {
  confine: (): Confinement => ({ bwrap: PASSTHROUGH, hide: [], readOnly: [], writable: [] }),
  prove: async () => ({ confined: true, detail: 'host state hidden' }),
}
const runtime = (honoursPermissions = true, extra: Partial<ConstructorParameters<typeof AcpAgentRuntime>[0]> = {}, timing?: ConstructorParameters<typeof AcpAgentRuntime>[1], reads: AcpConfinement = passthrough) =>
  new AcpAgentRuntime({ name: 'scripted', command: process.execPath, args: [SCRIPTED], honoursPermissions, ...extra }, timing, reads)

function findBwrap(): string | undefined {
  try {
    return execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
const BWRAP = findBwrap()

agentRuntimeProviderConformance('acp:scripted', () => runtime())

describe('acp: the client side enforces the policy', () => {
  const base = mkdtempSync(join(tmpdir(), 'system-acp-'))
  const workspace = join(base, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'inside.txt'), 'inside text')
  writeFileSync(join(base, 'secret.txt'), 'secret text')
  symlinkSync(join(base, 'secret.txt'), join(workspace, 'link.txt'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const signal = () => new AbortController().signal

  it('probes by the protocol handshake, and offers read-only only to an agent the operator vouches for', async () => {
    expect(await runtime().probe()).toEqual({
      available: true, detail: 'ACP agent scripted 1.0.0 (protocol 1); host state hidden', version: '1.0.0', sandboxes: ['read-only'], resume: true, executes: false, readsConfined: true,
    })
    // An agent can act on its own without asking; unvouched, it is never trusted with a policy.
    expect(await runtime(false).probe()).toMatchObject({ available: true, sandboxes: [] })
    await expect(runtime(false).run({ prompt: 'x', workspace, sandbox: 'read-only' }, signal())).rejects.toMatchObject({ kind: 'config_error' })
  })

  it('runs nothing, and proves no confinement, without a read confinement (ADR-0024)', async () => {
    const none = runtime(true, {}, undefined, {})
    expect(await none.probe()).toMatchObject({ readsConfined: false, detail: expect.stringContaining('no read confinement') })
    await expect(none.run({ prompt: 'x', workspace, sandbox: 'read-only' }, signal())).rejects.toMatchObject({ kind: 'config_error' })
  })

  it.skipIf(!BWRAP && process.env.SYSTEM_REQUIRE_BWRAP !== '1')('hides host state from the agent\'s own reads, not only from the reads it asks for (ADR-0024, REQ-WRK-6)', async () => {
    const reads: AcpConfinement = { confine: (bind) => ({ bwrap: BWRAP ?? 'bwrap', hide: [base], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }) }
    const look = async (path: string, r: AcpConfinement) => (await runtime(true, {}, undefined, r).run({ prompt: `look:${path}`, workspace, sandbox: 'read-only' }, signal())).text
    expect(await look(join(base, 'secret.txt'), passthrough)).toBe('look: present')
    expect(await look(join(base, 'secret.txt'), reads)).toBe('look: absent')
    expect(await look(join(workspace, 'inside.txt'), reads)).toBe('look: present')
    expect(await runtime(true, {}, undefined, reads).probe()).toMatchObject({ readsConfined: true })
  })

  it('rejects every permission request', async () => {
    expect((await runtime().run({ prompt: 'ask permission', workspace, sandbox: 'read-only' }, signal())).text).toBe('permission: no')
  })

  it('serves file reads inside the workspace only, symlinks resolved', async () => {
    const read = async (path: string) => (await runtime().run({ prompt: `read:${path}`, workspace, sandbox: 'read-only' }, signal())).text
    expect(await read(join(workspace, 'inside.txt'))).toBe('read: inside text')
    expect(await read(join(base, 'secret.txt'))).toMatch(/^read refused/)
    expect(await read(join(workspace, 'link.txt'))).toMatch(/^read refused/)
    expect(await read(`${workspace}/../secret.txt`)).toMatch(/^read refused/)
  })

  it('refuses what ACP cannot express exactly: tool lists, a model, a turn limit (REQ-WRK-6)', async () => {
    for (const extra of [{ tools: ['Read'] }, { model: 'm' }, { maxTurns: 3 }]) {
      await expect(runtime().run({ prompt: 'x', workspace, sandbox: 'read-only', ...extra }, signal())).rejects.toMatchObject({ kind: 'config_error' })
    }
  })

  it('continues a session by its id (loadSession)', async () => {
    const result = await runtime().run({ prompt: 'again', workspace, sandbox: 'read-only', resume: 'h-1' }, signal())
    expect(result).toMatchObject({ text: 'echo: again', nativeHandle: 'h-1' })
  })

  it('starts the agent without the daemon\'s credentials; a credential reaches it only when forwarded by name (INV-8)', async () => {
    Object.assign(process.env, { SYSTEM_MCP_TOKEN: 'daemon-token' })
    try {
      expect((await runtime().run({ prompt: 'env:SYSTEM_MCP_TOKEN', workspace, sandbox: 'read-only' }, signal())).text).toBe('env: unset')
      expect((await runtime(true, { forwardEnv: ['SYSTEM_MCP_TOKEN'] }).run({ prompt: 'env:SYSTEM_MCP_TOKEN', workspace, sandbox: 'read-only' }, signal())).text).toBe('env: daemon-token')
    } finally {
      delete process.env.SYSTEM_MCP_TOKEN
    }
  })

  it('kills an agent that ignores both the cancel and SIGTERM, so an aborted run still ends', async () => {
    const controller = new AbortController()
    const running = runtime(true, {}, { cancelMs: 200, killMs: 300 }).run({ prompt: 'stubborn', workspace, sandbox: 'read-only' }, controller.signal)
    setTimeout(() => controller.abort(), 300)
    await expect(running).rejects.toMatchObject({ kind: 'aborted' })
  }, 10_000)

  it('cancels a running prompt when aborted, and reports it as aborted', async () => {
    const controller = new AbortController()
    const running = runtime().run({ prompt: 'hang', workspace, sandbox: 'read-only' }, controller.signal)
    setTimeout(() => controller.abort(), 500)
    await expect(running).rejects.toMatchObject({ kind: 'aborted' })
  })
})
