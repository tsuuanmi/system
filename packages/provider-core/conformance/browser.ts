/** Conformance suite for `ctx.browser` (plugin rule 7), over a local HTTP origin. */
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '../src/browser.ts'
import type { Boot } from './display.ts'

/** The engine-neutral page operations the suite needs, supplied by the provider's test. */
export interface PageProbe {
  goto(page: unknown, url: string): Promise<void>
  /** Runs in the page: `document.cookie`, `localStorage.length`, `visibilityState`. */
  read(page: unknown): Promise<{ cookie: string; storage: number; visibility: string }>
  setStorage(page: unknown, key: string, value: string): Promise<void>
}

export function browserConformance(name: string, boot: Boot, probe: PageProbe): void {
  describe(`ctx.browser conformance: ${name}`, () => {
    let server: Server
    let origin = ''
    beforeAll(async () => {
      server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>ok</p>'))
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })
    afterAll(() => new Promise<void>((done) => server.close(() => done())))

    it('opens visible, isolated turns built from portable state', async () => {
      const { ctx, dispose } = await boot()
      try {
        const host = new URL(origin).hostname
        const state = { origins: [origin], capturedAt: '2026-10-12T00:00:00Z', cookies: [{ name: 's', value: '1', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }] }
        const a = await ctx.browser.openTurn('acct', { state })
        await probe.goto(a.page, `${origin}/`)
        expect(await probe.read(a.page)).toMatchObject({ cookie: 's=1', visibility: 'visible' })
        const b = await ctx.browser.openTurn('acct')
        await probe.goto(b.page, `${origin}/`)
        expect((await probe.read(b.page)).cookie).toBe('')
        await Promise.all([a.close(), b.close()])
        expect(ctx.browser.openAccounts()).toContain('acct')
        await ctx.browser.close('acct')
        expect(ctx.browser.openAccounts()).not.toContain('acct')
      } finally {
        await dispose()
      }
    }, 60_000)

    it('captures state for the requested origins only', async () => {
      const { ctx, dispose } = await boot()
      try {
        const turn = await ctx.browser.openTurn('acct')
        await probe.goto(turn.page, `${origin}/`)
        await probe.setStorage(turn.page, 'k', 'v')
        const captured = await ctx.browser.capture(turn, { origins: [origin] })
        expect(captured.origins).toEqual([origin])
        expect(JSON.stringify(captured.localStorage)).toContain('"k"')
        const elsewhere = await ctx.browser.capture(turn, { origins: ['https://other.example'] })
        expect(elsewhere.localStorage ?? []).toEqual([])
        await turn.close()
      } finally {
        await dispose()
      }
    }, 60_000)

    it('opens profile turns as pages of one persistent context, kept across reopen, and refuses them while reserved (ADR-0030)', async () => {
      const { ctx, dispose } = await boot()
      const dir = mkdtempSync(join(tmpdir(), 'system-conformance-profile-'))
      try {
        const a = await ctx.browser.openTurn('acct', { profile: { dir } })
        const b = await ctx.browser.openTurn('acct', { profile: { dir } })
        await probe.goto(a.page, `${origin}/`)
        await probe.setStorage(a.page, 'k', 'v')
        await probe.goto(b.page, `${origin}/`)
        expect((await probe.read(b.page)).storage).toBe(1)
        await Promise.all([a.close(), b.close()])
        await ctx.browser.close('acct')
        // The profile keeps what its pages stored; a fresh context from no state has none of it.
        const again = await ctx.browser.openTurn('acct', { profile: { dir } })
        await probe.goto(again.page, `${origin}/`)
        expect((await probe.read(again.page)).storage).toBe(1)
        await expect(ctx.browser.reserveProfile('acct', dir)).rejects.toMatchObject({ kind: 'overloaded' })
        await again.close()
        const release = await ctx.browser.reserveProfile('acct', dir)
        await expect(ctx.browser.openTurn('acct', { profile: { dir } })).rejects.toMatchObject({ kind: 'overloaded' })
        release()
        const fresh = await ctx.browser.openTurn('acct')
        await probe.goto(fresh.page, `${origin}/`)
        expect((await probe.read(fresh.page)).storage).toBe(0)
        await fresh.close()
      } finally {
        await dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 90_000)

    it('keeps a session\'s profile page on close and hands it back; discard and discardTab close it for good (ADR-0030)', async () => {
      const { ctx, dispose } = await boot()
      const dir = mkdtempSync(join(tmpdir(), 'system-conformance-kept-'))
      try {
        const first = await ctx.browser.openTurn('acct', { profile: { dir, keep: 's1' } })
        expect(first.reused).toBe(false)
        await probe.goto(first.page, `${origin}/`)
        await first.close()
        expect(ctx.browser.profileStates()).toEqual([expect.objectContaining({ account: 'acct', kept: 1, pages: 0 })])
        const again = await ctx.browser.openTurn('acct', { profile: { dir, keep: 's1' } })
        expect(again.reused).toBe(true)
        expect(again.page).toBe(first.page)
        await again.discard!()
        expect(ctx.browser.profileStates()).toEqual([expect.objectContaining({ kept: 0 })])
        const other = await ctx.browser.openTurn('acct', { profile: { dir, keep: 's2' } })
        await other.close()
        await ctx.browser.discardTab('acct', 's2')
        expect(ctx.browser.profileStates()).toEqual([expect.objectContaining({ kept: 0 })])
      } finally {
        await dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 90_000)

    it('names the executable it launches', async () => {
      const { ctx, dispose } = await boot()
      try {
        expect(ctx.browser.executablePath()).toBeTruthy()
      } finally {
        await dispose()
      }
    })
  })
}

export type { Context }
