import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { RunSpec, SandboxMode } from '@tsuuanmi/system-agent-runtimes'
import type { ToolHandler, ToolSpec } from '@tsuuanmi/system-gateway-core'
import { captureGitSubject, SchemaError, SchemaRegistry, subjectId } from '@tsuuanmi/system-libs'
import type { WorkerExecution } from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createdMode } from '../../../agent-runtime-core/tests/host.ts'
import AgentWorkers from '../src/index.ts'
import { registerRunTools } from '../src/tools.ts'
import { openDirectory } from '../src/worktrees.ts'
import { ScriptedAgent, worker, boot, requirement, chatWorker } from './stack.ts'

// Real git repositories, worktrees, and a workflow run end to end: slower than the 5 s default on CI runners.
describe('agents source: a git worktree per workflow run (worktreePerRun; PROP-0010 B3)', { timeout: 60_000 }, () => {
  const ORIGINAL = 'def add(a, b):\n    return a - b\n'
  const FIXED = 'def add(a, b):\n    return a + b\n'
  const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()
  const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }
  /** A repository on `main` with one commit; never one of the operator's. */
  const repository = (): string => {
    const dir = temp('system-wt-repo-')
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'calc.py'), ORIGINAL)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
    return dir
  }
  /** The main working tree as the operator left it: on `main`, at `head`, clean, with its own calc.py. */
  const untouched = (dir: string, head: string): void => {
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(dir, 'calc.py'), 'utf8')).toBe(ORIGINAL)
  }
  const writer = (workspace: string) => worker({ id: 'dev', sandbox: 'workspace-write', workspace, tools: [], worktreePerRun: true })
  const reviewer = (workspace: string) => worker({ id: 'reviewer', workspace, worktreePerRun: true })
  /** What a writing run does: it fixes calc.py and leaves a note named after the directory it works in. */
  const writes = (spec: RunSpec): string => {
    if (spec.sandbox !== 'workspace-write') return 'read'
    writeFileSync(join(spec.workspace, 'calc.py'), FIXED)
    writeFileSync(join(spec.workspace, `note-${basename(spec.workspace)}.txt`), `${spec.prompt}\n`)
    return 'done'
  }
  /** The mode of a brief's file, written 0o444: what that mode becomes in this environment, never writable. */
  const READ_ONLY = createdMode(0o444)
  const SANDBOXES: SandboxMode[] = ['read-only', 'workspace-write']
  const developer = (options: ConstructorParameters<typeof ScriptedAgent>[0] = {}) => new ScriptedAgent({ sandboxes: SANDBOXES, act: writes, ...options })
  const run = async (ctx: Context, id: string, key: string, runId?: string): Promise<WorkerExecution> => {
    const source = ctx.workers.source('agents')!
    const capabilities = id === 'agent:dev' ? ['develop'] : ['review']
    return source.wait(source.start({ key, worker: id, prompt: key, ...(runId ? { runId } : {}), requirement: requirement({ capabilities }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 30_000)
  }
  const LATER = (): number => Date.now() + 169 * 60 * 60_000

  it('runs a writing run of a workflow run in that run\'s own worktree, on branch system/run/<runId>, and never touches the main working tree (INV-15, REQ-WF-5)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const root = temp('system-worktrees-')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: root })
    expect((await ctx.workers.list())[0]).toMatchObject({ worker: 'agent:dev', state: 'ready' })
    const done = await run(ctx, 'agent:dev', 'k-1', 'run_one')
    expect(done).toMatchObject({ status: 'completed', submitted: true })
    // <worktreeRoot>/<repository name>-<hash of its real path>/<runId>
    const workspace = agent.runs[0]!.workspace
    expect(dirname(dirname(workspace))).toBe(realpathSync(root))
    expect(basename(dirname(workspace))).toMatch(new RegExp(`^${basename(repo)}-[0-9a-f]{12}$`))
    expect(basename(workspace)).toBe('run_one')
    expect(agent.runs[0]).toMatchObject({ sandbox: 'workspace-write' })
    expect(git(workspace, 'symbolic-ref', '--short', 'HEAD')).toBe('system/run/run_one')
    // Branched from the repository's HEAD; the agent's change is in the worktree only.
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toBe(FIXED)
    untouched(repo, head)
    // The result names the worktree and its exact subject, which a review binds to.
    const body = ctx.artifacts.get(done.result!)!.body as { workspace: string; subject: unknown }
    expect(body.workspace).toBe(workspace)
    expect(body.subject).toEqual(captureGitSubject(workspace)!.subject)
    expect(body.subject).toMatchObject({ type: 'git-head', ref: head })
    // A run that belongs to no workflow run works in the configured workspace, as before.
    await run(ctx, 'agent:dev', 'k-alone')
    expect(agent.runs[1]!.workspace).toBe(repo)
  })

  it('reads a workflow run\'s change in its worktree for the operator, read only: each file with its lines and diff, an untracked file as added, a link never followed, a removed worktree\'s from its branch (T122, INV-2)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const outside = temp('system-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'not the run\'s\n')
    const agent = developer({ act: (spec) => { const done = writes(spec); if (spec.sandbox === 'workspace-write') symlinkSync(join(outside, 'secret.txt'), join(spec.workspace, 'leak.txt')); return done } })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_seen')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    const status = git(workspace, 'status', '--porcelain', '--untracked-files=all')
    // The test's own status may refresh the index; what changes() does is measured after it.
    const index = statSync(join(git(workspace, 'rev-parse', '--absolute-git-dir'), 'index')).mtimeMs
    const source = ctx.workers.source('agents')!
    const [change, ...others] = (await source.changes!('run_seen'))!
    expect(others).toEqual([])
    expect(change).toMatchObject({ repository: repo, workspace, branch: 'system/run/run_seen', base: { branch: 'main', sha: head }, head, more: 0, truncated: false })
    expect(change!.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([['calc.py', 'modified', 1, 1], ['leak.txt', 'added', undefined, undefined], ['note-run_seen.txt', 'added', 1, 0]])
    expect(change!.files[0]!.diff).toMatch(/^diff --git a\/calc.py b\/calc.py\n[\s\S]*-    return a - b\n\+    return a \+ b$/)
    // A link is named, never followed out of the worktree; an untracked file reads as added lines.
    expect(change!.files[1]).toEqual({ path: 'leak.txt', status: 'added', note: 'a link or a file that cannot be opened, not read' })
    expect(JSON.stringify(change)).not.toContain('not the run\'s')
    expect(change!.files[2]!.diff).toBe('new file note-run_seen.txt (untracked)\n+k-1')
    // Read only: the worktree, its index, and the repository are as they were.
    expect(statSync(join(git(workspace, 'rev-parse', '--absolute-git-dir'), 'index')).mtimeMs).toBe(index)
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
    untouched(repo, head)
    // A run this source holds no worktree of reads as none; through the registry, with the source's name.
    expect(await source.changes!('run_other')).toBeUndefined()
    expect((await ctx.workers.changes!('run_seen')).changes.map((c) => c.source)).toEqual(['agents'])
    // A worktree whose .git file points elsewhere is not read: an error, never no change (INV-2).
    const pointer = readFileSync(join(workspace, '.git'), 'utf8')
    writeFileSync(join(workspace, '.git'), `gitdir: ${join(repo, '.git')}\n`)
    await expect(source.changes!('run_seen')).rejects.toThrow(/no longer points to the worktree's own directory/)
    expect((await ctx.workers.changes!('run_seen')).unread).toEqual([{ source: 'agents', detail: expect.stringMatching(/no longer points/) }])
    writeFileSync(join(workspace, '.git'), pointer)
    // Removed after the retention: read from its branch, the committed change only.
    rmSync(join(workspace, 'leak.txt'))
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    const [kept] = (await source.changes!('run_seen'))!
    expect(kept).toMatchObject({ fromBranch: true, base: { branch: 'main', sha: head }, head: git(repo, 'rev-parse', 'system/run/run_seen') })
    expect(kept!.files.map((f) => [f.path, f.status])).toEqual([['calc.py', 'modified'], ['note-run_seen.txt', 'added']])
    untouched(repo, head)
  })

  it('gives a reviewer of the same workflow run the writer\'s worktree, and binds its review to that subject (REQ-WF-5, REQ-TEAM-5, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const subjectOf = (prompt: string): string => /^Subject: (\S+)$/m.exec(prompt)![1]!
    const read: string[] = []
    const agent = developer({
      act: (spec) => {
        if (spec.sandbox === 'workspace-write') return writes(spec)
        read.push(readFileSync(join(spec.workspace, 'calc.py'), 'utf8'))
        return '```json\n' + JSON.stringify({ subject: subjectOf(spec.prompt), verdict: 'approve', findings: [{ severity: 'info', title: 'add() now adds' }] }) + '\n```'
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo), reviewer(repo)], worktreeRoot: temp('system-worktrees-') })
    chatWorker(ctx)
    const started = ctx.workflow.start({ template: 'develop', input: 'Fix add()' })
    const deadline = Date.now() + 30_000
    for (;;) {
      const view = ctx.workflow.get(started.runId)
      if (view && view.status !== 'running') break
      if (Date.now() > deadline) throw new Error('never finished')
      if (view?.blocked?.kind === 'gate') ctx.workflow.approve(started.runId, { verdict: 'approved', plan: view.blocked.plan })
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const done = await ctx.workflow.wait(started.runId, 30_000)
    expect(done.status).toBe('completed')
    const [develop, review] = agent.runs
    expect([develop!.sandbox, review!.sandbox]).toEqual(['workspace-write', 'read-only'])
    // One worktree per (repository, workflow run): the writer's, read by the reviewer.
    expect(basename(develop!.workspace)).toBe(started.runId)
    expect(review!.workspace).toBe(develop!.workspace)
    expect(read).toEqual([FIXED])
    expect(git(develop!.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(`system/run/${started.runId}`)
    expect(subjectOf(review!.prompt)).toBe(subjectId(captureGitSubject(develop!.workspace)!.subject))
    expect(review!.prompt).toContain('+    return a + b')
    const [stored] = ctx.artifacts.list({ kind: 'assessment' })
    expect(stored!.body).toMatchObject({ verdict: 'approve', reviewer: 'agent:reviewer' })
    expect(`git:${(stored!.body as { subject: { ref: string } }).subject.ref}:${(stored!.body as { subject: { version: string } }).subject.version}`).toBe(subjectOf(review!.prompt))
    untouched(repo, head)
  })

  it('gives two workflow runs two worktrees on two branches, each with only its own change (INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo), reviewer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-a', 'run_a')).status).toBe('completed')
    expect((await run(ctx, 'agent:dev', 'k-b', 'run_b')).status).toBe('completed')
    const [a, b] = agent.runs.map((r) => r.workspace) as [string, string]
    expect(a).not.toBe(b)
    expect([basename(a), basename(b)]).toEqual(['run_a', 'run_b'])
    expect([git(a, 'symbolic-ref', '--short', 'HEAD'), git(b, 'symbolic-ref', '--short', 'HEAD')]).toEqual(['system/run/run_a', 'system/run/run_b'])
    expect(readdirSync(a).sort()).toEqual(['.git', 'calc.py', 'note-run_a.txt'])
    expect(readdirSync(b).sort()).toEqual(['.git', 'calc.py', 'note-run_b.txt'])
    // A reviewer of run_b reads run_b's tree; of no workflow run, the configured workspace.
    await run(ctx, 'agent:reviewer', 'k-review-b', 'run_b')
    await run(ctx, 'agent:reviewer', 'k-review-alone')
    expect(agent.runs.slice(2).map((r) => r.workspace)).toEqual([b, repo])
    untouched(repo, head)
  })

  it('reuses the stored worktree of a workflow run after a restart, wherever the worktree root now is', async () => {
    const repo = repository()
    const dir = temp('system-agents-')
    const first = developer()
    const before = await boot(first, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') }, dir)
    expect((await run(before.ctx, 'agent:dev', 'k-1', 'run_keep')).status).toBe('completed')
    await before.stop()
    const elsewhere = temp('system-worktrees-')
    const second = developer({ act: () => 'looked again' })
    const after = await boot(second, { workers: [writer(repo)], worktreeRoot: elsewhere }, dir)
    expect((await run(after.ctx, 'agent:dev', 'k-2', 'run_keep')).status).toBe('completed')
    expect(second.runs[0]!.workspace).toBe(first.runs[0]!.workspace)
    expect(readFileSync(join(second.runs[0]!.workspace, 'note-run_keep.txt'), 'utf8')).toBe('k-1\n')
    // No worktree is made there: only the source's private directory, where the run's report file
    // was made beside the worktrees (T265), and removed once the run ended.
    expect(readdirSync(elsewhere)).toEqual(['.setup'])
    expect(readdirSync(join(elsewhere, '.setup'))).toEqual([])
  })

  /** A board task's brief whose files hold `text` as the board's TASKS.md (brief@1.2 files). */
  const taskBrief = (ctx: Context, text: string): `sha256:${string}` => {
    const ref = ctx.artifacts.put({
      kind: 'evidence', bodySchema: 'board-projection@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
      body: { schema: 'board-projection@1.0', projectId: 'p1', format: 'tasks-md', text, tasks: 1, truncated: false },
    }).id
    return ctx.artifacts.put({
      kind: 'objective', bodySchema: 'brief@1.2', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' }, inputs: [ref],
      body: {
        schema: 'brief@1.2', projectId: 'p1', taskId: 'task-1', attempt: 1, goal: 'fix add', acceptance: [{ id: 'a1', statement: 'add adds' }], artifacts: [],
        instructions: [{ text: 'fix add' }], files: [{ path: '.system/TASKS.md', ref, note: 'the board of project p1' }],
        budget: { remaining: [] }, sandbox: { mode: 'read-only', network: 'allow-list', commands: false }, classification: 'operator-shared',
      },
    }).id as `sha256:${string}`
  }
  const briefed = async (ctx: Context, key: string, brief: `sha256:${string}`, runId?: string): Promise<WorkerExecution> => {
    const source = ctx.workers.source('agents')!
    return source.wait(source.start({ key, worker: 'agent:dev', brief, ...(runId ? { runId } : {}), requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 30_000)
  }

  it('writes a board task brief\'s TASKS.md into the run\'s worktree before the agent starts, read-only, under a .system/ git ignores: never in its subject or the retention commit (PROP-0010, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const seen: Array<{ text?: string; mode?: number }> = []
    const agent = developer({
      act: (spec) => {
        const file = join(spec.workspace, '.system', 'TASKS.md')
        seen.push(existsSync(file) ? { text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 } : {})
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const done = await briefed(ctx, 'k-files', taskBrief(ctx, '# p1\n\n### fix add\n'), 'run_files')
    expect(done).toMatchObject({ status: 'completed' })
    // Created read-only, 0o444 less this process's umask (0o400 in a check of a daemon run with umask 077).
    expect(seen[0]).toEqual({ text: '# p1\n\n### fix add\n', mode: READ_ONLY })
    // The prompt names the file, since this source wrote it.
    expect(agent.runs[0]!.prompt).toContain('Files in your workspace, written by system before this run (read-only; edits are never read back):\n- .system/TASKS.md: the board of project p1')
    const workspace = agent.runs[0]!.workspace
    // Ignored by git: the run's subject is its change alone.
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort()).toEqual(['?? note-run_files.txt', 'M calc.py'])
    expect(captureGitSubject(workspace)!.diff).not.toContain('new file .system/')
    expect((ctx.artifacts.get(done.result!)!.body as { subject: unknown }).subject).toEqual(captureGitSubject(workspace)!.subject)
    // The retention commit keeps the work and never the board's file.
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'system/run/run_files').split('\n').sort()).toEqual(['calc.py', 'note-run_files.txt'])
    untouched(repo, head)
    // A run of no workflow run works in the configured workspace: no file there, and the prompt does not name one.
    await briefed(ctx, 'k-alone', taskBrief(ctx, '# p1\n'))
    expect(existsSync(join(repo, '.system'))).toBe(false)
    expect(agent.runs[1]!.prompt).not.toContain('Files in your workspace')
  })

  it('replaces the brief\'s files whole on a later run of the workflow run, whatever the agent did to them, and never writes through a link it left there (INV-15)', async () => {
    const repo = repository()
    const outside = join(temp('system-outside-'), 'kept.txt')
    writeFileSync(outside, 'not the workspace\'s\n')
    const seen: Array<{ text: string; mode: number }> = []
    const agent = developer({
      act: (spec) => {
        const file = join(spec.workspace, '.system', 'TASKS.md')
        seen.push({ text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 })
        if (seen.length === 1) {
          // Made writable and edited: the next run's brief replaces it whole, read-only again.
          chmodSync(file, 0o644)
          writeFileSync(file, 'edited by the agent\n')
        } else {
          // A link left in its place: the next run is refused, and what it points to is untouched.
          rmSync(file)
          symlinkSync(outside, file)
        }
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect(await briefed(ctx, 'k-first', taskBrief(ctx, '# p1\n\n### first\n'), 'run_again')).toMatchObject({ status: 'completed' })
    expect(await briefed(ctx, 'k-second', taskBrief(ctx, '# p1\n\n### second\n'), 'run_again')).toMatchObject({ status: 'completed' })
    expect(seen).toEqual([{ text: '# p1\n\n### first\n', mode: READ_ONLY }, { text: '# p1\n\n### second\n', mode: READ_ONLY }])
    const refused = await briefed(ctx, 'k-third', taskBrief(ctx, '# p1\n\n### third\n'), 'run_again')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(refused.error!.message).toMatch(/TASKS\.md is not a plain file/)
    expect(readFileSync(outside, 'utf8')).toBe('not the workspace\'s\n')
    expect(agent.runs).toHaveLength(2)
    // No temporary file is left beside the brief's files.
    expect(readdirSync(join(agent.runs[0]!.workspace, '.system')).sort()).toEqual(['.gitignore', 'TASKS.md'])
  })

  it('leaves in the run\'s worktree only the files of the brief of the run starting: one an earlier run\'s brief placed is gone before the agent starts, so a step given none (a self-review) reads none (T267)', async () => {
    const repo = repository()
    const seen: Array<{ files: string[]; read: string }> = []
    const agent = developer({
      act: (spec) => {
        const dir = join(spec.workspace, '.system')
        // An actual read attempt of what the step before was given, as the agent would make it.
        const dossier = join(dir, 'DOSSIER.md')
        seen.push({ files: existsSync(dir) ? readdirSync(dir).sort() : [], read: existsSync(dossier) ? readFileSync(dossier, 'utf8') : 'absent' })
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    // The author's step is given the board and the dossier.
    const dossier = ctx.artifacts.put({
      kind: 'report', bodySchema: 'task-dossier@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
      body: { schema: 'task-dossier@1.0', projectId: 'p1', taskId: 'task-1', entries: 1, head: `sha256:${'1'.repeat(64)}`, shown: [], maxChars: 6000, text: 'Plan: the author\'s plan.' },
    }).id
    const withDossier = (base: `sha256:${string}`): `sha256:${string}` => {
      const body = ctx.artifacts.get(base)!.body as { files: unknown[] }
      return ctx.artifacts.put({
        kind: 'objective', bodySchema: 'brief@1.2', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' }, inputs: [dossier],
        body: { ...body, files: [...body.files, { path: '.system/DOSSIER.md', ref: dossier, note: 'the task\'s whole dossier' }] },
      }).id as `sha256:${string}`
    }
    const bare = (base: `sha256:${string}`): `sha256:${string}` => {
      const { files: _files, ...body } = ctx.artifacts.get(base)!.body as { files: unknown[] }
      return ctx.artifacts.put({ kind: 'objective', bodySchema: 'brief@1.2', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' }, body }).id as `sha256:${string}`
    }
    expect(await briefed(ctx, 'k-author', withDossier(taskBrief(ctx, '# p1\n')), 'run_fresh')).toMatchObject({ status: 'completed' })
    // The next step of the same workflow run is given no file: the dossier and the board left by the author's step are gone.
    expect(await briefed(ctx, 'k-self', bare(taskBrief(ctx, '# p1\n')), 'run_fresh')).toMatchObject({ status: 'completed' })
    // A later step given the board only finds the board, never the dossier.
    expect(await briefed(ctx, 'k-review', taskBrief(ctx, '# p1\n'), 'run_fresh')).toMatchObject({ status: 'completed' })
    expect(seen).toEqual([
      { files: ['.gitignore', 'DOSSIER.md', 'TASKS.md'], read: 'Plan: the author\'s plan.' },
      { files: ['.gitignore'], read: 'absent' },
      { files: ['.gitignore', 'TASKS.md'], read: 'absent' },
    ])
  })

  it('refuses a .system the agent replaced with a link, writing nothing through it, and its retirement leaves what the link points to (INV-15)', async () => {
    const repo = repository()
    const outside = temp('system-outside-')
    writeFileSync(join(outside, 'kept.txt'), 'not the workspace\'s\n')
    const agent = developer({
      act: (spec) => {
        // A link out of the workspace in place of system's directory.
        rmSync(join(spec.workspace, '.system'), { recursive: true, force: true })
        symlinkSync(outside, join(spec.workspace, '.system'))
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect(await briefed(ctx, 'k-first', taskBrief(ctx, '# p1\n\n### first\n'), 'run_link')).toMatchObject({ status: 'completed' })
    const refused = await briefed(ctx, 'k-second', taskBrief(ctx, '# p1\n\n### second\n'), 'run_link')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(refused.error!.message).toMatch(/\.system is not a directory of the worktree; nothing is written/)
    expect(agent.runs).toHaveLength(1)
    expect(readdirSync(outside)).toEqual(['kept.txt'])
    // Retired, the link is not system's directory: nothing it points to is removed.
    const workspace = agent.runs[0]!.workspace
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('not the workspace\'s\n')
  })

  it('opens a directory as itself and works through its descriptor: a link swapped in at its name afterwards is never used (INV-15)', () => {
    const base = temp('system-directory-')
    const outside = temp('system-outside-')
    mkdirSync(join(base, '.system'))
    writeFileSync(join(base, 'file'), '')
    symlinkSync(outside, join(base, 'link'))
    expect([openDirectory(join(base, 'link')), openDirectory(join(base, 'file')), openDirectory(join(base, 'none'))]).toEqual(['other', 'other', 'absent'])
    const opened = openDirectory(join(base, '.system'))
    if (typeof opened === 'string') throw new Error(`.system opened as ${opened}`)
    try {
      renameSync(join(base, '.system'), join(base, 'moved'))
      symlinkSync(outside, join(base, '.system'))
      writeFileSync(join(opened.at, 'TASKS.md'), '# p1\n')
      expect(readdirSync(outside)).toEqual([])
      expect(readFileSync(join(base, 'moved', 'TASKS.md'), 'utf8')).toBe('# p1\n')
    } finally {
      closeSync(opened.fd)
    }
  })

  it('checks the brief\'s files at egress with the prompt, and writes none into a repository that tracks .system/: nothing reaches the agent (INV-12, INV-2)', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    // Generated at run time: never a real secret in the repository.
    const secret = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    const leaked = await briefed(ctx, 'k-leak', taskBrief(ctx, `# p1\n${secret}`), 'run_leak')
    expect(leaked).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'egress_denied' } })
    const tracked = repository()
    mkdirSync(join(tracked, '.system'))
    writeFileSync(join(tracked, '.system', 'notes.txt'), 'the repository\'s own\n')
    git(tracked, 'add', '.')
    git(tracked, 'commit', '-q', '-m', 'notes')
    const other = await boot(agent, { workers: [writer(tracked)], worktreeRoot: temp('system-worktrees-') })
    const refused = await briefed(other.ctx, 'k-tracked', taskBrief(other.ctx, '# p1\n'), 'run_tracked')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(refused.error!.message).toMatch(/tracks files under \.system\//)
    expect(agent.runs).toEqual([])
  })

  it('commits a finished workflow run\'s pending changes on its branch, then removes its worktree after the retention, by a recorded decision; a later run of it adds the worktree again from that branch (INV-9, INV-13)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    // What each run found in its tree before it wrote.
    const found: Array<string | undefined> = []
    const agent = developer({
      act: (spec) => {
        const note = join(spec.workspace, 'note-run_done.txt')
        found.push(existsSync(note) ? readFileSync(note, 'utf8') : undefined)
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_done')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    // Within the retention it stays.
    expect(await ctx.agentWorkers.sweepWorktrees()).toEqual({ removed: [], kept: [] })
    expect(existsSync(workspace)).toBe(true)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(existsSync(workspace)).toBe(false)
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workspace)
    // The work is kept: one commit by the system, naming the run, on top of where the branch began.
    expect(git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'system/run/run_done')).toBe('system <system@localhost>|system <system@localhost>|system: keep the uncommitted work of workflow run run_done')
    expect(git(repo, 'rev-parse', 'system/run/run_done^')).toBe(head)
    expect(git(repo, 'show', 'system/run/run_done:calc.py')).toBe(FIXED.trim())
    expect(git(repo, 'show', 'system/run/run_done:note-run_done.txt')).toBe('k-1')
    untouched(repo, head)
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)').split('\n').sort()).toEqual(['main', 'system/run/run_done'])
    // The rule's decision is an artifact of the workflow run (INV-13).
    const [decision, ...more] = ctx.artifacts.list({ kind: 'decision', decisionType: 'retention', runId: 'run_done' })
    expect(more).toEqual([])
    new SchemaRegistry().assertRecord(decision!.body as { schema: string })
    expect(decision!.body).toMatchObject({
      decider: { type: 'rule', id: 'agent-workers.worktree-retention' },
      outcome: { option: 'remove', detail: { runId: 'run_done', path: workspace, branch: 'system/run/run_done', retentionHours: 168 } },
    })
    // A later run of the same workflow run works in it again, from its branch, with that work.
    expect((await run(ctx, 'agent:dev', 'k-2', 'run_done')).status).toBe('completed')
    expect(agent.runs[1]!.workspace).toBe(workspace)
    expect(found).toEqual([undefined, 'k-1\n'])
    expect(git(workspace, 'symbolic-ref', '--short', 'HEAD')).toBe('system/run/run_done')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'system/run/run_done'))
    untouched(repo, head)
  })

  it('keeps the worktree of a workflow run whose agent run ended without being known to be gone, and runs nothing more there, until a verdict says dead (INV-15, PROP-0013)', async () => {
    const repo = repository()
    const agent = new ScriptedAgent({ sandboxes: SANDBOXES, act: writes })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const first = await run(ctx, 'agent:dev', 'k-1', 'run_unknown')
    expect(first.status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    // As a restart leaves it when the verdicts stayed unknown: failed, for the operator, not dead.
    const reconcile = (verdict: string) => ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = ?, liveness_decision = ? WHERE run_id = ?").run(verdict, `sha256:${'1'.repeat(64)}`, first.id)
    reconcile('unknown')
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [] })
    expect(existsSync(workspace)).toBe(true)
    const refused = await run(ctx, 'agent:dev', 'k-2', 'run_unknown')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining(`run ${first.id} of the worktree of workflow run run_unknown ended without being known to be gone (liveness unknown`) } })
    expect(agent.runs).toHaveLength(1)
    reconcile('dead')
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
  })

  it('frees the worktree a run that ended unknown held: a dirty one stays unless the operator asks its changes committed, a clean one is removed, and the branch always stays (PROP-0013, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const first = await run(ctx, 'agent:dev', 'k-1', 'run_free')
    const workspace = agent.runs[0]!.workspace
    // As a restart leaves it when the verdicts stayed unknown; its writes are still uncommitted in the worktree.
    const reconciled = ctx.artifacts.recordDecision({
      decisionType: 'reconciliation', question: 'Is it gone?', inputs: [], candidates: [{ option: 'dead', selected: false, reasons: ['not dead: the verdict is unknown, and only dead is death', 'the agent process: unknown (never reported)'] }, { option: 'operator', selected: true, reasons: ['to the operator'] }],
      decider: { type: 'rule', id: 'agent-workers.reconcile', version: '2' }, outcome: { option: 'operator' }, deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, runId: 'run_free' }).id
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = 'unknown', liveness_looks = 3, liveness_decision = ? WHERE run_id = ?").run(reconciled, first.id)
    const told = (await ctx.workers.liveness!({ runId: 'run_free' })).runs
    expect(told).toEqual([expect.objectContaining({ execution: first.id, state: 'unknown', holds: [`worktree ${workspace} (branch system/run/run_free)`], reasons: ['the agent process: unknown (never reported)'] })])
    // Dirty, no commit asked: freed, the worktree kept with its changes, and said why.
    const freed = await ctx.agentWorkers.free({ agentRun: first.id, agentGone: true })
    expect(freed.freed).toEqual([`worktree ${workspace} (branch system/run/run_free)`])
    expect(freed.worktrees).toEqual([{ path: workspace, branch: 'system/run/run_free', outcome: 'kept', why: expect.stringContaining('it holds uncommitted changes, so it stays') }])
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toBe(FIXED)
    expect((ctx.artifacts.get(freed.decision)!.body as { outcome: { detail: { worktrees: unknown } } }).outcome.detail.worktrees).toEqual([{ path: workspace, branch: 'system/run/run_free', outcome: 'kept' }])
    // Freed again with the commit asked: its changes kept on its branch, then removed; the branch stays.
    const committed = await ctx.agentWorkers.free({ agentRun: first.id, agentGone: true, commitWorktree: true })
    expect(committed).toMatchObject({ again: true, freed: [], worktrees: [{ path: workspace, outcome: 'removed', commit: expect.stringMatching(/^[0-9a-f]{40}$/) }] })
    expect(existsSync(workspace)).toBe(false)
    expect(git(repo, 'show', 'system/run/run_free:calc.py')).toBe(FIXED.trim())
    expect(ctx.store.db.prepare('SELECT decision FROM agent_worktrees WHERE workflow_run_id = ?').get('run_free')).toEqual({ decision: committed.decision })
    untouched(repo, head)
    // The workflow run's next agent run is no longer refused: it works in its worktree again, added from its branch.
    expect((await run(ctx, 'agent:dev', 'k-2', 'run_free')).status).toBe('completed')
    expect(readFileSync(join(workspace, 'note-run_free.txt'), 'utf8')).toBe('k-2\n')
    // A clean worktree is removed without the flag.
    const second = ctx.store.db.prepare("SELECT run_id AS id FROM agent_runs WHERE workflow_run_id = 'run_free' AND run_id != ?").get(first.id) as { id: string }
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '-q', '-m', 'the operator kept it')
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = 'unknown', liveness_decision = ? WHERE run_id = ?").run(reconciled, second.id)
    expect((await ctx.agentWorkers.free({ agentRun: second.id, agentGone: true })).worktrees).toEqual([{ path: workspace, branch: 'system/run/run_free', outcome: 'removed', why: 'it holds nothing uncommitted: it is removed, and its branch stays' }])
    expect(existsSync(workspace)).toBe(false)
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_free')).toBe('the operator kept it')
  })

  it('keeps a worktree while its workflow run has an agent run to finish, and leaves one it cannot remove in place, committed, for the next sweep (INV-9)', async () => {
    const repo = repository()
    const options = { sandboxes: SANDBOXES, act: writes, holdMs: 0 }
    const agent = new ScriptedAgent(options)
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_busy')).status).toBe('completed')
    // A second agent run of the workflow run is still running: the worktree is not looked at.
    options.holdMs = 30_000
    const source = ctx.workers.source('agents')!
    const busy = source.start({ key: 'k-2', worker: 'agent:dev', prompt: 'more', runId: 'run_busy', requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    while (agent.runs.length < 2) await new Promise((resolve) => setTimeout(resolve, 20))
    const workspace = agent.runs[0]!.workspace
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [] })
    expect(source.cancel!(busy.id)).toBe(true)
    await source.wait(busy.id, 10_000)
    // Locked by the operator: its changes are committed, the removal is refused, and it stays.
    git(repo, 'worktree', 'lock', workspace)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [workspace] })
    expect(existsSync(join(workspace, 'note-run_busy.txt'))).toBe(true)
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_busy')).toBe('system: keep the uncommitted work of workflow run run_busy')
    git(repo, 'worktree', 'unlock', workspace)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(git(repo, 'rev-list', '--count', 'main..system/run/run_busy')).toBe('1')
    // Retried under the one decision that retires it.
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'retention', runId: 'run_busy' })).toHaveLength(1)
  })

  it('forgets a worktree the operator removed by hand, and adds it again from its branch for a later run (INV-9)', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_hand')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '-q', '-m', 'by hand')
    git(repo, 'worktree', 'remove', workspace)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_hand')).toBe('by hand')
    expect((await run(ctx, 'agent:dev', 'k-2', 'run_hand')).status).toBe('completed')
    expect(agent.runs[1]!.workspace).toBe(workspace)
    expect(git(workspace, 'log', '-1', '--format=%s')).toBe('by hand')
  })

  it('keeps every worktree with worktreeRetentionHours 0', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeRetentionHours: 0 })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_kept')).status).toBe('completed')
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [] })
    expect(existsSync(agent.runs[0]!.workspace)).toBe(true)
  })

  it('lists each run worktree with its state, what it holds, and when it retires, and removes the finished ones on the operator\'s recorded word: a clean one, a dirty one only with its changes committed on its branch, never one held; the branch stays (D12, INV-13, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeRetentionHours: 24 })
    for (const runId of ['run_clean', 'run_dirty', 'run_held']) expect((await run(ctx, 'agent:dev', `k-${runId}`, runId)).status).toBe('completed')
    const path = (runId: string): string => agent.runs.find((r) => basename(r.workspace) === runId)!.workspace
    // run_clean's work committed on its branch by hand; run_dirty's left uncommitted; run_held's agent not known to be gone.
    git(path('run_clean'), 'add', '--all')
    git(path('run_clean'), 'commit', '-q', '-m', 'kept by hand')
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = 'unknown', liveness_decision = ? WHERE workflow_run_id = 'run_held'").run(`sha256:${'1'.repeat(64)}`)

    const listing = await ctx.agentWorkers.runWorktrees()
    expect(listing).toMatchObject({ retentionHours: 24, total: 3 })
    expect(listing.worktrees.map((w) => [w.runId, w.state, w.changes, w.branch])).toEqual([
      ['run_clean', 'finished', 'clean', 'system/run/run_clean'], ['run_dirty', 'finished', 'uncommitted', 'system/run/run_dirty'], ['run_held', 'held', 'uncommitted', 'system/run/run_held'],
    ])
    const [clean, , held] = listing.worktrees
    expect(Date.parse(clean!.retiresAt!) - Date.parse(clean!.lastActivityAt)).toBe(24 * 60 * 60_000)
    expect(held!.retiresAt).toBeUndefined()
    expect(await ctx.agentWorkers.runWorktrees({ limit: 1 })).toMatchObject({ total: 3, worktrees: [{ runId: 'run_clean' }] })

    // Every finished one: the clean one removed, the dirty and the held ones kept, by one decision of the operator's.
    const removed = await ctx.agentWorkers.removeWorktrees({ note: 'merged' })
    expect(removed.worktrees.map((w) => [w.runId, w.outcome])).toEqual([['run_clean', 'removed'], ['run_dirty', 'kept'], ['run_held', 'kept']])
    expect(removed.worktrees[1]!.why).toMatch(/holds uncommitted changes, so it stays/)
    expect(removed.worktrees[2]!.why).toMatch(/ended without being known to be gone \(free it first: system free\)/)
    expect(existsSync(path('run_clean'))).toBe(false)
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_clean')).toBe('kept by hand')
    expect(readFileSync(join(path('run_dirty'), 'calc.py'), 'utf8')).toBe(FIXED)
    const decision = ctx.artifacts.get(removed.decision!)!
    new SchemaRegistry().assertRecord(decision.body as { schema: string })
    expect(decision).toMatchObject({ producer: { type: 'operator' }, body: {
      decisionType: 'retention', decider: { type: 'operator', id: 'operator.worktrees' }, rationale: 'merged',
      outcome: { option: 'remove', detail: { commitChanges: false, worktrees: [{ runId: 'run_clean', path: path('run_clean'), branch: 'system/run/run_clean' }] } },
    } })
    // The dirty one with its changes committed on its branch first: nothing is discarded.
    const committed = await ctx.agentWorkers.removeWorktrees({ runId: 'run_dirty', commitChanges: true })
    expect(committed.worktrees).toEqual([expect.objectContaining({ runId: 'run_dirty', outcome: 'removed', commit: expect.stringMatching(/^[0-9a-f]{40}$/) })])
    expect(git(repo, 'show', 'system/run/run_dirty:calc.py')).toBe(FIXED.trim())
    // Nothing left to remove: nothing is decided; the held one stays until the operator frees its run.
    const decisions = ctx.artifacts.list({ kind: 'decision', decisionType: 'retention' }).length
    expect(await ctx.agentWorkers.removeWorktrees({ commitChanges: true })).toEqual({ worktrees: [expect.objectContaining({ runId: 'run_held', outcome: 'kept' })], more: 0 })
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'retention' })).toHaveLength(decisions)
    expect(existsSync(path('run_held'))).toBe(true)
    await expect(ctx.agentWorkers.removeWorktrees({ runId: '../x' })).rejects.toThrow(/not a workflow run id/)
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)').split('\n').sort()).toEqual(['main', 'system/run/run_clean', 'system/run/run_dirty', 'system/run/run_held'])
    untouched(repo, head)
  })

  /** Worktrees of finished workflow runs, added as a run's are and recorded at fixed instants, oldest first, with no agent run. */
  const finished = (ctx: Context, repo: string, root: string, runIds: string[]): string[] => runIds.map((runId, i) => {
    const path = join(root, runId)
    git(repo, 'worktree', 'add', '-q', '-b', `system/run/${runId}`, path)
    ctx.store.db.prepare('INSERT INTO agent_worktrees (repository, workflow_run_id, path, branch, gitdir, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(repo, runId, path, `system/run/${runId}`, realpathSync(git(path, 'rev-parse', '--absolute-git-dir')), new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString())
    return path
  })

  it('removes 40 finished worktrees in one call, recorded as one decision its schema accepts: the reasons counted by why, every worktree named in its outcome (T250, INV-13)', async () => {
    const repo = realpathSync(repository())
    const head = git(repo, 'rev-parse', 'HEAD')
    const root = realpathSync(temp('system-worktrees-'))
    const { ctx } = await boot(developer(), { workers: [writer(repo)], worktreeRoot: root })
    const runIds = Array.from({ length: 40 }, (_, i) => `run_many${String(i).padStart(2, '0')}`)
    const paths = finished(ctx, repo, root, runIds)
    // One removed by hand: only its record is closed, for a reason of its own.
    git(repo, 'worktree', 'remove', paths[7]!)
    const removed = await ctx.agentWorkers.removeWorktrees({ note: 'merged' })
    expect(removed.more).toBe(0)
    expect(removed.worktrees.map((w) => [w.runId, w.outcome])).toEqual(runIds.map((runId) => [runId, 'removed']))
    for (const path of paths) expect(existsSync(path)).toBe(false)
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'retention' })).toHaveLength(1)
    const decision = ctx.artifacts.get(removed.decision!)!
    new SchemaRegistry().assertRecord(decision.body as { schema: string })
    const body = decision.body as { candidates: Array<{ option: string; reasons: string[] }>; outcome: { detail: { worktrees: Array<{ runId: string; path: string }> } } }
    expect(body.candidates[0]!.reasons).toEqual([
      '40 worktrees, each named in the outcome\'s detail; the operator asked to remove the finished worktrees: merged',
      '39 worktree(s): it holds nothing uncommitted: it is removed, and its branch stays',
      '1 worktree(s): it is gone from disk already: only its record is closed',
    ])
    expect(body.outcome.detail.worktrees.map((w) => [w.runId, w.path])).toEqual(runIds.map((runId, i) => [runId, paths[i]]))
    expect(ctx.store.db.prepare('SELECT DISTINCT decision FROM agent_worktrees').all()).toEqual([{ decision: removed.decision }])
    // The branches stay; the main working tree is as the operator left it.
    expect(git(repo, 'branch', '--list', 'system/run/*', '--format=%(refname:short)').split('\n')).toEqual(runIds.map((runId) => `system/run/${runId}`))
    untouched(repo, head)
  })

  it('goes on with the other worktrees when git cannot look at one or cannot remove another: each stays, and says why (T250)', async () => {
    const repo = realpathSync(repository())
    const root = realpathSync(temp('system-worktrees-'))
    const { ctx } = await boot(developer(), { workers: [writer(repo)], worktreeRoot: root })
    const runIds = ['run_one0', 'run_one1', 'run_one2', 'run_one3', 'run_one4']
    const paths = finished(ctx, repo, root, runIds)
    // Locked: git refuses to remove it. A broken index: git cannot say what it holds.
    git(repo, 'worktree', 'lock', paths[1]!)
    writeFileSync(join(git(paths[3]!, 'rev-parse', '--absolute-git-dir'), 'index'), 'broken')
    const removed = await ctx.agentWorkers.removeWorktrees({})
    expect(removed.worktrees.map((w) => [w.runId, w.outcome])).toEqual([['run_one0', 'removed'], ['run_one1', 'kept'], ['run_one2', 'removed'], ['run_one3', 'kept'], ['run_one4', 'removed']])
    expect(removed.worktrees[1]!.why).toMatch(/^git could not remove it, so it stays for the retention: /)
    expect(removed.worktrees[3]!.why).toMatch(/^git could not look at it, so it stays: /)
    expect(runIds.map((_, i) => existsSync(paths[i]!))).toEqual([false, true, false, true, false])
    new SchemaRegistry().assertRecord(ctx.artifacts.get(removed.decision!)!.body as { schema: string })
    expect(ctx.store.db.prepare('SELECT workflow_run_id AS runId FROM agent_worktrees WHERE removed_at IS NULL ORDER BY workflow_run_id').all()).toEqual([{ runId: 'run_one1' }, { runId: 'run_one3' }])
  })

  it('serves the run worktree tools to the operator, each output as its schema says, and checks the removal\'s output on its plan before anything is decided: a defect removes nothing (D12, INV-2, INV-14)', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_tool')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '-q', '-m', 'done')
    const tools = new Map<string, { scope?: string; handler: ToolHandler }>()
    registerRunTools({ mcp: { tool: (name: string, spec: ToolSpec, handler: ToolHandler) => tools.set(name, { ...(spec.scope ? { scope: spec.scope } : {}), handler }) } } as unknown as Context, ctx.agentWorkers)
    expect([...tools].map(([name, t]) => [name, t.scope])).toEqual([['agent_run_free', 'operator'], ['agent_worktrees', 'operator'], ['agent_worktrees_remove', 'operator']])
    const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.handler(args, { scope: 'operator' })
    const listed = await call('agent_worktrees', {})
    new SchemaRegistry().assertDef('mcp-agent-runs@1.1', 'agent-worktrees-output', listed.structuredContent)
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining('run_tool  finished, clean, retires ') })
    expect((await call('agent_worktrees_remove', { runId: 'run tool' })).content[0]).toMatchObject({ text: expect.stringMatching(/^invalid input, nothing done/) })
    // A defect: the removal's output is one its schema refuses.
    const assertDef = SchemaRegistry.prototype.assertDef
    const spy = vi.spyOn(SchemaRegistry.prototype, 'assertDef').mockImplementation(function (this: SchemaRegistry, tag, def, value) {
      if (def === 'agent-worktrees-remove-output') throw new SchemaError(`${tag}#/$defs/${def}`, [], 'a defect')
      assertDef.call(this, tag, def, value)
    })
    onTestFinished(() => spy.mockRestore())
    const refused = await call('agent_worktrees_remove', {})
    expect([refused.isError, refused.content[0]]).toEqual([true, { type: 'text', text: expect.stringMatching(/^agent_worktrees_remove would make an output its schema refuses \(a defect\), so nothing changed/) }])
    expect(existsSync(workspace)).toBe(true)
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'retention' })).toEqual([])
    spy.mockRestore()
    const removed = await call('agent_worktrees_remove', { note: 'merged' })
    new SchemaRegistry().assertDef('mcp-agent-runs@1.1', 'agent-worktrees-remove-output', removed.structuredContent)
    expect(removed.structuredContent).toMatchObject({ decision: expect.stringMatching(/^sha256:/), worktrees: [{ runId: 'run_tool', outcome: 'removed' }], more: 0 })
    expect(existsSync(workspace)).toBe(false)
  })

  it('distrusts a worktree whose .git file the agent pointed elsewhere: the run fails, and git never runs there again', async () => {
    const repo = repository()
    const decoy = repository()
    const agent = developer({
      act: (spec) => {
        writeFileSync(join(spec.workspace, '.git'), `gitdir: ${join(decoy, '.git')}\n`)
        return 'done'
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const done = await run(ctx, 'agent:dev', 'k-1', 'run_moved')
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', message: expect.stringContaining('.git file') } })
    // Its own violation, not the infrastructure's: never marked so (ADR-0069).
    expect(done.error).not.toHaveProperty('infrastructure')
    // A later run of the workflow run and the sweep both refuse it, and leave it for the operator.
    expect(await run(ctx, 'agent:dev', 'k-2', 'run_moved')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('no longer points') } })
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [agent.runs[0]!.workspace] })
    expect(agent.runs).toHaveLength(1)
    expect(git(decoy, 'branch', '--list', '--format=%(refname:short)')).toBe('main')
    expect(git(decoy, 'status', '--porcelain')).toBe('')
  })

  it('fails a run whose working tree git cannot read afterwards: its result is never stored without its subject (INV-2, INV-5)', async () => {
    const repo = repository()
    const agent = developer({
      act: (spec) => {
        // git now refuses the repository ("bad config line"): its subject is unknown, not absent.
        writeFileSync(join(spec.workspace, '.git', 'config'), '[broken\n')
        return 'done'
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const done = await run(ctx, 'agent:dev', 'k-unreadable')
    expect(agent.runs[0]!.workspace).toBe(repo)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', message: expect.stringMatching(/cannot be read: git rev-parse failed \(fatal: bad config line 1/) } })
    expect(done.result).toBeUndefined()
  })

  it('refuses worktreePerRun on a workspace that is not the top level of a git repository: the Worker takes no work, and a run fails as config_error before the agent starts', async () => {
    const plain = temp('system-plain-')
    const agent = developer()
    const root = temp('system-worktrees-')
    const { ctx } = await boot(agent, { workers: [writer(plain)], worktreeRoot: root })
    expect((await ctx.workers.list())[0]).toMatchObject({ worker: 'agent:dev', state: 'unavailable', capabilities: [] })
    expect(await run(ctx, 'agent:dev', 'k-1', 'run_x')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('not a git working tree') } })
    // A directory inside a repository is not one either: a worktree is of the whole repository.
    const inside = join(repository(), 'pkg')
    mkdirSync(inside)
    const nested = await boot(agent, { workers: [writer(inside)], worktreeRoot: root })
    expect((await nested.ctx.workers.list())[0]).toMatchObject({ state: 'unavailable' })
    expect(await run(nested.ctx, 'agent:dev', 'k-2', 'run_x')).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('not the top level') } })
    // Nor is a repository that holds the worktree root: its worktrees would be files of its main working tree.
    const holder = repository()
    const holding = await boot(agent, { workers: [writer(holder)], worktreeRoot: join(holder, 'worktrees') })
    expect((await holding.ctx.workers.list())[0]).toMatchObject({ state: 'unavailable' })
    expect(await run(holding.ctx, 'agent:dev', 'k-4', 'run_x')).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('lies inside') } })
    expect(existsSync(join(holder, 'worktrees'))).toBe(false)
    expect(agent.runs).toEqual([])
    expect(readdirSync(root)).toEqual([])
    // A run id is a branch and a directory name: anything else is refused at once.
    expect(() => ctx.workers.source('agents')!.start({ key: 'k-3', worker: 'agent:dev', prompt: 'x', runId: '../escape', requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }))
      .toThrow(/run id/)
  })

  it('refuses at load Workers that share a workspace and disagree on worktreePerRun: a reviewer must read the writer\'s tree', () => {
    const repo = repository()
    expect(() => new AgentWorkers(new Context(), { workers: [writer(repo), worker({ id: 'reviewer', workspace: repo })] })).toThrow(/share the workspace/)
  })

  describe('carrying an earlier run\'s work into a new run\'s worktree (ADR-0061)', () => {
    type Tree = { runId: string; workspace: string; subject: { ref: string; version: string } }
    /** A finished writing run of workflow run `runId`: its worktree, and the exact subject it left there. */
    const wrote = async (ctx: Context, agent: ScriptedAgent, runId: string): Promise<Tree> => {
      expect((await run(ctx, 'agent:dev', `k-${runId}`, runId)).status).toBe('completed')
      const workspace = agent.runs.at(-1)!.workspace
      const { ref, version } = captureGitSubject(workspace)!.subject
      return { runId, workspace, subject: { ref, version } }
    }
    const carry = (ctx: Context, runId: string, from: Tree) => ctx.workers.carry!({ runId, from, message: `system: carry into ${runId}\n\nWhy it is carried.` })
    const rowOf = (ctx: Context, runId: string) => ctx.store.db.prepare('SELECT carried_from, carried_commit FROM agent_worktrees WHERE workflow_run_id = ?').get(runId)

    it('commits the earlier tree on its branch and cuts the new run\'s worktree at its base holding it, staged; a carry asked again finds it done, and the new run works there on that change (INV-4, INV-5, INV-15)', async () => {
      const repo = repository()
      const head = git(repo, 'rev-parse', 'HEAD')
      const root = temp('system-worktrees-')
      const seen: string[] = []
      const agent = developer({
        act: (spec) => {
          seen.push(readFileSync(join(spec.workspace, 'calc.py'), 'utf8'))
          return writes(spec)
        },
      })
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: root })
      const earlier = await wrote(ctx, agent, 'run_p')
      const worktree = join(dirname(earlier.workspace), 'run_r')
      const carried = await carry(ctx, 'run_r', earlier)
      expect(carried).toEqual({
        outcome: 'carried', source: 'agents', repository: realpathSync(repo), from: { branch: 'system/run/run_p', commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
        base: head, branch: 'system/run/run_r', worktree, carried: true,
      })
      const commit = (carried as { from: { commit: string } }).from.commit
      // The earlier change, committed on its own branch by the system, on top of the base, naming the run that starts from it.
      expect(git(earlier.workspace, 'status', '--porcelain')).toBe('')
      expect(git(repo, 'rev-parse', 'system/run/run_p')).toBe(commit)
      expect(git(repo, 'rev-parse', `${commit}^`)).toBe(head)
      expect(git(repo, 'log', '-1', '--format=%an <%ae>', commit)).toBe('system <system@localhost>')
      expect(git(repo, 'log', '-1', '--format=%B', commit)).toBe(`system: carry into run_r\n\nWhy it is carried.\nSystem-Subject: ${subjectId({ type: 'git-head', ...earlier.subject })}\nSystem-Carried-To: run_r`)
      // The new worktree: its own branch at the base, holding that change as its own, staged.
      expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('system/run/run_r')
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('calc.py\nnote-run_p.txt')
      expect(readFileSync(join(worktree, 'calc.py'), 'utf8')).toBe(FIXED)
      expect(captureGitSubject(worktree)!.subject.ref).toBe(head)
      expect(rowOf(ctx, 'run_r')).toEqual({ carried_from: 'run_p', carried_commit: commit })
      // Asked again (a restart before the engine recorded it): found done, nothing made twice.
      expect(await carry(ctx, 'run_r', earlier)).toMatchObject({ outcome: 'carried', from: { commit }, worktree, carried: false })
      expect(git(repo, 'rev-parse', 'system/run/run_p')).toBe(commit)
      // The new run works in it, on the earlier change.
      expect((await run(ctx, 'agent:dev', 'k-r', 'run_r')).status).toBe('completed')
      expect(agent.runs.at(-1)!.workspace).toBe(worktree)
      expect(seen).toEqual([ORIGINAL, FIXED])
      untouched(repo, head)
      // A worktree no source holds is no one's to carry.
      expect(await carry(ctx, 'run_x', { ...earlier, runId: 'run_nobody' })).toBeUndefined()
    })

    it('carries nothing from a tree that moved, holds no change, was removed, is not intact, or whose base moved, nor into a run that has a worktree: each refused with why, the earlier tree left as it was, nothing cut (INV-2, INV-5)', async () => {
      const repo = repository()
      const head = git(repo, 'rev-parse', 'HEAD')
      const agent = developer({ act: (spec) => (spec.prompt === 'k-run_empty' ? 'nothing to change' : writes(spec)) })
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })

      const moved = await wrote(ctx, agent, 'run_moved')
      writeFileSync(join(moved.workspace, 'later.txt'), 'written after the writing step\n')
      expect(await carry(ctx, 'run_moved_next', moved)).toMatchObject({ outcome: 'refused', cause: 'moved', source: 'agents', reason: expect.stringMatching(/is now git:.*, not git:.* as its writing step left it: it changed since, so its work is not carried/) })
      expect(git(moved.workspace, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort()).toEqual(['?? later.txt', '?? note-run_moved.txt', 'M calc.py'])

      const empty = await wrote(ctx, agent, 'run_empty')
      expect(await carry(ctx, 'run_empty_next', empty)).toMatchObject({ outcome: 'refused', cause: 'empty', reason: expect.stringMatching(/holds no change on [0-9a-f]+: there is no work to carry/) })

      const gone = await wrote(ctx, agent, 'run_gone')
      expect(await ctx.agentWorkers.removeWorktrees({ runId: 'run_gone', commitChanges: true })).toMatchObject({ worktrees: [{ outcome: 'removed' }] })
      expect(await carry(ctx, 'run_gone_next', gone)).toMatchObject({ outcome: 'refused', cause: 'gone', reason: expect.stringMatching(/was removed \(its branch system\/run\/run_gone keeps what the retention committed\)/) })

      const tampered = await wrote(ctx, agent, 'run_tampered')
      writeFileSync(join(tampered.workspace, '.git'), `gitdir: ${join(repository(), '.git')}\n`)
      expect(await carry(ctx, 'run_tampered_next', tampered)).toMatchObject({ outcome: 'refused', cause: 'failed', reason: expect.stringMatching(/no longer points to the worktree's own directory/) })

      const taken = await wrote(ctx, agent, 'run_taken')
      expect((await run(ctx, 'agent:dev', 'k-own', 'run_taken_next')).status).toBe('completed')
      expect(await carry(ctx, 'run_taken_next', taken)).toMatchObject({ outcome: 'refused', cause: 'exists', reason: expect.stringMatching(/already has the worktree .*, cut from the HEAD of .*: it is not cut again/) })

      const branched = await wrote(ctx, agent, 'run_branched')
      git(repo, 'branch', 'system/run/run_branched_next', head)
      expect(await carry(ctx, 'run_branched_next', branched)).toMatchObject({ outcome: 'refused', cause: 'exists', reason: 'the branch system/run/run_branched_next exists already, and a branch is never taken over' })
      expect(git(branched.workspace, 'status', '--porcelain')).toContain('calc.py')

      const based = await wrote(ctx, agent, 'run_based')
      writeFileSync(join(repo, 'README.md'), 'calc\n')
      git(repo, 'add', 'README.md')
      git(repo, 'commit', '-q', '-m', 'operator: a readme')
      // The task still writes the commit the repository moved past (T271): a fresh worktree starts at the HEAD, so nothing is carried.
      expect(await ctx.workers.carry!({ runId: 'run_based_next', from: based, onto: head, message: 'system: carry' })).toMatchObject({ outcome: 'refused', cause: 'base-moved', reason: expect.stringMatching(new RegExp(`now, not ${head}, the commit the task writes`)) })
      expect(git(based.workspace, 'status', '--porcelain')).toContain('calc.py')

      // None of them cut a worktree or a branch for the run that would have started from it.
      for (const runId of ['run_moved_next', 'run_empty_next', 'run_gone_next', 'run_tampered_next', 'run_based_next']) {
        expect(existsSync(join(dirname(based.workspace), runId))).toBe(false)
        expect(git(repo, 'branch', '--list', `system/run/${runId}`)).toBe('')
      }
      // And no earlier branch moved but the removed one's, which the operator's removal committed.
      for (const runId of ['run_moved', 'run_empty', 'run_tampered', 'run_taken', 'run_branched', 'run_based']) expect(git(repo, 'rev-parse', `system/run/${runId}`)).toBe(head)
    })

    it('carries the earlier change onto the repository\'s HEAD that moved since, replayed without conflict: the new worktree starts at the HEAD holding the change, and the earlier branch keeps it on its own base (T271)', async () => {
      const repo = repository()
      const head = git(repo, 'rev-parse', 'HEAD')
      const agent = developer()
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
      const earlier = await wrote(ctx, agent, 'run_p')
      // Dev moves on meanwhile, by a change the earlier one does not touch.
      writeFileSync(join(repo, 'README.md'), 'calc\n')
      git(repo, 'add', 'README.md')
      git(repo, 'commit', '-q', '-m', 'operator: a readme')
      const moved = git(repo, 'rev-parse', 'HEAD')
      const step = { runId: 'run_r', from: earlier, onto: moved, message: 'system: carry into run_r' }
      const carried = await ctx.workers.carry!(step)
      expect(carried).toMatchObject({ outcome: 'carried', base: moved, rebase: { outcome: 'rebased', from: head, onto: moved }, branch: 'system/run/run_r', carried: true })
      const commit = (carried as { from: { commit: string } }).from.commit
      // The attempt's change stays on its own branch, on its own base.
      expect(git(repo, 'rev-parse', 'system/run/run_p')).toBe(commit)
      expect(git(repo, 'rev-parse', `${commit}^`)).toBe(head)
      // The new worktree: at the moved HEAD, holding the earlier change and the move both.
      const worktree = join(dirname(earlier.workspace), 'run_r')
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(moved)
      expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('calc.py\nnote-run_p.txt')
      expect(readFileSync(join(worktree, 'calc.py'), 'utf8')).toBe(FIXED)
      expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('calc\n')
      expect(captureGitSubject(worktree)!.subject.ref).toBe(moved)
      // Asked again (a restart before the engine recorded it): found done, at the HEAD it was cut at, the replay said again (INV-4).
      expect(await ctx.workers.carry!(step)).toMatchObject({ outcome: 'carried', base: moved, carried: false, rebase: { outcome: 'rebased', from: head, onto: moved } })
    })

    it('carries the earlier change at its own base when the HEAD that moved conflicts with it, naming the conflict for the Worker to resolve (T271)', async () => {
      const repo = repository()
      const head = git(repo, 'rev-parse', 'HEAD')
      const agent = developer()
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
      const earlier = await wrote(ctx, agent, 'run_p')
      // Dev changes the very file the earlier change changed.
      writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return b + a\n')
      git(repo, 'commit', '-q', '-am', 'operator: calc another way')
      const moved = git(repo, 'rev-parse', 'HEAD')
      const step = { runId: 'run_r', from: earlier, onto: moved, message: 'system: carry into run_r' }
      const carried = await ctx.workers.carry!(step)
      expect(carried).toMatchObject({ outcome: 'carried', base: head, rebase: { outcome: 'conflict', from: head, onto: moved, files: ['calc.py'] }, carried: true })
      // Still the earlier change, on its own base: nothing of the move is mixed in.
      const worktree = join(dirname(earlier.workspace), 'run_r')
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
      expect(readFileSync(join(worktree, 'calc.py'), 'utf8')).toBe(FIXED)
      expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('calc.py\nnote-run_p.txt')
      // Asked again (a restart before the engine recorded it): found done, the conflict said again with its files (INV-4).
      expect(await ctx.workers.carry!(step)).toMatchObject({ outcome: 'carried', base: head, carried: false, rebase: { outcome: 'conflict', from: head, onto: moved, files: ['calc.py'] } })
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
      // Cut before a restart and never given the tree: given it when asked again, and the conflict said again (INV-4).
      ctx.store.db.prepare("UPDATE agent_worktrees SET carried_commit = NULL WHERE workflow_run_id = 'run_r'").run()
      git(worktree, 'read-tree', '-u', '--reset', head)
      expect(await ctx.workers.carry!(step)).toMatchObject({ outcome: 'carried', base: head, carried: true, rebase: { outcome: 'conflict', from: head, onto: moved, files: ['calc.py'] } })
      expect(readFileSync(join(worktree, 'calc.py'), 'utf8')).toBe(FIXED)
    })

    it('takes the earlier tree as the system kept it when its attempt ended: a commit of exactly that subject on its base, committed by the landing\'s commit step (T271)', async () => {
      const repo = repository()
      const head = git(repo, 'rev-parse', 'HEAD')
      const agent = developer()
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
      const earlier = await wrote(ctx, agent, 'run_p')
      // The attempt ended unaccepted: its change is kept on its branch, as the landing's commit step commits it.
      const kept = await ctx.workers.land!({ step: 'commit', runId: 'run_p', workspace: earlier.workspace, subject: earlier.subject, message: 'system: keep the change of attempt 1' })
      expect(kept).toMatchObject({ outcome: 'committed', committed: true })
      const commit = (kept as { head: string }).head
      expect(git(repo, 'rev-parse', `${commit}^`)).toBe(head)
      const carried = await carry(ctx, 'run_r', earlier)
      expect(carried).toMatchObject({ outcome: 'carried', from: { branch: 'system/run/run_p', commit }, base: head, carried: true })
      expect(git(repo, 'rev-parse', 'system/run/run_p')).toBe(commit)
      expect(git(join(dirname(earlier.workspace), 'run_r'), 'diff', '--cached', '--name-only')).toBe('calc.py\nnote-run_p.txt')
    })

    it('carries nothing while an agent run of the earlier workflow run is unfinished: it may still write the tree (INV-15)', async () => {
      const repo = repository()
      const agent = developer({ holdMs: 1500 })
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
      const earlier = await wrote(ctx, agent, 'run_busy')
      const source = ctx.workers.source('agents')!
      const again = source.start({ key: 'k-busy-2', worker: 'agent:dev', prompt: 'more', runId: 'run_busy', requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
      expect(await carry(ctx, 'run_busy_next', earlier)).toMatchObject({ outcome: 'refused', cause: 'busy', reason: expect.stringMatching(/unfinished or not known to be gone, so it may still write/) })
      expect((await source.wait(again.id, 30_000)).status).toBe('completed')
    })

    it('gives a worktree cut before a restart the work it was cut for, runs nothing in it meanwhile, and makes it fresh again once that work can no longer be given (INV-4, INV-2)', async () => {
      const repo = repository()
      const head = git(repo, 'rev-parse', 'HEAD')
      const agent = developer()
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
      const earlier = await wrote(ctx, agent, 'run_p')
      const carried = await carry(ctx, 'run_r', earlier) as { worktree: string; from: { commit: string } }
      /** The worktree and its row as a crash between the cut and the reading of the tree leaves them. */
      const crashed = (): void => {
        ctx.store.db.prepare("UPDATE agent_worktrees SET carried_commit = NULL WHERE workflow_run_id = 'run_r'").run()
        git(carried.worktree, 'read-tree', '-u', '--reset', head)
      }
      crashed()
      expect(await run(ctx, 'agent:dev', 'k-r-1', 'run_r')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringMatching(/was cut to start from the work of run run_p, and that work is not in it; nothing runs there/) } })
      expect(await carry(ctx, 'run_r', earlier)).toMatchObject({ outcome: 'carried', from: { commit: carried.from.commit }, carried: true })
      expect(readFileSync(join(carried.worktree, 'calc.py'), 'utf8')).toBe(FIXED)
      expect(rowOf(ctx, 'run_r')).toEqual({ carried_from: 'run_p', carried_commit: carried.from.commit })

      // Crashed the same way, and the earlier worktree is gone since: put back to its base, a fresh worktree a run works in.
      crashed()
      writeFileSync(join(carried.worktree, 'calc.py'), 'half written\n')
      rmSync(earlier.workspace, { recursive: true, force: true })
      expect(await carry(ctx, 'run_r', earlier)).toMatchObject({ outcome: 'refused', cause: 'gone' })
      expect(rowOf(ctx, 'run_r')).toEqual({ carried_from: null, carried_commit: null })
      expect(git(carried.worktree, 'status', '--porcelain')).toBe('')
      expect(readFileSync(join(carried.worktree, 'calc.py'), 'utf8')).toBe(ORIGINAL)
      expect((await run(ctx, 'agent:dev', 'k-r-2', 'run_r')).status).toBe('completed')
      expect(agent.runs.at(-1)!.workspace).toBe(carried.worktree)
    })

    it('never commits a worktree cut for work it never got: the retention and the operator\'s removal put it back to its base first, and a branch an earlier retention committed such a tree on is never added again (T127 item 2, INV-2, INV-4)', async () => {
      const repo = repository()
      const head = git(repo, 'rev-parse', 'HEAD')
      const seen: string[] = []
      const agent = developer({ act: (spec) => (seen.push(readFileSync(join(spec.workspace, 'calc.py'), 'utf8')), writes(spec)) })
      const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
      /** The new worktree as a crash between its `worktree add --no-checkout` and the reading of the tree leaves it: marked, its index empty, no file, every file of its base staged as deleted. */
      const cutOnly = async (runId: string, from: string): Promise<string> => {
        const { worktree } = await carry(ctx, runId, await wrote(ctx, agent, from)) as { worktree: string }
        ctx.store.db.prepare('UPDATE agent_worktrees SET carried_commit = NULL WHERE workflow_run_id = ?').run(runId)
        git(worktree, 'read-tree', '--empty')
        for (const name of readdirSync(worktree)) if (name !== '.git') rmSync(join(worktree, name), { recursive: true, force: true })
        expect(git(worktree, 'status', '--porcelain')).toBe('D  calc.py')
        return worktree
      }

      // Past the retention: put back to its base and removed; its branch is still at the base, holding no commit of the deletions.
      const swept = await cutOnly('run_r', 'run_p')
      expect((await ctx.agentWorkers.sweepWorktrees(LATER())).removed).toContain(swept)
      expect(existsSync(swept)).toBe(false)
      expect(git(repo, 'rev-parse', 'system/run/run_r')).toBe(head)
      expect(rowOf(ctx, 'run_r')).toEqual({ carried_from: null, carried_commit: null })
      // The run's agent, later, works in a fresh worktree added again from that branch: the base's files.
      expect((await run(ctx, 'agent:dev', 'k-r', 'run_r')).status).toBe('completed')
      expect(agent.runs.at(-1)!.workspace).toBe(swept)
      expect(seen.at(-1)).toBe(ORIGINAL)

      // The operator's removal with the commit flag: the same, said, and nothing committed.
      const removed = await cutOnly('run_s', 'run_q')
      expect(await ctx.agentWorkers.removeWorktrees({ runId: 'run_s', commitChanges: true })).toMatchObject({
        worktrees: [{ path: removed, outcome: 'removed', why: 'it was cut to start from the work of run run_q, which never got into it, so it holds no run\'s work: it is put back to its base, nothing of it is committed, and it is removed; its branch stays' }],
      })
      expect(git(repo, 'rev-parse', 'system/run/run_s')).toBe(head)

      // Files a reading cut short wrote, which the base does not hold: the worktree stays, marked, and nothing of it is committed.
      const partial = await cutOnly('run_v', 'run_w')
      writeFileSync(join(partial, 'half.py'), 'half written\n')
      expect((await ctx.agentWorkers.sweepWorktrees(LATER())).kept).toContain(partial)
      expect(git(repo, 'rev-parse', 'system/run/run_v')).toBe(head)
      expect(rowOf(ctx, 'run_v')).toEqual({ carried_from: 'run_w', carried_commit: null })
      expect(git(partial, 'status', '--porcelain', '--untracked-files=all')).toBe('?? half.py')
      expect((await run(ctx, 'agent:dev', 'k-v', 'run_v')).status).toBe('failed')

      // A branch an earlier retention committed such a tree on (every file deleted): no worktree is added from it again.
      const kept = await cutOnly('run_t', 'run_u')
      git(kept, '-c', 'user.name=system', '-c', 'user.email=system@localhost', 'commit', '-q', '-m', 'system: keep the uncommitted work of workflow run run_t\n\nCommitted by system before the run\'s worktree was removed.')
      git(repo, 'worktree', 'remove', kept)
      ctx.store.db.prepare("UPDATE agent_worktrees SET removed_at = ? WHERE workflow_run_id = 'run_t'").run(new Date().toISOString())
      const tip = git(repo, 'rev-parse', 'system/run/run_t')
      expect(git(repo, 'ls-tree', '--name-only', tip)).toBe('')
      const before = agent.runs.length
      expect(await run(ctx, 'agent:dev', 'k-t', 'run_t')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringMatching(new RegExp(`system/run/run_t ends in ${tip}, the retention's commit of the worktree cut to start from the work of run run_u, which never got into it: that commit holds no run's work`)) } })
      expect(agent.runs).toHaveLength(before)
      expect(existsSync(kept)).toBe(false)
      expect(git(repo, 'rev-parse', 'system/run/run_t')).toBe(tip)
      untouched(repo, head)
    })
  })
})
