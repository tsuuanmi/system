import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import McpEndpoint from '@tsuuanmi/system-mcp-server'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'

describe('the CLI\'s output to a pipe', () => {
  it('writes a JSON answer past 64 KiB whole before it exits, as a reader of its pipe gets it (live, 2026-10-26)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'system-output-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    // An evidence artifact far past a pipe's 64 KiB, served by the operator's `evidence` tool.
    const envelope = { id: 'sha256:big', kind: 'evidence', bodySchema: 'test@1.0', createdAt: '2026-10-26T00:00:00.000Z', body: { lines: Array.from({ length: 3000 }, (_, i) => `${i}:${'x'.repeat(100)}`) } }
    const ctx = new Context()
    const fibers = [
      ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(Store, { path: join(home, 'system', 'system.db') }),
      ctx.plugin({ name: 'artifacts', apply: (c: Context) => void c.provide('artifacts' as never, { get: (id: string) => (id === envelope.id ? envelope : undefined) } as never) }),
      ctx.plugin(McpEndpoint, { tokenDir: join(home, 'system'), discoveryFile: join(home, 'system', 'mcp.json') }),
    ]
    await Promise.all(fibers)
    onTestFinished(async () => { for (const f of fibers.reverse()) await f.dispose() })

    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx', bin, 'evidence', envelope.id], { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    const stdout = Buffer.concat(chunks).toString('utf8')
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout.length).toBeGreaterThan(4 * 64 * 1024)
    expect(JSON.parse(stdout)).toEqual({ id: envelope.id, bodySchema: envelope.bodySchema, createdAt: envelope.createdAt, body: envelope.body })
  }, 60_000)
})
