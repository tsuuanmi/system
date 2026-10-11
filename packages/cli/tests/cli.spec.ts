import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_LOCK } from '@tsuuanmi/system-browser-patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureBrowser, exitCode, mergeProfileManifest, mcpConfig } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('system CLI (PR #3 kernel review)', () => {
  it('merges the bundle into an existing profile manifest without dropping operator plugins', () => {
    const merged = mergeProfileManifest({
      name: 'dsh-profile-system', dependencies: { 'operator-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['@tsuuanmi/system-bundle', 'operator-plugin'] } },
    }, '/opt/bundle')
    expect(merged.dependencies).toEqual({ 'operator-plugin': '^1.0.0', '@tsuuanmi/system-bundle': 'link:/opt/bundle' })
    expect(merged.dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle', 'operator-plugin'])
    expect(mergeProfileManifest(undefined, '/b').dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle'])
  })

  it('maps a signal death to 128 + signal number', () => {
    expect(exitCode(null, 'SIGTERM')).toBe(143)
    expect(exitCode(null, 'SIGINT')).toBe(130)
    expect(exitCode(3, null)).toBe(3)
  })

  it('never prints the bearer token inside the client configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    mkdirSync(join(home, 'system'))
    writeFileSync(join(home, 'system', 'mcp.token'), Buffer.alloc(32, 9))
    writeFileSync(join(home, 'system', 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:47317/mcp', tokenFile: join(home, 'system', 'mcp.token') }))
    const token = Buffer.alloc(32, 9).toString('base64url')
    for (const client of ['claude', 'codex'] as const) {
      const text = mcpConfig(client, home)
      expect(text).not.toContain(token)
      expect(text).toContain('SYSTEM_MCP_TOKEN')
    }
    expect(readFileSync(join(home, 'system', 'mcp.json'), 'utf8')).toContain('47317')
  })
})

describe('system init: browser prerequisites', () => {
  const chrome = { path: '/usr/bin/google-chrome', source: 'system' as const }

  it('keeps a usable Chrome and does not download one', async () => {
    const install = vi.fn()
    const report = await ensureBrowser({ discover: () => chrome, install, hasXvfb: () => true })
    expect(install).not.toHaveBeenCalled()
    expect(report).toEqual(['chrome: /usr/bin/google-chrome (system)', 'xvfb: ok'])
  })

  it('installs the pinned managed Chrome when none is usable, and flags a missing Xvfb', async () => {
    const install = vi.fn(async () => ({ path: '/home/u/.dsh/system/browsers/chrome', installed: true }))
    const report = await ensureBrowser({ discover: () => undefined, install, hasXvfb: () => false })
    expect(install).toHaveBeenCalledOnce()
    expect(report[0]).toBe(`chrome: installed managed Chrome ${CHROME_LOCK.buildId} at /home/u/.dsh/system/browsers/chrome`)
    expect(report[1]).toMatch(/xvfb: missing .*apt install xvfb/)
  })
})
