import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pinnedTo, selectFiles, SnapshotError, snapshotRepository } from '../src/index.ts'

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
    })
  })
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }))

  it('pins the commit, reads the chosen files in order, and lists every other file with why', async () => {
    const snapshot = await snapshotRepository({ url: repo.url, terms: ['session', 'auth'] }, { allowLocal: true, maxFileBytes: 48_000 })
    expect(snapshot.commit).toBe(repo.head)
    expect(snapshot.files.map((f) => f.path)).toEqual(['README.md', 'package.json', 'src/server.ts', 'src/auth/session.ts', 'src/auth/session.test.ts'])
    expect(snapshot.files[2]).toMatchObject({ text: 'export const port = 8080\n', bytes: 25, sha: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(Object.fromEntries(snapshot.unread.map((u) => [u.path, u.why]))).toEqual({
      'pnpm-lock.yaml': 'lockfile', 'src/util.ts': 'not-selected', 'docs/big.md': 'not-selected', 'assets/logo.png': 'not-selected', 'node_modules/dep/index.js': 'not-selected',
    })
  })

  it('reads a tag at its commit, and keeps within the file, byte, and size bounds', async () => {
    const tagged = await snapshotRepository({ url: repo.url, ref: 'v1', focus: ['docs/**', 'assets/*'] }, { allowLocal: true, maxFiles: 3 })
    expect(tagged.commit).toBe(repo.head)
    // README, the manifest, the entry point: the bound is reached before the focus.
    expect(tagged.files.map((f) => f.path)).toEqual(['README.md', 'package.json', 'src/server.ts'])
    // What the file bound left out is unread for the bound, not unselected.
    expect(tagged.unread).toEqual(expect.arrayContaining([{ path: 'docs/big.md', why: 'bounds' }, { path: 'assets/logo.png', why: 'bounds' }]))
    const focused = await snapshotRepository({ url: repo.url, focus: ['docs/**', 'assets/*'] }, { allowLocal: true })
    expect(focused.unread).toEqual(expect.arrayContaining([{ path: 'docs/big.md', why: 'too-large' }, { path: 'assets/logo.png', why: 'binary' }]))
    const tight = await snapshotRepository({ url: repo.url }, { allowLocal: true, maxBytes: 40 })
    expect(tight.files.map((f) => f.path)).toEqual(['README.md', 'src/server.ts'])
    expect(tight.unread).toEqual(expect.arrayContaining([{ path: 'package.json', why: 'bounds' }]))
  })

  it('refuses anything but a public https repository, before fetching', async () => {
    const refused = async (url: string, bounds = {}) => snapshotRepository({ url }, bounds).catch((e: unknown) => e)
    expect(await refused(repo.url)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/https only/) })
    expect(await refused('https://gitlab.com/a/b')).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/not an allowed repository host \(allowed: github\.com\)/) })
    expect(await refused('https://github.com:8443/a/b')).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/https port/) })
    // A host that resolves to a private address is refused before git runs.
    expect(await refused('https://forge.example/a/b', { hosts: ['forge.example'], resolve: async () => ['203.0.113.7', '192.168.1.5'] }))
      .toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/private address/) })
    expect(await refused('http://example.com/a.git')).toMatchObject({ kind: 'invalid_input' })
    // Built, not written, so the repository's own secret scan does not take it for a credential.
    const withUser = Object.assign(new URL('https://github.com/a/b'), { username: 'user', password: 'pass' }).href
    expect(await refused(withUser)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/no credentials/) })
    const any = { hosts: ['localhost', '127.0.0.1', '::1', '10.1.2.3'] }
    expect(await refused('https://localhost/a.git', any)).toMatchObject({ kind: 'invalid_input' })
    expect(await refused('https://127.0.0.1/a.git', any)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/private address/) })
    expect(await refused('https://[::1]/a.git', any)).toMatchObject({ kind: 'invalid_input' })
    expect(await refused('https://10.1.2.3/a.git', any)).toBeInstanceOf(SnapshotError)
    expect(await snapshotRepository({ url: repo.url, ref: '--upload-pack=touch' }, { allowLocal: true }).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input' })
    expect(await snapshotRepository({ url: repo.url, ref: 'nope' }, { allowLocal: true }).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/no ref nope/) })
  })

  it('pins git to the address it checked, so a second lookup cannot send it elsewhere (DNS rebinding)', () => {
    expect(pinnedTo('github.com', '140.82.112.3')).toEqual(['-c', 'http.curloptResolve=github.com:443:140.82.112.3'])
    expect(pinnedTo('forge.example', '2001:db8::7')).toEqual(['-c', 'http.curloptResolve=forge.example:443:[2001:db8::7]'])
  })

  it('orders files by class, then by shorter path, then by size', () => {
    const e = (path: string, bytes = 10) => ({ path, sha: '0'.repeat(40), bytes })
    const chosen = selectFiles([e('lib/b.ts'), e('cmd/tool/main.go'), e('Cargo.toml'), e('readme.rst'), e('pkg/api/handler.go', 5), e('pkg/api/handler_test.go'), e('vendor/x/y.go')], { focus: ['pkg/**'] })
    expect(chosen.map((c) => c.path)).toEqual(['readme.rst', 'Cargo.toml', 'cmd/tool/main.go', 'pkg/api/handler.go', 'pkg/api/handler_test.go'])
  })
})
