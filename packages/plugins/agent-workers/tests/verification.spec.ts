// A new lockfile's supply-chain verification (src/verification.ts, T333, D112): one approval request per
// lockfile digest for the exact argv of the verification, run once on the approval, recorded as a
// decision; a digest verified is never asked again; a denial stays; warn only records. The state machine
// runs over the real store, approval queue, and artifacts, with the verification's command itself a
// stand-in (its confined run is in checks.spec.ts, under bubblewrap).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it } from 'vitest'
import { lockfileVerificationOnly, verificationArgv, verificationProblems } from '../src/dependencies.ts'
import AgentWorkers from '../src/index.ts'
import { loadSetups } from '../src/setup.ts'
import { LockfileVerifications } from '../src/verification.ts'

type VerificationRequest = Parameters<LockfileVerifications['resolve']>[1]

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const policy: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'command', mode: 'ask' }, { actionClass: 'merge', mode: 'ask' }],
  default: 'ask', commands: [], expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-verification-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(StoreApprovals, { policies: [policy] }), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, { workers: [], worktreeRoot: join(dir, 'worktrees') }),
  ]
  await Promise.all(fibers)
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx, verifications: new LockfileVerifications(ctx) }
}

const request = (digest: string, overrides: Partial<VerificationRequest> = {}): VerificationRequest => ({
  repository: '/repo', key: 'repo-key', digest, argv: ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'], line: 'corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile',
  config: { registry: 'https://registry.example.test/', cacheDir: '/cache' }, workflowRunId: 'run_1', worktree: '/worktrees/run_1', classification: 'operator-shared', timeoutSeconds: 600, ...overrides,
})

const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER = `sha256:${'b'.repeat(64)}`
const decisions = (ctx: Context) => ctx.artifacts.list({ kind: 'decision', decisionType: 'gate' }).filter((a) => (a.body as { decider?: { id?: string } }).decider?.id === 'agent-workers.lockfile-verification')
  .map((a) => (a.body as { outcome: { option: string; detail: Record<string, unknown> } }).outcome)

