import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { CHROME_LOCK, discoverChrome, engineChromiumMajor, installManagedChrome, managedChromePath } from '../src/chrome.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-chrome-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.unstubAllEnvs())

/** A stand-in Chrome that only answers `--version`. */
function fakeChrome(name: string, version: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\necho "Google Chrome ${version} "\n`)
  chmodSync(path, 0o755)
  return path
}

function fakeManaged(managedDir: string): string {
  const path = join(managedDir, 'chrome', `linux-${CHROME_LOCK.buildId}`, 'chrome-linux64', 'chrome')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}

describe('the pinned managed Chrome (chrome.lock.json)', () => {
  it('pins an exact Chrome for Testing build no older than the engine', () => {
    expect(CHROME_LOCK.browser).toBe('chrome')
    expect(CHROME_LOCK.buildId).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(Number(CHROME_LOCK.buildId.split('.')[0])).toBeGreaterThanOrEqual(engineChromiumMajor())
  })

  it('finds the managed build only once it is installed', () => {
    const managedDir = join(dir, 'managed-a')
    expect(managedChromePath(managedDir)).toBeUndefined()
    expect(managedChromePath(managedDir)).toBeUndefined()
    const path = fakeManaged(managedDir)
    expect(managedChromePath(managedDir)).toBe(path)
  })

  it('installs the pinned build when missing, and skips the download when present', async () => {
    const managedDir = join(dir, 'managed-b')
    const install = vi.fn(async (options: { cacheDir: string; buildId: string; browser: string }) => ({ executablePath: fakeManaged(options.cacheDir) }))
    const first = await installManagedChrome({ dir: managedDir, install })
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ browser: 'chrome', buildId: CHROME_LOCK.buildId, cacheDir: managedDir }))
    expect(first).toEqual({ path: managedChromePath(managedDir), installed: true })
    const second = await installManagedChrome({ dir: managedDir, install })
    expect(install).toHaveBeenCalledTimes(1)
    expect(second.installed).toBe(false)
  })
})

describe('installing into the harness home', () => {
  it('creates <home>/system owner-only first, so the kernel plugins still accept it', async () => {
    const home = join(dir, 'home-e2e')
    const managedDir = join(home, 'system', 'browsers')
    // The real installer creates directories with the process umask (e.g. 0775).
    const install = async (options: { cacheDir: string }) => {
      mkdirSync(options.cacheDir, { recursive: true, mode: 0o775 })
      return { executablePath: fakeManaged(options.cacheDir) }
    }
    await installManagedChrome({ dir: managedDir, install })
    expect(statSync(join(home, 'system')).mode & 0o077).toBe(0)
    expect(statSync(managedDir).mode & 0o077).toBe(0)
  })
})

describe('discoverChrome', () => {
  it('uses an explicit path and fails closed when it does not exist', () => {
    expect(() => discoverChrome('/nonexistent/chrome')).toThrow(ProviderError)
    expect(() => discoverChrome('/nonexistent/chrome')).toThrow(/does not exist/)
  })

  it('prefers CHROME_PATH, then a recent system Chrome, then the managed build', () => {
    const managedDir = join(dir, 'managed-c')
    const managed = fakeManaged(managedDir)
    const recent = fakeChrome('recent', `${engineChromiumMajor()}.0.1.2`)
    vi.stubEnv('CHROME_PATH', process.execPath)
    expect(discoverChrome(undefined, { standard: [recent], managedDir })).toEqual({ path: process.execPath, source: 'env' })
    vi.stubEnv('CHROME_PATH', '')
    expect(discoverChrome(undefined, { standard: [recent], managedDir })).toEqual({ path: recent, source: 'system' })
    expect(discoverChrome(undefined, { standard: [], managedDir })).toEqual({ path: managed, source: 'managed' })
    expect(discoverChrome(undefined, { standard: [], managedDir: join(dir, 'empty') })).toBeUndefined()
  })

  it('skips a system Chrome older than the engine (e.g. Chrome 95 on an old host)', () => {
    vi.stubEnv('CHROME_PATH', '')
    const managedDir = join(dir, 'managed-d')
    const managed = fakeManaged(managedDir)
    const old = fakeChrome('old', '95.0.4638.54')
    expect(discoverChrome(undefined, { standard: [old], managedDir })).toEqual({ path: managed, source: 'managed' })
  })
})
