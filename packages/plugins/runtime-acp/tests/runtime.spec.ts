import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { AcpAgentRuntime } from '../src/index.ts'

const SCRIPTED = fileURLToPath(new URL('./fixtures/scripted-agent.mjs', import.meta.url))
const runtime = (honoursPermissions = true) => new AcpAgentRuntime({ name: 'scripted', command: process.execPath, args: [SCRIPTED], honoursPermissions })

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
      available: true, detail: 'ACP agent scripted 1.0.0 (protocol 1)', version: '1.0.0', sandboxes: ['read-only'], resume: true, executes: false,
    })
    // An agent can act on its own without asking; unvouched, it is never trusted with a policy.
    expect(await runtime(false).probe()).toMatchObject({ available: true, sandboxes: [] })
    await expect(runtime(false).run({ prompt: 'x', workspace, sandbox: 'read-only' }, signal())).rejects.toMatchObject({ kind: 'config_error' })
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

  it('refuses what ACP cannot express exactly: tool lists, a model, a turn limit', async () => {
    for (const extra of [{ tools: ['Read'] }, { model: 'm' }, { maxTurns: 3 }]) {
      await expect(runtime().run({ prompt: 'x', workspace, sandbox: 'read-only', ...extra }, signal())).rejects.toMatchObject({ kind: 'config_error' })
    }
  })

  it('continues a session by its id (loadSession)', async () => {
    const result = await runtime().run({ prompt: 'again', workspace, sandbox: 'read-only', resume: 'h-1' }, signal())
    expect(result).toMatchObject({ text: 'echo: again', nativeHandle: 'h-1' })
  })

  it('cancels a running prompt when aborted, and reports it as aborted', async () => {
    const controller = new AbortController()
    const running = runtime().run({ prompt: 'hang', workspace, sandbox: 'read-only' }, controller.signal)
    setTimeout(() => controller.abort(), 500)
    await expect(running).rejects.toMatchObject({ kind: 'aborted' })
  })
})