describe('a lockfile\'s verification', () => {
  it('asks once per digest, for the exact argv with its registry named; runs it once on the approval; asks nothing again for a digest verified (INV-12, INV-13)', async () => {
    const { ctx, verifications } = await boot()
    let ran = 0
    const execute = async () => {
      ran++
      return { ok: true, detail: '' }
    }
    const waits = await verifications.resolve('on', request(DIGEST), execute)
    expect(waits).toMatchObject({ state: 'waits', requestId: expect.any(String) })
    const [asked] = await ctx.approvals.list()
    expect(asked).toMatchObject({
      state: 'open', subject: { type: 'content', ref: `lockfile-verification:repo-key/${DIGEST}`, version: expect.stringMatching(/^sha256:/) },
      action: { class: 'command', summary: expect.stringContaining('corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile'), consequences: expect.stringContaining('meant to reach https://registry.example.test/ only') },
    })
    // It says what it cannot hold: the host's network is shared while it runs.
    expect(asked!.action.consequences).toContain('the command shares the host\'s network while it runs')
    expect(asked!.action.consequences).not.toMatch(/no other network/)
    // While it is open: the same request, nothing new, nothing run.
    expect(await verifications.resolve('on', request(DIGEST), execute)).toEqual({ state: 'waits', requestId: asked!.requestId })
    expect(await ctx.approvals.list()).toHaveLength(1)
    expect(ran).toBe(0)

    await ctx.approvals.decide([{ requestId: asked!.requestId, subject: asked!.subject, verdict: 'approved' }])
    const [first, second] = await Promise.all([verifications.resolve('on', request(DIGEST), execute), verifications.resolve('on', request(DIGEST), execute)])
    // Used once: one run, whichever asked first; the other finds it verified.
    expect(ran).toBe(1)
    expect([first, second].map((v) => v.state).sort()).toEqual(['already', 'verified'])
    expect(decisions(ctx)).toMatchObject([{ option: 'verify', detail: { digest: DIGEST, requestId: asked!.requestId, registry: 'https://registry.example.test/', cacheDir: '/cache', ok: true } }])
    // Never asked again, from another worktree or run.
    expect(await verifications.resolve('on', request(DIGEST, { workflowRunId: 'run_2', worktree: '/worktrees/run_2' }), execute)).toMatchObject({ state: 'already' })
    expect(await ctx.approvals.list({ states: ['open', 'approved', 'rejected'] })).toHaveLength(1)
    // Another digest is asked about.
    expect(await verifications.resolve('on', request(OTHER), execute)).toMatchObject({ state: 'waits' })
    expect(await ctx.approvals.list({ states: ['open', 'approved'] })).toHaveLength(2)
    expect(ran).toBe(1)
  })

  it('asks one request for a digest that results in two worktrees both wait on, and its one approval verifies it for both: neither replaces the other\'s request (INV-5)', async () => {
    const { ctx, verifications } = await boot()
    const ran: string[] = []
    const execute = (what: string) => async () => {
      ran.push(what)
      return { ok: true, detail: '' }
    }
    const a = request(DIGEST)
    const b = request(DIGEST, { worktree: '/worktrees/run_2', workflowRunId: 'run_2' })
    // A asks, then B, then A again, then B again, all while the request is open: one request, both wait on it.
    const waits = [await verifications.resolve('on', a, execute('a')), await verifications.resolve('on', b, execute('b')), await verifications.resolve('on', a, execute('a')), await verifications.resolve('on', b, execute('b'))]
    const [asked] = await ctx.approvals.list()
    expect(await ctx.approvals.list({ states: ['open', 'approved', 'rejected'] })).toHaveLength(1)
    expect(waits).toEqual(Array.from({ length: 4 }, () => ({ state: 'waits', requestId: asked!.requestId })))
    // Approved: the first of them checked after it runs it, once; the other finds the digest verified.
    await ctx.approvals.decide([{ requestId: asked!.requestId, subject: asked!.subject, verdict: 'approved' }])
    expect(await verifications.resolve('on', b, execute('b'))).toMatchObject({ state: 'verified' })
    expect(await verifications.resolve('on', a, execute('a'))).toMatchObject({ state: 'already' })
    expect(ran).toEqual(['b'])
    expect(await ctx.approvals.list({ states: ['open', 'approved', 'rejected'] })).toHaveLength(1)
  })

  it('binds an approval to the exact execution it was asked for: another argv, registry, cache, or deadline for the same digest never runs on it, and is asked about anew (INV-5)', async () => {
    const { ctx, verifications } = await boot()
    const ran: string[] = []
    const execute = (what: string) => async () => {
      ran.push(what)
      return { ok: true, detail: '' }
    }
    await verifications.resolve('on', request(DIGEST), execute('asked'))
    const [asked] = await ctx.approvals.list()
    // The subject's version is the execution's own id: the digest alone is never what is approved.
    expect(asked!.subject.version).not.toBe(DIGEST)
    await ctx.approvals.decide([{ requestId: asked!.requestId, subject: asked!.subject, verdict: 'approved' }])
    const others: Array<[string, Partial<VerificationRequest>]> = [
      ['argv', { argv: ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--prefer-offline'] }],
      ['registry', { config: { registry: 'https://elsewhere.example.test/', cacheDir: '/cache' } }],
      ['cache', { config: { registry: 'https://registry.example.test/', cacheDir: '/other-cache' } }],
      ['deadline', { timeoutSeconds: 3600 }],
    ]
    for (const [what, changed] of others) {
      const outcome = await verifications.resolve('on', request(DIGEST, changed), execute(what))
      // Not run on the approval given for the other execution: a request of its own is opened instead.
      expect(outcome, what).toMatchObject({ state: 'waits' })
      expect((outcome as { requestId: string }).requestId, what).not.toBe(asked!.requestId)
    }
    expect(ran).toEqual([])
    // Each new request names its own execution; approving the last one runs exactly that one.
    const open = await ctx.approvals.list({ states: ['open'] })
    expect(new Set(open.map((r) => r.subject.version)).size).toBe(others.length)
    const last = open.at(-1)!
    await ctx.approvals.decide([{ requestId: last.requestId, subject: last.subject, verdict: 'approved' }])
    expect(await verifications.resolve('on', request(DIGEST, others.at(-1)![1]), execute('deadline'))).toMatchObject({ state: 'verified' })
    expect(ran).toEqual(['deadline'])
  })

  it('keeps a rejected digest denied, naming the request, and runs nothing; one that ran and failed stays failed (INV-2)', async () => {
    const { ctx, verifications } = await boot()
    const execute = async () => ({ ok: false, detail: 'exited with code 1' })
    await verifications.resolve('on', request(DIGEST), execute)
    const [asked] = await ctx.approvals.list()
    await ctx.approvals.decide([{ requestId: asked!.requestId, subject: asked!.subject, verdict: 'rejected' }])
    const denied = await verifications.resolve('on', request(DIGEST), execute)
    expect(denied).toMatchObject({ state: 'denied', requestId: asked!.requestId, reason: expect.stringContaining('rejected by the operator') })
    expect(await verifications.resolve('on', request(DIGEST), execute)).toMatchObject({ state: 'denied', requestId: asked!.requestId })
    expect(await ctx.approvals.list({ states: ['open', 'approved', 'rejected'] })).toHaveLength(1)
    expect(decisions(ctx).map((d) => d.option)).toEqual(['deny'])

    await verifications.resolve('on', request(OTHER), execute)
    const [next] = await ctx.approvals.list({ states: ['open'] })
    await ctx.approvals.decide([{ requestId: next!.requestId, subject: next!.subject, verdict: 'approved' }])
    expect(await verifications.resolve('on', request(OTHER), execute)).toMatchObject({ state: 'failed', reason: expect.stringContaining('exited with code 1') })
    expect(await verifications.resolve('on', request(OTHER), execute)).toMatchObject({ state: 'failed' })
    expect(decisions(ctx).map((d) => d.option).sort()).toEqual(['deny', 'fail'])
  })

  it('in warn records the request it would open, once per digest, and opens none and runs nothing (D108)', async () => {
    const { ctx, verifications } = await boot()
    let ran = 0
    const execute = async () => {
      ran++
      return { ok: true, detail: '' }
    }
    for (let i = 0; i < 2; i++) expect(await verifications.resolve('warn', request(DIGEST), execute)).toMatchObject({ state: 'warned', decision: expect.stringMatching(/^sha256:/) })
    expect(await ctx.approvals.list({ states: ['open', 'approved', 'rejected'] })).toEqual([])
    expect(ran).toBe(0)
    expect(decisions(ctx)).toMatchObject([{ option: 'warn', detail: { mode: 'warn', registry: 'https://registry.example.test/', command: 'corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile' } }])
    // Turned on, the digest warned about is asked about.
    expect(await verifications.resolve('on', request(DIGEST), execute)).toMatchObject({ state: 'waits' })
  })
})

describe('what a lockfile verification needs', () => {
  it('reads only missing registry metadata as its cause, never a missing package or an unreachable registry', () => {
    const meta = ' ERR_PNPM_NO_OFFLINE_META  Failed to resolve @openai/codex-sdk@0.1.0 in package mirror /cache/metadata-full/registry.npmjs.org/@openai/codex-sdk.json'
    expect(lockfileVerificationOnly(meta)).toBe(true)
    expect(lockfileVerificationOnly(`${meta}\n ERR_PNPM_NO_OFFLINE_TARBALL  A package is missing. The missing package may be downloaded from https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz.`)).toBe(false)
    expect(lockfileVerificationOnly('ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/left-pad: no network')).toBe(false)
    expect(lockfileVerificationOnly('exited with code 1')).toBe(false)
  })

  it('runs online only pnpm\'s own frozen install: never a script, another program, a path, another pnpm command, or an option it does not know, whatever flags it carries (INV-12)', () => {
    // The live setup's install: the verification is it, not offline, with the result's scripts and pnpmfile off.
    expect(verificationArgv(['corepack', 'pnpm', 'install', '--frozen-lockfile', '--offline', '--store-dir=/home/me/.local/share/pnpm/store/v11', '--package-import-method=copy']))
      .toEqual(['corepack', 'pnpm', 'install', '--frozen-lockfile', '--store-dir=/home/me/.local/share/pnpm/store/v11', '--package-import-method=copy', '--ignore-scripts', '--ignore-pnpmfile'])
    expect(verificationArgv(['pnpm', 'i', '--frozen-lockfile'])).toEqual(['pnpm', 'i', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'])
    for (const argv of [
      ['node', 'verify.mjs', '--frozen-lockfile', '--offline'], // a script the result can change
      ['sh', '-c', 'pnpm install --frozen-lockfile'],
      ['./node_modules/.bin/pnpm', 'install', '--frozen-lockfile'], // a path, which may be the result's own file
      ['/usr/bin/pnpm', 'install', '--frozen-lockfile'],
      ['npx', 'pnpm', 'install', '--frozen-lockfile'],
      ['pnpm', 'exec', 'node', 'x.js', '--frozen-lockfile'], // another pnpm command
      ['pnpm', 'run', 'install', '--frozen-lockfile'],
      ['corepack', 'pnpm', 'install', '--offline'], // not frozen
      ['pnpm', 'install', '--frozen-lockfile', '--registry=https://elsewhere.example.test/'], // an option that names a host
      ['pnpm', 'install', '--frozen-lockfile', '--config.registry=https://elsewhere.example.test/'],
      ['pnpm', 'install', '--frozen-lockfile', '--pnpmfile=hooks.cjs'],
      ['pnpm', 'install', '--frozen-lockfile', '--dir=../other'],
      ['pnpm', 'install', '--frozen-lockfile', '-C', '../other'],
      ['pnpm', 'install', '--frozen-lockfile', 'left-pad'], // a package to add
      ['pnpm', 'install', '--frozen-lockfile', '--store-dir=relative/store'],
      ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts=false'],
    ]) expect(verificationArgv(argv), argv.join(' ')).toBeUndefined()
  })

  it('finds every file of the result that would send the online install past the registry: another or a scoped registry, a host setting, a proxy, a pnpmfile, a lockfile source elsewhere (INV-12)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-verification-scan-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const registry = 'https://registry.example.test/'
    const scan = (files: Record<string, string>): string[] => {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true })
        writeFileSync(join(dir, name), text)
      }
      const found = verificationProblems(dir, Object.fromEntries(Object.keys(files).map((f) => [f, 'sha256:x'])), registry)
      for (const name of Object.keys(files)) rmSync(join(dir, name), { force: true })
      return found
    }
    // The system repository's own kind of files: nothing past the registry.
    expect(scan({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\nallowBuilds:\n  esbuild: true\noverrides:\n  zod: ^4.6.6\n', 'pnpm-lock.yaml': "packages:\n  zod@4.6.6:\n    resolution: {integrity: sha512-x}\n  left-pad@1.3.0:\n    resolution: {tarball: https://registry.example.test/left-pad/-/left-pad-1.3.0.tgz}\n", '.npmrc': `registry=${registry}\n# a comment\nsave-exact=true\n` })).toEqual([])
    expect(scan({ '.npmrc': '@x:registry=https://elsewhere.example.test/\n' })).toEqual(['.npmrc sets @x:registry'])
    expect(scan({ '.npmrc': 'registry=https://elsewhere.example.test/\n' })).toEqual(['.npmrc sets registry to https://elsewhere.example.test/'])
    expect(scan({ '.npmrc': '//elsewhere.example.test/:_authToken=x\nhttps-proxy=http://proxy.example.test\npnpmfile=hooks.cjs\n' })).toEqual(['.npmrc sets //elsewhere.example.test/:_authToken', '.npmrc sets https-proxy', '.npmrc sets pnpmfile'])
    expect(scan({ 'packages/a/.npmrc': 'strict-ssl=false\n' })).toEqual(['packages/a/.npmrc sets strict-ssl'])
    expect(scan({ 'pnpm-workspace.yaml': 'packages: []\nregistries:\n  default: https://elsewhere.example.test/\n' })).toEqual(['pnpm-workspace.yaml sets registries'])
    expect(scan({ 'pnpm-lock.yaml': 'packages:\n  x@1.0.0:\n    resolution: {tarball: https://elsewhere.example.test/x.tgz}\n' })).toEqual(['pnpm-lock.yaml names a URL off the registry (https://elsewhere.example.test/x.tgz)', 'pnpm-lock.yaml names a tarball off the registry (https://elsewhere.example.test/x.tgz)'])
    expect(scan({ 'pnpm-lock.yaml': 'packages:\n  y@git+https://g.example.test/y.git:\n    resolution: {commit: abc, repo: https://g.example.test/y.git, type: git}\n' })).toEqual(expect.arrayContaining(['pnpm-lock.yaml names a git host\'s source', 'pnpm-lock.yaml holds a resolution with commit, not a registry package\'s']))
    // The root's files are read even when the dependency files name none of them.
    writeFileSync(join(dir, '.npmrc'), 'proxy=http://proxy.example.test\n')
    expect(verificationProblems(dir, {}, registry)).toEqual(['.npmrc sets proxy'])
    rmSync(join(dir, '.npmrc'))
  })

  it('reads against allowlists, so an unusual but valid spelling refuses the verification rather than passing it: spaces before a YAML colon, a flow mapping, quoted keys, an .npmrc name in capitals or with _, a section, a url: resolution (INV-2, INV-12)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-verification-spelling-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const registry = 'https://registry.example.test/'
    const scan = (name: string, text: string): string[] => {
      writeFileSync(join(dir, name), text)
      const found = verificationProblems(dir, { [name]: 'sha256:x' }, registry)
      rmSync(join(dir, name))
      return found
    }
    // pnpm-workspace.yaml: a space before the colon, a quoted key, a flow mapping, a document marker, a complex key, an unknown key.
    expect(scan('pnpm-workspace.yaml', 'packages: []\nregistry : https://evil.example.test/\n')).toEqual(['pnpm-workspace.yaml sets registry'])
    expect(scan('pnpm-workspace.yaml', 'httpsProxy : http://evil.example.test:8080\n')).toEqual(['pnpm-workspace.yaml sets httpsProxy'])
    expect(scan('pnpm-workspace.yaml', "'strictSsl' : false\n")).toEqual(['pnpm-workspace.yaml sets strictSsl'])
    expect(scan('pnpm-workspace.yaml', '{registry: https://evil.example.test/, packages: []}\n')).toEqual([expect.stringContaining('pnpm-workspace.yaml has a top-level line this scan does not read as a plain key')])
    expect(scan('pnpm-workspace.yaml', '---\npackages: []\n')).toEqual([expect.stringContaining('does not read as a plain key (---)')])
    expect(scan('pnpm-workspace.yaml', '? registry\n: https://evil.example.test/\n')).toHaveLength(2)
    expect(scan('pnpm-workspace.yaml', 'minimumReleaseAge: 0\n')).toEqual(['pnpm-workspace.yaml sets minimumReleaseAge'])
    // .npmrc: names pnpm reads case-blind and with _ for -, quoted names, sections, and the registry with a variable.
    expect(scan('.npmrc', 'HTTPS_PROXY=http://evil.example.test\n')).toEqual(['.npmrc sets HTTPS_PROXY'])
    expect(scan('.npmrc', 'https_proxy = http://evil.example.test\n')).toEqual(['.npmrc sets https_proxy'])
    expect(scan('.npmrc', 'REGISTRY=https://evil.example.test/\n')).toEqual(['.npmrc sets registry to https://evil.example.test/'])
    expect(scan('.npmrc', '"registry" = "https://evil.example.test/"\n')).toEqual(['.npmrc sets registry to https://evil.example.test/'])
    expect(scan('.npmrc', 'registry=${EVIL}\n')).toEqual(['.npmrc sets registry to ${EVIL}'])
    expect(scan('.npmrc', '[x]\nregistry=https://registry.example.test/\n')).toEqual(['.npmrc opens a section ([x])'])
    expect(scan('.npmrc', 'Save_Exact=true\nauto-install-peers=true\n')).toEqual([])
    // The lockfile: a runtime's url: resolution, a resolution in block form, a git host shorthand.
    expect(scan('pnpm-lock.yaml', 'packages:\n  node@runtime:22.0.0:\n    resolution: {url: https://nodejs.org/dist/v22.0.0/node.tar.gz, integrity: sha256-x, type: binary}\n')).toEqual(expect.arrayContaining([
      'pnpm-lock.yaml names a URL off the registry (https://nodejs.org/dist/v22.0.0/node.tar.gz)', 'pnpm-lock.yaml holds a resolution with url, not a registry package\'s',
    ]))
    expect(scan('pnpm-lock.yaml', 'packages:\n  z@1.0.0:\n    resolution:\n      integrity: sha512-x\n')).toEqual([expect.stringContaining('holds a resolution this scan does not read')])
    expect(scan('pnpm-lock.yaml', "importers:\n  .:\n    dependencies:\n      z:\n        specifier: github:evil/z\n")).toEqual(['pnpm-lock.yaml names a git host\'s source'])
    expect(scan('pnpm-lock.yaml', 'packages:\n  local@file:../x:\n    resolution: {directory: ../x, type: directory}\n  simple-git@3.0.0:\n    resolution: {integrity: sha512-x}\n')).toEqual([])
  })

  it('reads no line shape this scan does not read as pnpm does: an indented root mapping, a bare carriage return, a quoted or JSON resolution, an anchor (INV-2, INV-12)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-verification-shape-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const registry = 'https://registry.example.test/'
    const scan = (name: string, text: string): string[] => {
      writeFileSync(join(dir, name), text)
      const found = verificationProblems(dir, { [name]: 'sha256:x' }, registry)
      rmSync(join(dir, name))
      return found
    }
    // YAML lets the root mapping itself be indented: every key of it would go unread.
    expect(scan('pnpm-workspace.yaml', '  registry: https://evil.example.test/\n  packages: []\n')).toEqual([expect.stringContaining('pnpm-workspace.yaml indents its first key')])
    expect(scan('pnpm-workspace.yaml', '# a comment first\n  httpsProxy: http://evil.example.test:8080\n')).toEqual([expect.stringContaining('indents its first key')])
    // Indented lines under an allowed top-level key are its value, as before.
    expect(scan('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\noverrides:\n  zod: ^4.6.6\n')).toEqual([])
    // A bare CR ends a line for pnpm's ini reader and for YAML: it hides nothing inside an allowed key's value.
    expect(scan('.npmrc', 'save-exact=true\rregistry=https://evil.example.test/\rhttps-proxy=http://evil.example.test:8080\n')).toEqual([expect.stringContaining('.npmrc ends a line with a bare carriage return')])
    expect(scan('pnpm-workspace.yaml', 'packages: []\rregistry: https://evil.example.test/\n')).toEqual([expect.stringContaining('pnpm-workspace.yaml ends a line with a bare carriage return')])
    expect(scan('pnpm-lock.yaml', 'packages:\r  x@1.0.0:\r    resolution: {integrity: sha512-x}\n')).toEqual([expect.stringContaining('pnpm-lock.yaml ends a line with a bare carriage return')])
    // Windows line ends (CRLF) are read as lines, as pnpm reads them.
    expect(scan('.npmrc', 'save-exact=true\r\nauto-install-peers=true\r\n')).toEqual([])
    // A resolution key quoted, or the lockfile written as JSON, is still read; an anchor, a complex key, or an escape is refused.
    expect(scan('pnpm-lock.yaml', "packages:\n  x@1.0.0:\n    'resolution': {url: https://registry.example.test/x.tgz, type: binary}\n")).toEqual(['pnpm-lock.yaml holds a resolution with url, not a registry package\'s'])
    expect(scan('pnpm-lock.yaml', '{"packages":{"x@1.0.0":{"resolution":{"url":"https://registry.example.test/x.tgz","type":"binary"}}}}\n')).toEqual([expect.stringContaining('pnpm-lock.yaml holds a resolution this scan does not read')])
    expect(scan('pnpm-lock.yaml', 'a: &r {integrity: sha512-x}\npackages:\n  x@1.0.0:\n    resolution: *r\n')).toEqual(expect.arrayContaining(['pnpm-lock.yaml holds an anchor, an alias, or a tag']))
    expect(scan('pnpm-lock.yaml', 'packages:\n  x@1.0.0:\n    ? resolution\n    : {url: https://registry.example.test/x.tgz}\n')).toEqual(expect.arrayContaining(['pnpm-lock.yaml holds a complex key']))
    expect(scan('pnpm-lock.yaml', 'packages:\n  x@1.0.0:\n    "resol\\u0075tion": {url: https://registry.example.test/x.tgz}\n')).toEqual(expect.arrayContaining(['pnpm-lock.yaml holds an escape in a quoted string']))
  })

  it('passes the system repository\'s own .npmrc, pnpm-workspace.yaml, and lockfile against the npm registry: the allowlists hold for a real workspace', () => {
    const root = join(import.meta.dirname, '../../../..')
    expect(verificationProblems(root, {}, 'https://registry.npmjs.org/')).toEqual([])
  })

  it('loads a setup\'s registry and cache directory checked: an https registry without credentials, an absolute cache directory', () => {
    const load = (lockfileVerification: unknown) => loadSetups([{ repository: '/repo', commands: ['true'], lockfileVerification } as never], ['/repo'])
    expect(load({ registry: 'https://registry.npmjs.org/', cacheDir: '/home/me/.cache/pnpm' }).get('/repo')!.lockfileVerification).toEqual({ registry: 'https://registry.npmjs.org/', cacheDir: '/home/me/.cache/pnpm' })
    expect(load({}).get('/repo')!.lockfileVerification).toBeUndefined()
    expect(() => load({ registry: 'http://registry.example.test/', cacheDir: '/cache' })).toThrow(/must be an https:\/\/ URL/)
    // A registry URL with a user and a password, built here so no credential-shaped literal is in the source (check:secrets).
    const withCredentials = `https://${['user', 'pass'].join(':')}@registry.example.test/`
    expect(() => load({ registry: withCredentials, cacheDir: '/cache' })).toThrow(/no credentials/)
    expect(() => load({ registry: 'https://registry.example.test/', cacheDir: 'cache' })).toThrow(/absolute, normalized path/)
    expect(() => load({ registry: 'https://registry.example.test/', cacheDir: '/' })).toThrow(/not the root/)
  })
})
