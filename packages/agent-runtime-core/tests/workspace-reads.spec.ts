// The workspace reads server (T200b): three read-only tools over one run's workspace, every path
// resolved and kept inside it, every bound a validated argument, MCP over stdio with its root fixed.
import { type ChildProcessWithoutNullStreams, execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import {
  WORKSPACE_READS_PROTOCOLS, WORKSPACE_READS_SCRIPT, WORKSPACE_READ_BOUNDS, WorkspaceReads, answerMessage, confinedCommand, parseWorkspaceReadArgs, workspaceReadArgs, workspaceReadBounds,
  workspaceReadBoundsProblem,
} from '../src/index.ts'
import { BWRAP, needsBubblewrap } from './host.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'system-reads-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A workspace with source files, git's data, secrets, a dependency directory, and links in and out. */
const ws = join(root, 'ws')
const outside = join(root, 'outside')
mkdirSync(join(ws, 'src', 'deep'), { recursive: true })
mkdirSync(join(ws, '.git'))
mkdirSync(join(ws, 'node_modules', 'dep'), { recursive: true })
mkdirSync(outside)
writeFileSync(join(outside, 'secret.txt'), 'outside needle\n')
writeFileSync(join(ws, 'src', 'a.ts'), 'const one = 1\nconst two = 2 // needle\nconst three = 3\n')
writeFileSync(join(ws, 'src', 'deep', 'b.ts'), 'export const NEEDLE = "needle"\n')
writeFileSync(join(ws, 'README.md'), '# needle\n')
writeFileSync(join(ws, '.git', 'config'), '[core]\n\tfsmonitor = needle\n')
writeFileSync(join(ws, '.env'), 'TOKEN=needle\n')
writeFileSync(join(ws, '.env.example'), 'TOKEN=\n')
writeFileSync(join(ws, 'id_ed25519'), 'needle key\n')
writeFileSync(join(ws, 'node_modules', 'dep', 'index.js'), 'needle\n')
writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1, 2]))
symlinkSync(join(outside, 'secret.txt'), join(ws, 'escape.txt'))
symlinkSync(outside, join(ws, 'escape-dir'))
symlinkSync(join(ws, 'src', 'a.ts'), join(ws, 'alias.ts'))

const reads = (bounds: Partial<ReturnType<typeof workspaceReadBounds>> = {}) => new WorkspaceReads(ws, workspaceReadBounds(bounds))
const call = async (name: string, input: unknown, bounds: Parameters<typeof reads>[0] = {}) => reads(bounds).call(name, input)

describe('the workspace reads server\'s bounds are validated arguments (INV-9)', () => {
  it('takes each bound within its range, the rest at their defaults, and refuses anything else', () => {
    const defaults = workspaceReadBounds()
    for (const [name, bound] of Object.entries(WORKSPACE_READ_BOUNDS)) {
      expect(defaults[name as keyof typeof defaults], name).toBe(bound.default)
      expect(bound.min <= bound.default && bound.default <= bound.max, name).toBe(true)
      expect(workspaceReadBoundsProblem({ [name]: bound.min }), name).toBeUndefined()
      expect(workspaceReadBoundsProblem({ [name]: bound.max }), name).toBeUndefined()
      expect(workspaceReadBoundsProblem({ [name]: bound.min - 1 }), name).toMatch(/not an integer from/)
      expect(workspaceReadBoundsProblem({ [name]: bound.max + 1 }), name).toMatch(/not an integer from/)
      expect(workspaceReadBoundsProblem({ [name]: bound.min + 0.5 }), name).toMatch(/not an integer from/)
    }
    expect(workspaceReadBoundsProblem({ maxBytes: 10 })).toMatch(/is not a workspace reads bound/)
    expect(workspaceReadBoundsProblem([])).toMatch(/not an object/)
    expect(() => workspaceReadBounds({ maxEntries: 0 })).toThrow(/maxEntries/)
  })

  it('passes them as arguments and reads them back exactly; refuses a relative root, an unknown or repeated flag, a value that is no number', () => {
    const bounds = workspaceReadBounds({ maxEntries: 7, searchTimeoutMs: 250 })
    expect(parseWorkspaceReadArgs(workspaceReadArgs(ws, bounds))).toEqual({ root: ws, bounds })
    expect(() => workspaceReadArgs('ws', bounds)).toThrow(/absolute/)
    expect(() => parseWorkspaceReadArgs(['--root', 'ws'])).toThrow(/absolute/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--max-files', '3'])).toThrow(/not an argument/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--root', ws])).toThrow(/twice/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--max-entries', '-1'])).toThrow(/whole number/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--max-entries', '0'])).toThrow(/maxEntries/)
  })
})

