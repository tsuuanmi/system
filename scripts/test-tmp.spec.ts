import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stopUnder, sweepStale } from './test-tmp.ts'

describe('test temporary parents', () => {
  it('runs this file under its run\'s own parent', () => {
    expect(tmpdir()).toMatch(/\/system-test-\d+-[^/]+$/)
  })

  it('removes only the parents of runs that are gone, and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'))
    try {
      for (const name of ['system-test-111-aaa', 'system-test-222-bbb', 'system-other', 'system-test-x-ccc']) mkdirSync(join(root, name))
      const stopped: string[] = []
      expect(sweepStale(root, (pid) => pid === 222, (parent) => stopped.push(parent))).toEqual(['system-test-111-aaa'])
      // The gone run's leftover processes are stopped with its parent.
      expect(stopped).toEqual([join(root, 'system-test-111-aaa')])
      expect(['system-test-111-aaa', 'system-test-222-bbb', 'system-other', 'system-test-x-ccc'].map((n) => existsSync(join(root, n)))).toEqual([false, true, true, true])
      // One that cannot be removed (a mount point, in a nested confinement) is left, and the sweep goes on.
      mkdirSync(join(root, 'system-test-333-ddd'))
      mkdirSync(join(root, 'system-test-444-eee'))
      const busy = (parent: string): void => {
        if (parent.endsWith('333-ddd')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        rmSync(parent, { recursive: true, force: true })
      }
      expect(sweepStale(root, (pid) => pid === 222, () => undefined, busy)).toEqual(['system-test-444-eee'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'linux')('stops the processes that name a path under a parent, and no other', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'run-'))
    const sleeper = (path: string) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', path], { stdio: 'ignore' })
    const inside = sleeper(join(parent, 'system-xauth-x', 'Xauthority'))
    const outside = sleeper(`${parent}-other/file`)
    try {
      const exited = new Promise((resolve) => inside.once('exit', (_code, signal) => resolve(signal)))
      expect(stopUnder(parent)).toEqual([inside.pid])
      expect(await exited).toBe('SIGKILL')
      expect(outside.exitCode).toBeNull()
    } finally {
      inside.kill('SIGKILL')
      outside.kill('SIGKILL')
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
