import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { globMatches, globProblem, isPrivateAddress, pinnedTo, selectFiles, SnapshotError, snapshotRepository } from '../src/index.ts'
// The test seams are this package's own: imported from source, never through its exports.
import { snapshotWithTestSeams } from '../src/repositories.ts'

/** A repository served over file://, allowing the partial fetch a public host allows. */
function repository(files: Record<string, string | Buffer>): { url: string; head: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'system-repo-src-'))
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('tag', '-a', 'v1', '-m', 'v1')
  git('config', 'uploadpack.allowFilter', 'true')
  git('config', 'uploadpack.allowAnySHA1InWant', 'true')
  return { url: `file://${dir}`, head: git('rev-parse', 'HEAD'), dir }
}

const local = { allowLocal: true }
const leftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('system-repo-') && !n.startsWith('system-repo-src-'))

describe('snapshotRepository: a public repository read at one commit (PROP-0004 Phase 4, INV-9)', () => {
  let repo: ReturnType<typeof repository>
  beforeAll(() => {
    repo = repository({
      'README.md': '# Demo\n',
      'package.json': JSON.stringify({ name: 'demo', main: './src/server.ts' }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'src/server.ts': 'export const port = 8080\n',
      'src/auth/session.ts': 'export function login() {}\n',
      'src/auth/session.test.ts': 'test("login", () => {})\n',
      'src/util.ts': 'export const x = 1\n',
      'docs/big.md': 'x'.repeat(60_000),
      'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
      'node_modules/dep/index.js': 'module.exports = 1\n',
      'notes/ünïcode name.md': 'unicode path\n',
    })
  })
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }))

  it('pins the commit, reads the chosen files in order, and lists every other file with why', async () => {
    const before = leftovers()
    const snapshot = await snapshotWithTestSeams({ url: repo.url, terms: ['session', 'auth', 'session'] }, {}, undefined, local)
    expect(snapshot).toMatchObject({ commit: repo.head, pinnedBy: 'ref' })
    expect(snapshot.files.map((f) => f.path)).toEqual(['README.md', 'package.json', 'src/server.ts', 'src/auth/session.ts', 'src/auth/session.test.ts'])
    expect(snapshot.files[2]).toMatchObject({ text: 'export const port = 8080\n', bytes: 25, sha: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(Object.fromEntries(snapshot.unread.map((u) => [u.path, u.why]))).toEqual({
      'pnpm-lock.yaml': 'lockfile', 'src/util.ts': 'not-selected', 'docs/big.md': 'not-selected', 'assets/logo.png': 'not-selected', 'node_modules/dep/index.js': 'not-selected',
      // ls-tree -z: a non-ASCII path stays as it is, never C-quoted.
      'notes/ünïcode name.md': 'not-selected',
    })
    // Nothing is left behind.
    expect(leftovers()).toEqual(before)
  })

  it('reads a tag at its commit, and keeps within the file, byte, and size bounds; a blob over the per-file bound is not downloaded', async () => {
    const tagged = await snapshotWithTestSeams({ url: repo.url, ref: 'v1', focus: ['docs/**', 'assets/*'] }, { maxFiles: 3 }, undefined, local)
    expect(tagged.commit).toBe(repo.head)
    // The focus first: its large file is never downloaded, its image takes a slot and is no text;
    // then the README and the manifest reach the bound before the entry point.
    expect(tagged.files.map((f) => f.path)).toEqual(['README.md', 'package.json'])
    expect(tagged.unread).toEqual(expect.arrayContaining([{ path: 'docs/big.md', why: 'too-large' }, { path: 'assets/logo.png', why: 'binary' }, { path: 'src/server.ts', why: 'bounds' }]))
    const focused = await snapshotWithTestSeams({ url: repo.url, focus: ['docs/**', 'assets/*'] }, {}, undefined, local)
    expect(focused.unread).toEqual(expect.arrayContaining([{ path: 'docs/big.md', why: 'too-large' }, { path: 'assets/logo.png', why: 'binary' }]))
    const tight = await snapshotWithTestSeams({ url: repo.url }, { maxBytes: 40 }, undefined, local)
    expect(tight.files.map((f) => f.path)).toEqual(['README.md', 'src/server.ts'])
    expect(tight.unread).toEqual(expect.arrayContaining([{ path: 'package.json', why: 'bounds' }]))
    // The per-file bound is inclusive: a file of exactly that size is read, a larger one never comes down.
    const manifest = JSON.stringify({ name: 'demo', main: './src/server.ts' }).length
    expect((await snapshotWithTestSeams({ url: repo.url }, { maxFileBytes: manifest }, undefined, local)).files.map((f) => f.path)).toContain('package.json')
    expect((await snapshotWithTestSeams({ url: repo.url }, { maxFileBytes: manifest - 1 }, undefined, local)).unread).toEqual(expect.arrayContaining([{ path: 'package.json', why: 'too-large' }]))
  })

  it('records a commit named by its SHA as pinned by SHA (on GitHub it may come from a fork)', async () => {
    expect(await snapshotWithTestSeams({ url: repo.url, ref: repo.head }, {}, undefined, local)).toMatchObject({ commit: repo.head, pinnedBy: 'sha' })
  })

  it('refuses any URL git could read differently than its check, before git runs (SSRF)', async () => {
    const refused = async (url: string, bounds = {}, testing = {}) => snapshotWithTestSeams({ url }, bounds, undefined, testing).catch((e: unknown) => e)
    const listener: Server = createServer((socket) => socket.destroy())
    let hit = false
    listener.on('connection', () => { hit = true })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port
    try {
      // The WHATWG parser reads host github.com; git would connect to 127.0.0.1.
      expect(await refused(`https://github.com\\:x@127.0.0.1:${port}/a/b`)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/backslashes/) })
      // git reads these as scp-style ssh to host "https".
      for (const url of ['https:github.com/a/b', 'https:/github.com/a/b', 'https:\\\\github.com/a/b']) expect(await refused(url), url).toMatchObject({ kind: 'invalid_input' })
      expect(hit).toBe(false)
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
    expect(await refused(repo.url)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/https only/) })
    expect(await refused('https://gitlab.com/a/b')).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/not an allowed repository host \(allowed: github\.com\)/) })
    expect(await refused('https://github.com:8443/a/b')).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/https port/) })
    expect(await refused('https://github.com/a/b?x=1')).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/query or fragment/) })
    expect(await refused('https://github.com/a')).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/<owner>\/<repo>/) })
    expect(await refused('https://github.com/a/../b')).toMatchObject({ kind: 'invalid_input' })
    expect(await refused('https://github.com/./a/b')).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/canonical form/) })
    // Only the scheme's and host's case and the default port may differ: these reach the address check.
    for (const url of ['HTTPS://Forge.Example/a/b', 'https://forge.example:443/a/b']) {
      expect(await refused(url, { hosts: ['forge.example'] }, { resolve: async () => ['10.0.0.1'] }), url).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/non-public address/) })
    }
    expect(await refused('https://github.com/a/b c')).toMatchObject({ kind: 'invalid_input' })
    // Built, not written, so the repository's own secret scan does not take it for a credential.
    const withUser = Object.assign(new URL('https://github.com/a/b'), { username: 'user', password: 'pass' }).href
    expect(await refused(withUser)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/no credentials/) })
    // A host that resolves to any non-public address is refused before git runs.
    expect(await refused('https://forge.example/a/b', { hosts: ['forge.example'] }, { resolve: async () => ['203.0.113.7'] }))
      .toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/non-public address/) })
    expect(await refused('https://forge.example/a/b', { hosts: ['forge.example'] }, { resolve: async () => ['140.82.112.3', '192.168.1.5'] }))
      .toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/non-public address/) })
    expect(await refused('https://127.0.0.1/a/b', { hosts: ['127.0.0.1'] })).toMatchObject({ kind: 'invalid_input' })
    expect(await snapshotWithTestSeams({ url: repo.url, ref: '--upload-pack=touch' }, {}, undefined, local).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input' })
    expect(await snapshotWithTestSeams({ url: repo.url, ref: 'nope' }, {}, undefined, local).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/no ref nope/) })
    expect(await snapshotWithTestSeams({ url: `file://${join(repo.dir, 'missing')}` }, {}, undefined, local).catch((e: unknown) => e)).toBeInstanceOf(SnapshotError)
  })

  it('gives production no way to a test seam: an extra argument reaches nothing, and the real resolver refuses a non-public host', async () => {
    const asProduction = snapshotRepository as (...args: unknown[]) => Promise<unknown>
    // A fourth argument, as the old signature took it: still https only, with real host checks.
    expect(await asProduction({ url: repo.url }, {}, undefined, { allowLocal: true }).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/https only/) })
    // Through the system resolver (no stub): localhost is a loopback address, refused before git runs.
    expect(await snapshotRepository({ url: 'https://localhost/a/b' }, { hosts: ['localhost'] }).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/non-public address/) })
  })

  it('knows every non-public address range, v4 and v6', () => {
    for (const a of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '192.0.0.8', '198.18.0.1', '224.0.0.1', '240.0.0.1', '203.0.113.7',
      '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fe81::1', 'febf::1', 'ff02::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:db8::7',
      '::127.0.0.1', '::7f00:1', '::ffff:0:a00:1', '2001::1', '2001:0:4136:e378::1', 'fec0::1', 'not-an-address']) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    for (const a of ['140.82.112.3', '8.8.8.8', '2606:4700::1111', '::ffff:140.82.112.3', '2001:4860:4860::8888']) expect(isPrivateAddress(a), a).toBe(false)
  })

  it('reads an address of a long digit run in linear time, and refuses it (no polynomial backtracking)', () => {
    const started = performance.now()
    for (const a of [`${'0'.repeat(100_000)}x`, `::${'1'.repeat(100_000)}.1.1.1`, `::${'1.'.repeat(100_000)}1`]) expect(isPrivateAddress(a)).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('pins git to every address it checked, so a second lookup cannot send it elsewhere (DNS rebinding)', () => {
    expect(pinnedTo('github.com', ['140.82.112.3'])).toEqual(['-c', 'http.curloptResolve=github.com:443:140.82.112.3'])
    expect(pinnedTo('forge.example', ['140.82.112.3', '2606:4700::1111'])).toEqual(['-c', 'http.curloptResolve=forge.example:443:140.82.112.3,[2606:4700::1111]'])
  })

  it('orders files by class, then by shorter path, then by size', () => {
    const e = (path: string, bytes = 10) => ({ path, sha: '0'.repeat(40), bytes })
    const chosen = selectFiles([e('lib/b.ts'), e('cmd/tool/main.go'), e('Cargo.toml'), e('readme.rst'), e('pkg/api/handler.go', 5), e('pkg/api/handler_test.go'), e('vendor/x/y.go')], { focus: ['pkg/**'] })
    // The focus first, its test included; then the README, manifests, and entry points.
    expect(chosen.map((c) => c.path)).toEqual(['pkg/api/handler.go', 'pkg/api/handler_test.go', 'readme.rst', 'Cargo.toml', 'cmd/tool/main.go'])
  })

  it('checks a pattern once for every reader: deep (** and a trailing /) or one path per segment', () => {
    expect(globProblem('docs/**/x.md', true)).toBeUndefined()
    expect(globProblem('docs/', true)).toBeUndefined()
    expect(globProblem('docs/**/x.md', false)).toMatch(/other than a single \*/)
    expect(globProblem('docs/', false)).toMatch(/ends in \//)
    expect(globProblem('packages/*/plugin-manifest.json', false)).toBeUndefined()
    expect(globProblem('../x', true)).toMatch(/\. or \.\. segment/)
    expect(globProblem('/abs', true)).toMatch(/repository-relative/)
    expect(globProblem('a/x**/b', true)).toMatch(/\*\* inside a segment/)
    expect(globProblem('a'.repeat(201), true)).toMatch(/longer than 200/)
    expect(globProblem(7, true)).toMatch(/non-empty string/)
  })

  it('matches globs in linear time, and bounds focus patterns and request words (DoS)', async () => {
    expect(globMatches('src/**', 'src/a/b.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(globMatches('**/*.test.ts', 'a/b/c.test.ts')).toBe(true)
    expect(globMatches('docs', 'docs/x.md')).toBe(true)
    expect(globMatches('docs/', 'docs/x.md')).toBe(true)
    expect(globMatches('docs', 'docs/x.md', undefined, true)).toBe(false)
    expect(globMatches('docs/', 'docs/x.md', undefined, true)).toBe(true)
    expect(globMatches('*', 'a/b.ts', undefined, true)).toBe(false)
    const started = Date.now()
    expect(globMatches(`${'**'.repeat(10)}zz`, `${'a/'.repeat(15)}b`)).toBe(false)
    expect(globMatches('*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false)
    const many = Array.from({ length: 50_000 }, (_, i) => ({ path: `src/m${i}/file${i}.ts`, sha: '0'.repeat(40), bytes: 10 }))
    selectFiles(many, { terms: Array.from({ length: 20_000 }, (_, i) => `word${i}`) })
    selectFiles(many, { focus: Array.from({ length: 20 }, () => `**/*${'a*'.repeat(3)}zz/**`) })
    expect(Date.now() - started).toBeLessThan(10_000)
    // A pattern deep enough to cost pattern × path steps on every deep path runs out of its budget, quickly.
    const deep = Array.from({ length: 5000 }, (_, i) => ({ path: `${'a/'.repeat(495)}c${i}`, sha: '0'.repeat(40), bytes: 10 }))
    const costly = Date.now()
    expect(() => selectFiles(deep, { focus: [`**/${'a/'.repeat(14)}b`] }, [], 50_000_000)).toThrow(/too costly/)
    expect(Date.now() - costly).toBeLessThan(10_000)
    // Ordinary focus over a large ordinary tree stays well within the budget.
    const tree = Array.from({ length: 50_000 }, (_, i) => ({ path: `packages/p${i % 40}/src/${['auth', 'core', 'util'][i % 3]}/m${i}/file${i}.ts`, sha: '0'.repeat(40), bytes: 10 }))
    expect(selectFiles(tree, { focus: Array.from({ length: 20 }, (_, i) => `**/*${['auth', 'core'][i % 2]}*`) }).length).toBeGreaterThan(0)
    expect(await snapshotWithTestSeams({ url: repo.url, focus: [`**/${'a/'.repeat(240)}b`] }, {}, undefined, local).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/16 segments/) })
    expect(await snapshotWithTestSeams({ url: repo.url, focus: Array.from({ length: 21 }, () => 'a') }, {}, undefined, local).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/at most 20 focus/) })
    expect(await snapshotWithTestSeams({ url: repo.url, focus: ['*'.repeat(9)] }, {}, undefined, local).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/8 wildcards/) })
  }, 60_000)
})