describe('every path stays inside the workspace, really (T200b)', () => {
  it('refuses "..", an absolute path outside, and a symlink whose target is outside, a file or a directory; reads an absolute path inside and a symlink inside', async () => {
    for (const path of ['../outside/secret.txt', 'src/../src/a.ts', '..', join(outside, 'secret.txt'), '/etc/hostname', 'escape.txt', 'escape-dir/secret.txt']) {
      const result = await call('read_file', { path })
      expect(result.isError, path).toBe(true)
      expect(result.text, path).toMatch(/^refused: /)
      expect(result.text, path).not.toContain('outside needle')
    }
    expect((await call('read_file', { path: '../outside/secret.txt' })).text).toContain('climbs with ".."')
    expect((await call('read_file', { path: 'escape.txt' })).text).toContain('resolves outside the workspace')
    expect((await call('list_dir', { path: 'escape-dir' })).text).toContain('resolves outside the workspace')
    expect((await call('search', { pattern: 'needle', path: 'escape-dir' })).text).toContain('resolves outside the workspace')
    // A refusal names only what the agent wrote, never where a link out leads.
    for (const [tool, path] of [['read_file', 'escape.txt'], ['list_dir', 'escape-dir'], ['search', 'escape-dir']] as const) {
      const text = (await call(tool, tool === 'search' ? { pattern: 'needle', path } : { path })).text
      expect(text, path).not.toContain(outside)
      expect(text, path).not.toContain('secret.txt')
    }
    expect((await call('read_file', { path: join(ws, 'src', 'a.ts') })).text).toContain('2\tconst two = 2 // needle')
    expect((await call('read_file', { path: 'alias.ts' })).text).toMatch(/^src\/a\.ts \(/)
  })

  it('never reads git\'s data or a secret file, as written or through a link; an example environment file is no secret', async () => {
    symlinkSync(join(ws, '.git', 'config'), join(ws, 'git-config'))
    try {
      for (const path of ['.git/config', '.GIT/config', '.git', '.env', 'id_ed25519', 'git-config']) {
        const result = await call(path === '.git' ? 'list_dir' : 'read_file', { path })
        expect(result, path).toMatchObject({ isError: true, text: expect.stringMatching(/^refused: .*(git's own data|secret)/) })
      }
    } finally {
      rmSync(join(ws, 'git-config'))
    }
    expect((await call('read_file', { path: '.env.example' })).text).toContain('1\tTOKEN=')
    expect((await call('read_file', { path: 'a\0b' })).text).toContain('NUL')
  })
})

describe('read_file', () => {
  it('reads a file\'s lines numbered, or a range of them; names a binary file instead of showing it; refuses a directory, a missing file, an unknown argument', async () => {
    expect(await call('read_file', { path: 'src/a.ts' })).toEqual({ isError: false, text: `src/a.ts (${'const one = 1\nconst two = 2 // needle\nconst three = 3\n'.length} bytes)\n1\tconst one = 1\n2\tconst two = 2 // needle\n3\tconst three = 3\n` })
    expect((await call('read_file', { path: 'src/a.ts', startLine: 2, endLine: 2 })).text).toMatch(/lines 2 to 2\n2\tconst two = 2 \/\/ needle\n$/)
    expect((await call('read_file', { path: 'src/a.ts', startLine: 9 })).text).toContain('[the file has 3 lines; none from line 9]')
    expect((await call('read_file', { path: 'bin.dat' })).text).toBe('bin.dat: a binary file of 9 bytes, not shown')
    expect((await call('read_file', { path: 'src' })).text).toContain('is a directory')
    expect((await call('read_file', { path: 'nope.ts' })).text).toContain('does not exist')
    expect((await call('read_file', { path: 'src/a.ts', offset: 1 })).text).toContain('"offset" is not an argument')
    expect((await call('read_file', { path: 'src/a.ts', startLine: 3, endLine: 2 })).isError).toBe(true)
    expect((await call('read_file', {})).text).toContain('path is required')
  })

  it('returns at most maxReadBytes, cut where it stops with where to read on, and reads through at most maxScanBytes of a file', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`)
    writeFileSync(join(ws, 'big.txt'), `${lines.join('\n')}\n`)
    const cut = await call('read_file', { path: 'big.txt' }, { maxReadBytes: 1024 })
    const body = cut.text.split('\n').slice(1).join('\n')
    expect(Buffer.byteLength(body.slice(0, body.indexOf('\n[')))).toBeLessThanOrEqual(1024)
    const next = Number(/read on with startLine (\d+)/.exec(cut.text)?.[1])
    expect(next).toBeGreaterThan(10)
    expect((await call('read_file', { path: 'big.txt', startLine: next, endLine: next }, { maxReadBytes: 1024 })).text).toContain(`${next}\tline ${next} `)
    // Past maxScanBytes (64 KiB at its least) a range is not reached, and it says so.
    const far = await call('read_file', { path: 'big.txt', startLine: 4900, endLine: 4901 }, { maxScanBytes: 64 * 1024 })
    expect(far.text).toMatch(/stopped after reading 65536 bytes of the file \(maxScanBytes\)/)
    expect(far.text).not.toContain('line 4900')
    expect((await call('read_file', { path: 'big.txt', startLine: 4900, endLine: 4900 })).text).toContain('4900\tline 4900 ')
  })

  it('reads a single line longer than many chunks in one pass: cut at maxReadBytes, and skipped whole when it lies before the range', async () => {
    // 1 MiB on one line, sixteen 64 KiB chunks, then two short lines (the last with no newline).
    const long = 'x'.repeat(1024 * 1024)
    writeFileSync(join(ws, 'one-line.txt'), `${long}\nsecond\nthird`)
    try {
      const cut = await call('read_file', { path: 'one-line.txt' }, { maxReadBytes: 4096 })
      expect(cut.isError).toBe(false)
      const body = cut.text.slice(cut.text.indexOf('\n') + 1, cut.text.indexOf('\n['))
      expect(body).toBe(`1\t${'x'.repeat(4096 - 2)}`)
      expect(cut.text).toContain('[output cut at 4096 bytes (maxReadBytes) in line 1; read on with startLine 1]')
      // Before the range, the long line is counted, never kept.
      expect((await call('read_file', { path: 'one-line.txt', startLine: 2 })).text).toMatch(/lines 2 to the end\n2\tsecond\n3\tthird\n$/)
      expect((await call('read_file', { path: 'one-line.txt', startLine: 3, endLine: 3 })).text).toMatch(/\n3\tthird\n$/)
      // The whole line, when it fits.
      const whole = await call('read_file', { path: 'one-line.txt', startLine: 1, endLine: 1 }, { maxReadBytes: 2 * 1024 * 1024 })
      expect(whole.text).toContain(`\n1\t${long}\n`)
      expect(whole.text).not.toContain('second')
      expect((await call('read_file', { path: 'one-line.txt', startLine: 9 })).text).toContain('[the file has 3 lines; none from line 9]')
    } finally {
      rmSync(join(ws, 'one-line.txt'))
    }
  })
})

describe('a path swapped between its check and its open is refused (TOCTOU)', () => {
  // Each swap is made between the server's own two steps, locate() and open(), so it is deterministic.
  const away = join(root, 'away')
  mkdirSync(away, { recursive: true })
  writeFileSync(join(away, 'f.txt'), 'outside needle\n')

  it('refuses a file replaced by a symlink to a file outside the workspace: opened without following it (ELOOP)', () => {
    const r = reads()
    writeFileSync(join(ws, 'swap.txt'), 'inside\n')
    const located = r.locate('swap.txt')
    rmSync(join(ws, 'swap.txt'))
    symlinkSync(join(away, 'f.txt'), join(ws, 'swap.txt'))
    try {
      expect(() => r.open(located, 'file')).toThrow(/swap\.txt became a symlink, which is not followed/)
    } finally {
      rmSync(join(ws, 'swap.txt'))
    }
  })

  it('refuses a file whose parent directory was renamed and replaced by a symlink to a directory outside: the descriptor names where it really is (/proc/self/fd)', () => {
    const r = reads()
    mkdirSync(join(ws, 'swapdir'))
    writeFileSync(join(ws, 'swapdir', 'f.txt'), 'inside\n')
    const located = r.locate('swapdir/f.txt')
    const dir = r.locate('swapdir')
    renameSync(join(ws, 'swapdir'), join(ws, 'swapdir-old'))
    symlinkSync(away, join(ws, 'swapdir'))
    try {
      expect(() => r.open(located, 'file')).toThrow(/swapdir\/f\.txt moved while it was opened, so it is not read/)
      // The directory itself, now a symlink at its end, is not followed either.
      expect(() => r.open(dir, 'dir')).toThrow(/swapdir (became a symlink, which is not followed|is not a directory)/)
    } finally {
      rmSync(join(ws, 'swapdir'))
      rmSync(join(ws, 'swapdir-old'), { recursive: true })
    }
  })

  it('refuses a FIFO, opened without blocking, as no regular file', async () => {
    execFileSync('mkfifo', [join(ws, 'pipe')])
    try {
      const r = reads()
      expect(() => r.open(r.locate('pipe'), 'file')).toThrow(/pipe is not a regular file/)
      expect(await call('read_file', { path: 'pipe' })).toMatchObject({ isError: true, text: expect.stringContaining('is not a regular file') })
      // A search skips it, and does not wait on it.
      expect((await call('search', { pattern: 'needle', path: 'pipe' })).text).toMatch(/^0 matches .*1 not read/)
    } finally {
      rmSync(join(ws, 'pipe'))
    }
  })

  it('reads a hard link to a file outside the workspace, as the file it is (current behaviour: a hard link is no symlink, and no path check sees it; open follow-up)', async () => {
    linkSync(join(away, 'f.txt'), join(ws, 'hard.txt'))
    try {
      const r = reads()
      const opened = r.open(r.locate('hard.txt'), 'file')
      closeSync(opened.fd)
      expect((await call('read_file', { path: 'hard.txt' })).text).toContain('1\toutside needle')
    } finally {
      rmSync(join(ws, 'hard.txt'))
    }
  })
})

describe('list_dir', () => {
  it('lists a directory by name, a directory with /, a link with @ (not followed), a file with its size; git\'s data and secrets left out and counted', async () => {
    const { text, isError } = await call('list_dir', {})
    expect(isError).toBe(false)
    const [header, ...entries] = text.split('\n')
    expect(header).toMatch(/^\.\/: \d+ entries \(3 not shown: git's data or secret files\)$/)
    expect(entries).toEqual(expect.arrayContaining(['src/', 'node_modules/', 'escape-dir@', 'escape.txt@', `README.md\t${'# needle\n'.length} bytes`, '.env.example\t7 bytes']))
    for (const hidden of ['.git/', '.env', 'id_ed25519']) expect(entries.map((e) => e.split('\t')[0]), hidden).not.toContain(hidden)
    expect(entries).toEqual([...entries].sort())
    expect((await call('list_dir', { path: 'src/a.ts' })).text).toContain('is not a directory')
  })

  it('returns at most maxEntries, and says how many there are', async () => {
    const { text } = await call('list_dir', { path: '.' }, { maxEntries: 2 })
    const [header, ...entries] = text.split('\n')
    expect(entries).toHaveLength(2)
    expect(header).toMatch(/showing the first 2 of \d+ \(maxEntries\)/)
  })
})

describe('search', () => {
  it('finds a fixed string or a regular expression, any case on request, in name order; never in git\'s data, secrets, links, node_modules, or binary files', async () => {
    const { text, isError } = await call('search', { pattern: 'needle' })
    expect(isError).toBe(false)
    expect(text.split('\n').slice(1)).toEqual(['README.md:1: # needle', 'src/a.ts:2: const two = 2 // needle', 'src/deep/b.ts:1: export const NEEDLE = "needle"'])
    expect(text).toMatch(/^3 matches of "needle" under \. \[\d+ files searched; 1 not read/)
    expect((await call('search', { pattern: 'NEEDLE', ignoreCase: true, path: 'src' })).text.split('\n').slice(1)).toEqual(['src/a.ts:2: const two = 2 // needle', 'src/deep/b.ts:1: export const NEEDLE = "needle"'])
    expect((await call('search', { pattern: '^const t\\w+ =', regex: true, path: 'src/a.ts' })).text.split('\n').slice(1)).toEqual(['src/a.ts:2: const two = 2 // needle', 'src/a.ts:3: const three = 3'])
    // A fixed string is not a regular expression.
    expect((await call('search', { pattern: 'const t.o', path: 'src' })).text).toMatch(/^0 matches/)
    expect((await call('search', { pattern: '(', regex: true })).text).toContain('not a regular expression')
    expect((await call('search', { pattern: 'needle', path: 'node_modules' })).text).toContain('node_modules/dep/index.js:1: needle')
  })

  it('stops at maxMatches, maxSearchFiles, and maxLineChars, takes at most maxPatternChars, and says where it stopped', async () => {
    expect((await call('search', { pattern: 'needle' }, { maxMatches: 1 })).text).toMatch(/^1 match .*stopped at 1 matches \(maxMatches\)/)
    expect((await call('search', { pattern: 'needle' }, { maxSearchFiles: 1 })).text).toMatch(/stopped after 1 files \(maxSearchFiles\)/)
    writeFileSync(join(ws, 'src', 'long.txt'), `${'y'.repeat(300)} needle ${'z'.repeat(300)}\n`)
    try {
      const line = (await call('search', { pattern: 'needle', path: 'src/long.txt' }, { maxLineChars: 80 })).text.split('\n')[1]!
      expect(line).toBe(`src/long.txt:1: ${'y'.repeat(80)}…`)
    } finally {
      rmSync(join(ws, 'src', 'long.txt'))
    }
    expect((await call('search', { pattern: 'abc' }, { maxPatternChars: 2 })).text).toContain('1 to 2 characters (maxPatternChars)')
    expect((await call('search', { pattern: '' })).isError).toBe(true)
  })

  it('stops a search at searchTimeoutMs, whatever its pattern does: a regular expression that backtracks without end is ended', async () => {
    writeFileSync(join(ws, 'src', 'redos.txt'), `${'a'.repeat(40)}!\n`)
    try {
      const started = Date.now()
      // Long enough for the thread to start under a loaded host and reach the line, so it is the
      // regular expression that runs past the deadline and the thread that is ended.
      const result = await call('search', { pattern: '^(a+)+$', regex: true, path: 'src/redos.txt' }, { searchTimeoutMs: 2000 })
      expect(result).toMatchObject({ isError: true, text: expect.stringContaining('did not finish within 2000 ms (searchTimeoutMs)') })
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      rmSync(join(ws, 'src', 'redos.txt'))
    }
  })
})

describe('MCP over stdio, its root fixed at start', () => {
  const r = reads()
  it('answers initialize in a protocol version it speaks, lists exactly its three read-only tools, and ignores roots', async () => {
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: { roots: { listChanged: true } } } }))
      .toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } } } })
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).toMatchObject({ result: { protocolVersion: WORKSPACE_READS_PROTOCOLS[0] } })
    const listed = await answerMessage(r, { jsonrpc: '2.0', id: 3, method: 'tools/list' }) as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } }
    expect(listed.result.tools.map((t) => t.name)).toEqual(['read_file', 'list_dir', 'search'])
    for (const tool of listed.result.tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    // Roots change nothing: a notification is not answered, and no request widens what is read.
    expect(await answerMessage(r, { jsonrpc: '2.0', method: 'notifications/roots/list_changed' })).toBeUndefined()
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 4, method: 'roots/list' })).toMatchObject({ error: { code: -32601 } })
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'x' } } }))
      .toMatchObject({ result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('write_file is not a tool of this server') }] } })
  })

  it('serves as its own process: newline-delimited JSON-RPC in, one answer per request out, and reads the workspace it was started on', async () => {
    const child = spawn(process.execPath, [WORKSPACE_READS_SCRIPT, ...workspaceReadArgs(ws, workspaceReadBounds())], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    const lines: string[] = []
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n')) {
        lines.push(out.slice(0, i))
        out = out.slice(i + 1)
      }
    })
    const ended = new Promise<number | null>((resolve) => child.once('close', resolve))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\nnot json\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'src/a.ts', startLine: 1, endLine: 1 } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { pattern: 'needle', path: 'src/deep' } } })}\n`)
    child.stdin.end()
    expect(await ended).toBe(0)
    const answers = lines.map((l) => JSON.parse(l) as { id: unknown; result?: { content?: Array<{ text: string }> }; error?: { code: number } })
    expect(answers.map((a) => a.id)).toEqual([1, null, 2, 3])
    expect(answers[1]!.error!.code).toBe(-32700)
    expect(answers[2]!.result!.content![0]!.text).toContain('1\tconst one = 1')
    expect(answers[3]!.result!.content![0]!.text).toContain('src/deep/b.ts:1:')
    // Every line it wrote is an answer: it asks the client nothing (no roots/list).
    expect(answers.every((a) => !('method' in a))).toBe(true)
  })

  it('refuses to start on arguments out of range or a workspace that is not there', async () => {
    for (const args of [['--root', ws, '--max-entries', '0'], ['--root', join(root, 'none')], ['--root', 'relative']]) {
      const failed = await promisify(execFile)(process.execPath, [WORKSPACE_READS_SCRIPT, ...args], { timeout: 15_000 }).then(() => undefined, (error: { code?: number; stderr?: string }) => error)
      expect(failed?.code, args.join(' ')).toBe(2)
      expect(failed?.stderr, args.join(' ')).toMatch(/^workspace reads: /)
    }
  })
})

describe('under the real confinement, the workspace read-only to it', () => {
  needsBubblewrap()

  it('starts confined as a runtime starts it, reads a file of the workspace, and cannot write it', async () => {
    const confinement = { bwrap: BWRAP!, hide: [outside], readOnly: [ws, WORKSPACE_READS_SCRIPT, process.execPath], writable: [] }
    const self = confinedCommand(process.execPath, [WORKSPACE_READS_SCRIPT, ...workspaceReadArgs(ws, workspaceReadBounds()), '--self-test', 'src/a.ts'], confinement, { readOnly: true, network: false, chdir: ws })
    const { stdout } = await promisify(execFile)(self.command, self.args, { timeout: 15_000 })
    expect(stdout).toContain('2\tconst two = 2 // needle')
    // The workspace is read-only there: a write from inside the same confinement fails.
    const write = confinedCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(ws, 'written'))}, 'x')`], confinement, { readOnly: true, network: false, chdir: ws })
    await expect(promisify(execFile)(write.command, write.args, { timeout: 15_000 })).rejects.toMatchObject({ stderr: expect.stringMatching(/EROFS|read-only/) })
  })
})
