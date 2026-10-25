// The repository's lessons in a writing Worker's brief (T220, D82 #8): the lessons file's lines
// within their bound, as committed; no file, no section.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkerExecution } from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished } from 'vitest'
import { LESSONS_HEADING, LESSONS_LIMITS, LESSONS_PATH, lessonsSection, repositoryLessons } from '../src/lessons.ts'
import { boot, requirement, ScriptedAgent, worker } from './stack.ts'

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
/** A repository with one commit, holding the lessons file `lessons` when it is given. */
const repository = (lessons?: string): string => {
  const dir = temp('system-lessons-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n')
  if (lessons !== undefined) put(join(dir, LESSONS_PATH), lessons)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
const FILE = '# Lessons\n\nProse that is no lesson.\n\n- First lesson (T1). Check: a test.\n- Second lesson (T2). Check: a check.\n'

describe('the lessons section (lessonsSection)', () => {
  it('holds the file\'s lesson lines, in order, under its heading, and nothing else of the file', () => {
    expect(lessonsSection(FILE)).toBe([LESSONS_HEADING, '- First lesson (T1). Check: a test.', '- Second lesson (T2). Check: a check.'].join('\n'))
    expect(LESSONS_HEADING).toMatch(/^Lessons of this repository \(docs\/engineering\/lessons\.md/)
  })

  it('is none for a missing file, an empty one, or one with no lesson', () => {
    expect(lessonsSection(undefined)).toBeUndefined()
    expect(lessonsSection('')).toBeUndefined()
    expect(lessonsSection('# Lessons\n\nNo lesson yet.\n-\n- \n')).toBeUndefined()
  })

  it('shows at most 30 lessons, the rest counted, and cuts a long one at 400 characters', () => {
    const many = Array.from({ length: 35 }, (_, i) => `- lesson ${i + 1}`).join('\n')
    const lines = lessonsSection(many)!.split('\n')
    expect(lines).toHaveLength(1 + LESSONS_LIMITS.lines + 1)
    expect(lines.slice(1, 31)).toEqual(Array.from({ length: 30 }, (_, i) => `- lesson ${i + 1}`))
    expect(lines.at(-1)).toBe(`- and 5 more in ${LESSONS_PATH}`)
    const long = lessonsSection(`- ${'x'.repeat(1000)}`)!.split('\n')[1]!
    expect([...long]).toHaveLength(LESSONS_LIMITS.lineChars)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('the lessons as a repository has them committed (repositoryLessons)', { timeout: 30_000 }, () => {
  it('reads the file committed at HEAD, never an uncommitted edit of it', async () => {
    const repo = repository(FILE)
    expect(await repositoryLessons(repo)).toBe(lessonsSection(FILE))
    writeFileSync(join(repo, LESSONS_PATH), '- A lesson nobody committed.\n')
    expect(await repositoryLessons(repo)).toBe(lessonsSection(FILE))
  })

  it('is none when no lessons file is committed, even with one in the working tree, and outside a repository', async () => {
    const repo = repository()
    expect(await repositoryLessons(repo)).toBeUndefined()
    put(join(repo, LESSONS_PATH), FILE)
    expect(await repositoryLessons(repo)).toBeUndefined()
    expect(await repositoryLessons(temp('system-lessons-none-'))).toBeUndefined()
  })

  it('reads a file larger than its bound only so far, and no partial line of it', async () => {
    const line = (i: number): string => `- lesson ${String(i).padStart(3, '0')} ${'y'.repeat(990)}`
    const repo = repository(Array.from({ length: 60 }, (_, i) => line(i)).join('\n'))
    const lines = (await repositoryLessons(repo))!.split('\n')
    // 32 KiB holds 32 whole lines of 1,004 characters (and a newline): 30 shown, 2 counted.
    expect(lines).toHaveLength(1 + LESSONS_LIMITS.lines + 1)
    expect(lines.at(-1)).toBe(`- and 2 more in ${LESSONS_PATH}`)
  })
})

describe('the committed lessons file of this repository', () => {
  const text = readFileSync(fileURLToPath(new URL(`../../../../${LESSONS_PATH}`, import.meta.url)), 'utf8')
  const lessons = text.split('\n').filter((line) => line.startsWith('- '))

  it('holds at most 30 lessons, each one line within its bound that names what enforces it', () => {
    expect(lessons.length).toBeGreaterThan(0)
    expect(lessons.length).toBeLessThanOrEqual(LESSONS_LIMITS.lines)
    for (const lesson of lessons) {
      expect([...lesson].length).toBeLessThanOrEqual(LESSONS_LIMITS.lineChars)
      expect(lesson).toMatch(/ Check: \S/)
    }
  })

  it('holds the lessons of 2026-10-26 it was seeded with', () => {
    for (const task of ['T213', 'T185', 'T193', 'T209', 'T214']) expect(lessons.some((l) => l.includes(task))).toBe(true)
    expect(lessons.some((l) => l.includes('wall clock'))).toBe(true)
  })
})

describe('agents source: a writing Worker\'s brief carries the lessons (T220)', { timeout: 60_000 }, () => {
  const agent = () => new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'] })
  const run = async (ctx: Context, id: string, key: string, runId?: string): Promise<WorkerExecution> => {
    const source = ctx.workers.source('agents')!
    const capabilities = id === 'agent:dev' ? ['develop'] : ['review']
    return source.wait(source.start({ key, worker: id, prompt: key, ...(runId ? { runId } : {}), requirement: requirement({ capabilities }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 30_000)
  }

  it('appends the committed lessons to a writing run\'s prompt, in its worktree too, and never to a read-only reviewer\'s', async () => {
    const repo = repository(FILE)
    const scripted = agent()
    const { ctx } = await boot(scripted, { workers: [worker({ id: 'dev', sandbox: 'workspace-write', workspace: repo, tools: [] }), worker({ id: 'reviewer', workspace: repo })] })
    expect((await run(ctx, 'agent:dev', 'k-write')).status).toBe('completed')
    expect((await run(ctx, 'agent:reviewer', 'k-review')).status).toBe('completed')
    const [write, review] = scripted.runs
    expect(write!.prompt).toBe(`k-write\n\n${lessonsSection(FILE)}`)
    expect(review!.prompt).not.toContain('Lessons of this repository')
    // A Worker with a worktree per run reads them from its repository, as committed.
    const root = temp('system-worktrees-')
    const second = agent()
    const other = await boot(second, { workers: [worker({ id: 'dev', sandbox: 'workspace-write', workspace: repo, tools: [], worktreePerRun: true })], worktreeRoot: root })
    expect((await run(other.ctx, 'agent:dev', 'k-tree', 'run_lessons')).status).toBe('completed')
    expect(second.runs[0]!.workspace).not.toBe(repo)
    expect(second.runs[0]!.prompt).toBe(`k-tree\n\n${lessonsSection(FILE)}`)
  })

  it('sends a writing run no lessons section when its repository commits no lessons file', async () => {
    const scripted = agent()
    const { ctx } = await boot(scripted, { workers: [worker({ id: 'dev', sandbox: 'workspace-write', workspace: repository(), tools: [] })] })
    expect((await run(ctx, 'agent:dev', 'k-none')).status).toBe('completed')
    expect(scripted.runs[0]!.prompt).toBe('k-none')
  })
})
