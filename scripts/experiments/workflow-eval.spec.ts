import { describe, expect, it } from 'vitest'
import {
  boardTask, calibration, type CheckResult, type Exec, fileCheck, type GoldenSet, type GoldenTask, grade, gradeCommit, loadSet, loadVariants, measure, type Measurement, nextTrial, plan,
  type Plan, planDrift, renderReport, report, setProblems, spent, type TrialFiles, type Variants,
} from './workflow-eval.ts'

const AT = new Date('2026-10-26T09:00:00Z')
const set = (): GoldenSet => structuredClone(loadSet())
/** The shipped variants with a second ready one, as a later variant will be. */
const variants = (): Variants => {
  const v = structuredClone(loadVariants())
  v.variants.push({ id: 'candidate', state: 'ready', template: 'algorithm-development', description: 'a test variant', configuration: 'candidate.patch.yml' })
  return v
}
const cap = { tokens: 10_000_000, quotaPoints: 400, minutes: 6000 }
const reserve = { tokens: 1_000_000, quotaPoints: 40, minutes: 120 }
const planned = (over: Partial<Parameters<typeof plan>[2]> = {}): Plan => plan(set(), variants(), { evalId: 'eval-1', variants: ['current', 'candidate'], cases: ['T184', 'T187', 'T188'], repetitions: 2, seed: 'seed-1', cap, reserve, at: AT, ...over })

describe('the golden set', () => {
  it('holds at least three tasks, each pinned to a full base commit, with a grader that is about its change, and every variant named once', () => {
    const s = set()
    expect(setProblems(s, loadVariants())).toEqual([])
    expect(s.tasks.length).toBeGreaterThanOrEqual(3)
    for (const t of s.tasks) {
      expect(t.base).toMatch(/^[0-9a-f]{40}$/)
      expect(t.grader.some((c) => !('command' in c))).toBe(true)
      expect(t.acceptance.length).toBeGreaterThan(0)
    }
    expect(loadVariants().variants.find((v) => v.id === 'current')?.state).toBe('ready')
  })

  it('refuses a grader of commands only, a short base, a check id twice, a path outside the repository, and a pattern that is no regular expression', () => {
    const s = set()
    const t = s.tasks[0]!
    t.grader = [{ id: 'check', command: 'corepack pnpm check' }, { id: 'check', command: 'corepack  pnpm lint' }]
    s.tasks[1]!.base = 'b15f170d'
    s.tasks[2]!.grader = [{ id: 'a', changed: ['../outside'] }, { id: 'b', path: 'README.md', matches: '(' }]
    const problems = setProblems(s, loadVariants())
    expect(problems.join('\n')).toContain('commands only, which pass on an unchanged base')
    expect(problems.join('\n')).toContain('grader id check twice')
    expect(problems.join('\n')).toContain('is not words split on single spaces')
    expect(problems.join('\n')).toContain('base b15f170d is not a full commit id')
    expect(problems.join('\n')).toContain('../outside is not a path inside the repository')
    expect(problems.join('\n')).toContain('( is not a regular expression')
  })
})

describe('plan', () => {
  it('runs every task under every variant at each repetition, in variant blocks per round, the same order from the same seed', () => {
    const p = planned()
    expect(p.trials).toHaveLength(3 * 2 * 2)
    expect(new Set(p.trials.map((t) => t.trialId)).size).toBe(12)
    // Each round is two blocks of one variant each, so one configuration is in force per block.
    for (const round of [1, 2]) {
      const ts = p.trials.filter((t) => t.repetition === round)
      expect(ts.slice(0, 3).every((t) => t.variant === ts[0]!.variant)).toBe(true)
      expect(ts.slice(3).every((t) => t.variant === ts[3]!.variant && t.variant !== ts[0]!.variant)).toBe(true)
    }
    expect(planned().trials).toEqual(p.trials)
    const orders = ['seed-1', 'seed-2', 'seed-3', 'seed-4'].map((seed) => planned({ seed }).trials.map((t) => t.trialId).join())
    expect(new Set(orders).size).toBeGreaterThan(1)
    expect(p).toMatchObject({ project: 'eval-eval-1', attempts: 1, createdAt: '2026-10-26T09:00:00.000Z', setup: set().setup })
  })

  it('refuses one repetition, a planned variant, an unknown task, and a reserve larger than the cap', () => {
    expect(() => planned({ repetitions: 1 })).toThrow(/at least twice/)
    expect(() => planned({ variants: ['current', 'no-validate-step'] })).toThrow(/no-validate-step is planned, not ready/)
    expect(() => planned({ cases: ['T999'] })).toThrow(/T999 is not in the golden set/)
    expect(() => planned({ reserve: { ...reserve, minutes: 7000 } })).toThrow(/reserves more minutes than the cap/)
  })

  it('no longer binds a golden set or a variant that changed since', () => {
    const p = planned()
    expect(planDrift(p, set(), variants())).toEqual([])
    const s = set()
    s.tasks[0]!.goal += ' (edited)'
    const v = variants()
    v.variants.find((x) => x.id === 'candidate')!.configuration = 'other.patch.yml'
    expect(planDrift(p, s, v)).toEqual([expect.stringContaining('the golden set changed'), 'variant candidate changed since the plan'])
  })

  it('names the board task of a trial in the eval\'s own project, one attempt, retry-safe', () => {
    const p = planned()
    const trial = p.trials[0]!
    const task = set().tasks.find((t) => t.caseId === trial.caseId)!
    expect(boardTask(p, task, trial)).toMatchObject({ projectId: 'eval-eval-1', goal: task.goal, acceptance: task.acceptance, actionClass: 'workspace-write', template: 'algorithm-development', maxAttempts: 1, clientRequestId: `eval-1:${trial.trialId}` })
  })
})

const passing = (id: string): CheckResult => ({ id, what: id, passed: true, exit: 0, seconds: 1, tail: '' })
const failing = (id: string): CheckResult => ({ id, what: id, passed: false, exit: 1, seconds: 1, tail: 'it failed' })
const at = (minutes: number): string => new Date(Date.parse('2026-10-26T10:00:00Z') + minutes * 60_000).toISOString()

/** A trial of T187 under `current`: one run of 45 minutes with one remediation cycle, two approvals of its own and one of another run, graded. */
function trialFiles(p: Plan, over: { trialId?: string; passed?: boolean; cycles?: number; usage?: boolean; draws?: boolean; base?: string; runs?: string[]; failed?: boolean; grade?: boolean } = {}): TrialFiles {
  const trial = p.trials.find((t) => t.trialId === (over.trialId ?? p.trials.find((x) => x.caseId === 'T187' && x.variant === 'current' && x.repetition === 1)!.trialId))!
  const task = set().tasks.find((t) => t.caseId === trial.caseId)!
  const runs = over.runs ?? ['run_a']
  const cycles = over.cycles ?? 1
  return {
    note: { ...trial, base: over.base ?? task.base, preparedAt: at(-5), runs },
    runs: runs.map((runId, i) => ({
      explain: {
        runId,
        nodes: [
          { nodeId: 'develop:1', state: 'COMPLETED' }, { nodeId: 'review:1', state: 'COMPLETED' },
          ...Array.from({ length: i === 0 ? cycles : 0 }, (_, n) => [{ nodeId: `review:1:fix:${n + 1}`, state: 'COMPLETED' }, { nodeId: `review:1:review:${n + 2}`, state: 'COMPLETED' }]).flat(),
          { nodeId: 'validate:1', state: 'COMPLETED' },
        ],
      },
      events: [
        { seq: 1, at: at(i * 60), type: 'workflow.run.started', runId },
        { seq: 2, at: at(i * 60 + 45), type: over.failed && i === 0 ? 'workflow.run.failed' : 'workflow.run.completed', runId, ...(over.failed && i === 0 ? { data: { kind: 'acceptance_rejected' } } : {}) },
      ],
      ...(over.usage === false ? {} : { usage: { totals: [{ pool: 'claude-plan/a', records: 3, usage: { inputTokens: 100_000, outputTokens: 20_000 } }, { pool: 'codex/b', records: 1, usage: { inputTokens: 30_000 } }] } }),
      ...(over.draws === false ? {} : {
        draws: [
          { workflowRunId: runId, windows: [{ window: 'five-hour', draw: 9, state: 'clean' }, { window: 'weekly', draw: 2, state: 'confounded' }] },
          { workflowRunId: runId, windows: [{ window: 'five-hour', state: 'reset-crossing' }] },
        ],
      }),
    })),
    approvals: [
      { requestId: 'apr-1', state: 'approved', action: { class: 'command' }, requester: { runId: runs[0]! } },
      { requestId: 'apr-2', state: 'approved', action: { class: 'remediation' }, requester: { runId: runs[0]! } },
      { requestId: 'apr-3', state: 'open', action: { class: 'command' }, requester: { runId: 'run_live' } },
    ],
    ...(over.grade === false ? {} : {
      grade: {
        trialId: trial.trialId, runId: runs.at(-1)!, result: { commit: 'c'.repeat(40), tree: 't'.repeat(40) }, fromBase: true, setup: [passing('setup-1')],
        checks: task.grader.map((c) => (over.passed === false && c.id === 'changes' ? failing(c.id) : passing(c.id))), hidden: null,
      },
    }),
  }
}

describe('measure', () => {
  it('counts a passing trial: review cycles, its own runs\' approvals by class, tokens, clean and confounded quota points, and wall-clock', () => {
    const p = planned()
    const m = measure(p, set(), trialFiles(p))
    expect(m).toMatchObject({ caseId: 'T187', variant: 'current', passed: true, passedFirstTime: false, attempts: 1, reviewCycles: 1, touches: 2, touchesByClass: { command: 1, remediation: 1 }, tokens: 150_000, quotaPoints: 11, minutes: 45, failed: [], integrity: [] })
    expect(measure(p, set(), trialFiles(p, { cycles: 0 })).passedFirstTime).toBe(true)
  })

  it('fails a trial on any grader check, and not first time when its first attempt failed or more than one ran', () => {
    const p = planned()
    expect(measure(p, set(), trialFiles(p, { passed: false })).passed).toBe(false)
    expect(measure(p, set(), trialFiles(p, { cycles: 0, failed: true }))).toMatchObject({ passed: true, passedFirstTime: false, failed: ['run_a: acceptance_rejected'] })
    const two = planned({ attempts: 2 })
    expect(measure(two, set(), trialFiles(two, { cycles: 0, runs: ['run_a', 'run_b'] }))).toMatchObject({ passed: true, passedFirstTime: false, attempts: 2, minutes: 90, integrity: [] })
  })

  it('leaves an unexported amount unknown, never 0, and lists why a trial cannot be counted', () => {
    const p = planned()
    const m = measure(p, set(), trialFiles(p, { usage: false, draws: false, base: 'a'.repeat(40), grade: false }))
    expect(m).toMatchObject({ tokens: null, quotaPoints: null, passed: null, passedFirstTime: null })
    expect(m.integrity).toEqual([
      `the eval clone was pinned at ${'a'.repeat(40)}, the task's base is ${set().tasks.find((t) => t.caseId === 'T187')!.base}`,
      'a run\'s usage is not exported (usage.json)',
      'the trial is not graded (grade.json)',
    ])
    const files = trialFiles(p)
    files.grade!.checks = files.grade!.checks.filter((c) => c.id !== 'gate-spec')
    files.grade!.fromBase = false
    expect(measure(p, set(), files)).toMatchObject({ passed: null, integrity: [expect.stringContaining('does not descend from the base'), 'grader check(s) not run: gate-spec'] })
  })
})

const m = (p: Plan, trialId: string, over: Partial<Measurement> = {}): Measurement => {
  const t = p.trials.find((x) => x.trialId === trialId)!
  return { trialId, caseId: t.caseId, variant: t.variant, repetition: t.repetition, runs: ['run'], passed: true, passedFirstTime: true, attempts: 1, reviewCycles: 0, touches: 1, touchesByClass: { command: 1 }, tokens: 100, quotaPoints: 5, minutes: 30, failed: [], integrity: [], ...over }
}

describe('the budget cap', () => {
  it('runs one trial at a time, in the plan\'s order, and none once what was drawn plus the reserve passes the cap', () => {
    const p = planned({ cap: { tokens: 3_000_000, quotaPoints: 400, minutes: 6000 } })
    const [t1, t2, t3] = p.trials
    expect(nextTrial(p, [], [])).toEqual({ trial: t1 })
    expect(nextTrial(p, [t1!.trialId], [])).toEqual({ refused: `trial ${t1!.trialId} is prepared and not graded: grade it before the next one` })
    expect(nextTrial(p, [t1!.trialId], [m(p, t1!.trialId, { tokens: 1_500_000 })])).toEqual({ trial: t2 })
    // An unknown amount counts as the whole reserve: 1.5 M + 1 M (unknown) + 1 M reserved > 3 M.
    const refused = nextTrial(p, [t1!.trialId, t2!.trialId], [m(p, t1!.trialId, { tokens: 1_500_000 }), m(p, t2!.trialId, { tokens: null })])
    expect(refused).toEqual({ refused: `the cap is reached: tokens 2500000 drawn + 1000000 reserved > 3000000; 10 trial(s) not run` })
    expect(spent(p, [m(p, t1!.trialId, { minutes: null, quotaPoints: 2.5 })])).toEqual({ tokens: 100, quotaPoints: 2.5, minutes: 120 })
    expect(t3).toBeDefined()
    expect(nextTrial(p, p.trials.map((t) => t.trialId), p.trials.map((t) => m(p, t.trialId, { tokens: 1 })))).toEqual({ refused: 'every trial of the plan ran' })
  })
})

describe('report', () => {
  /** T184 passes under both; T187 passes under current only; T188 fails under current and passes under candidate; one candidate T187 trial is not counted. */
  function measured(p: Plan): Measurement[] {
    return p.trials.map((t) => {
      if (t.caseId === 'T187' && t.variant === 'candidate') return m(p, t.trialId, { passed: false, passedFirstTime: false, reviewCycles: 2, ...(t.repetition === 2 ? { integrity: ['the trial is not graded (grade.json)'] } : {}) })
      if (t.caseId === 'T188' && t.variant === 'current') return m(p, t.trialId, { passed: false, passedFirstTime: false, tokens: null })
      if (t.caseId === 'T184' && t.variant === 'current' && t.repetition === 2) return m(p, t.trialId, { passedFirstTime: false, reviewCycles: 1, touches: 3 })
      return m(p, t.trialId)
    })
  }

  it('reports per task and variant, per variant in total, and each task that flipped from the first variant', () => {
    const p = planned()
    const r = report(p, measured(p))
    const row = (caseId: string, variant: string) => r.rows.find((x) => x.caseId === caseId && x.variant === variant)!
    expect(row('T184', 'current')).toMatchObject({ trials: 2, passed: 2, passedFirstTime: 1, outcome: 'pass', reviewCycles: 1, touches: 4, tokens: { sum: 200, unknown: 0 }, minutes: { sum: 60, unknown: 0 } })
    expect(row('T187', 'candidate')).toMatchObject({ trials: 1, passed: 0, outcome: 'fail', reviewCycles: 2 })
    expect(row('T188', 'current')).toMatchObject({ outcome: 'fail', tokens: { sum: 0, unknown: 2 } })
    expect(r.totals).toEqual([
      expect.objectContaining({ variant: 'current', trials: 6, passed: 4, passedFirstTime: 3, mixed: 0, reviewCycles: 1, touches: 8, tokens: { sum: 400, unknown: 2 }, quotaPoints: { sum: 30, unknown: 0 } }),
      expect.objectContaining({ variant: 'candidate', trials: 5, passed: 4, passedFirstTime: 4, mixed: 0, reviewCycles: 2 }),
    ])
    expect(r.flips).toEqual([
      { caseId: 'T187', from: { variant: 'current', outcome: 'pass', passed: 2, of: 2 }, to: { variant: 'candidate', outcome: 'fail', passed: 0, of: 1 }, direction: 'lost' },
      { caseId: 'T188', from: { variant: 'current', outcome: 'fail', passed: 0, of: 2 }, to: { variant: 'candidate', outcome: 'pass', passed: 2, of: 2 }, direction: 'gained' },
    ])
    expect(r.integrity).toEqual([{ trial: p.trials.find((t) => t.caseId === 'T187' && t.variant === 'candidate' && t.repetition === 2)!.trialId, problems: ['the trial is not graded (grade.json)'] }])
    expect(r.missing).toEqual([])
  })

  it('calls a task that passes only sometimes mixed, and a move to or from mixed a change, never a gain', () => {
    const p = planned()
    const ms = measured(p).map((x) => (x.caseId === 'T184' && x.variant === 'candidate' && x.repetition === 1 ? { ...x, passed: false, passedFirstTime: false } : x))
    const r = report(p, ms)
    expect(r.rows.find((x) => x.caseId === 'T184' && x.variant === 'candidate')!.outcome).toBe('mixed')
    expect(r.totals.find((t) => t.variant === 'candidate')!.mixed).toBe(1)
    expect(r.flips[0]).toMatchObject({ caseId: 'T184', direction: 'changed', to: { outcome: 'mixed', passed: 1, of: 2 } })
  })

  it('lists the trials not run, and renders every table', () => {
    const p = planned()
    const notRun = (x: { caseId: string; variant: string }): boolean => x.caseId === 'T184' && x.variant === 'candidate'
    const r = report(p, measured(p).filter((x) => !notRun(x)))
    expect(r.missing).toEqual(p.trials.filter(notRun).map((t) => t.trialId))
    expect(r.rows.find((x) => x.caseId === 'T184' && x.variant === 'candidate')!.outcome).toBe('none')
    const text = renderReport(r)
    expect(text).toContain('| T188 | current | 0/2 | 0/2 | fail | 0 | 2 | 0 (+2 unknown) | 10 | 60 |')
    expect(text).toContain('| current | 4/6 | 3/6 | 0 | 1 | 8 | 400 (+2 unknown) | 30 | 180 |')
    expect(text).toContain('- T187: lost, current pass (2/2) → candidate fail (0/1)')
    expect(text).toContain('## Flips')
    expect(text).toContain('## Not run')
    expect(text).toContain('## Not counted')
  })
})

describe('grade', () => {
  const t187 = (): GoldenTask => structuredClone(set().tasks.find((t) => t.caseId === 'T187')!)

  it('checks the changed paths, a pattern a file matches, and one it lacks', () => {
    const files: Record<string, string> = { 'docs/a.md': '# Title\n## Set dispatch to auto\n' }
    const readFile = (path: string): string | undefined => files[path]
    expect(fileCheck({ id: 'c', changed: ['src/gate.ts', 'tests/', '.changeset/'] }, ['src/gate.ts', 'tests/gate.spec.ts', '.changeset/x.md'], readFile).passed).toBe(true)
    expect(fileCheck({ id: 'c', changed: ['src/gate.ts', 'tests/'] }, ['src/gate.ts', 'testsuite.md'], readFile)).toMatchObject({ passed: false, tail: 'not changed: tests/' })
    expect(fileCheck({ id: 'm', path: 'docs/a.md', matches: '^## .*auto' }, [], readFile).passed).toBe(true)
    expect(fileCheck({ id: 'm', path: 'docs/b.md', matches: 'x' }, [], readFile)).toMatchObject({ passed: false, tail: 'docs/b.md is absent' })
    expect(fileCheck({ id: 'l', path: 'docs/a.md', lacks: 'seven-day' }, [], readFile).passed).toBe(true)
    expect(fileCheck({ id: 'l', path: 'docs/a.md', lacks: 'Title' }, [], readFile).passed).toBe(false)
  })

  it('snapshots the run\'s worktree through a private index, grades that commit in a worktree of its own, and removes it', () => {
    const calls: { argv: string[]; cwd: string; env?: Record<string, string> }[] = []
    const exec: Exec = (argv, cwd, env) => {
      calls.push({ argv, cwd, ...(env ? { env } : {}) })
      const out = argv[1] === 'write-tree' ? 'tree1\n' : argv[1] === 'commit-tree' ? 'commit1\n' : argv[1] === 'diff' ? 'packages/plugins/agent-workers/src/gate.ts\n' : ''
      return { exit: argv.join(' ') === 'corepack pnpm check' ? 1 : 0, seconds: 2, output: out }
    }
    const p = planned()
    const task = t187()
    const note = { trialId: 'r1-current-T187', caseId: 'T187', variant: 'current', repetition: 1, base: task.base, preparedAt: at(0), runs: ['run_a'] }
    const g = grade({ p, task, note, repo: '/eval/clone', worktree: '/wt/run_a', dir: '/eval/e1/trials/r1-current-T187', exec, readFile: () => undefined })
    expect(g).toMatchObject({ trialId: 'r1-current-T187', runId: 'run_a', result: { commit: 'commit1', tree: 'tree1' }, fromBase: true })
    expect(g.checks.map((c) => [c.id, c.passed])).toEqual([['changes', false], ['check', false], ['gate-spec', true], ['tests', true]])
    expect(g.checks.find((c) => c.id === 'changes')!.tail).toContain('not changed: packages/plugins/agent-workers/tests/gate.spec.ts')
    expect(g.checks.find((c) => c.id === 'tests')!.what).toBe(`node --import tsx scripts/test-groups.ts affected --base ${task.base}`)
    // The snapshot never touches the run's own index or branch.
    for (const c of calls.filter((x) => x.cwd === '/wt/run_a')) expect(c.env?.GIT_INDEX_FILE).toBe('/eval/e1/trials/r1-current-T187/grade.index')
    expect(calls.filter((x) => x.cwd === '/wt/run_a').map((x) => x.argv[1])).toEqual(['read-tree', 'add', 'write-tree', 'commit-tree'])
    expect(calls.map((x) => x.argv.join(' '))).toContain('git worktree add --detach /eval/e1/trials/r1-current-T187/grade commit1')
    expect(calls.at(-1)!.argv.join(' ')).toBe('git worktree remove --force /eval/e1/trials/r1-current-T187/grade')
    expect(calls.filter((x) => x.cwd === '/eval/e1/trials/r1-current-T187/grade').map((x) => x.argv.join(' '))).toEqual([
      'corepack pnpm install --frozen-lockfile --offline', 'corepack pnpm check', 'corepack pnpm exec vitest run packages/plugins/agent-workers/tests/gate.spec.ts', `node --import tsx scripts/test-groups.ts affected --base ${task.base}`,
    ])
  })

  it('grades nothing past a failed setup, and runs the hidden checks over the landed commit\'s paths', () => {
    const calls: string[] = []
    const failSetup: Exec = (argv) => {
      calls.push(argv.join(' '))
      return { exit: argv[0] === 'corepack' && argv[2] === 'install' ? 1 : 0, seconds: 1, output: '' }
    }
    const task = t187()
    const g = gradeCommit({ setup: ['corepack pnpm install --frozen-lockfile --offline'], task, repo: '/r', commit: 'c1', at: '/g', exec: failSetup, readFile: () => undefined })
    expect(g).toMatchObject({ checks: [], hidden: null, setup: [{ passed: false }] })
    expect(calls.at(-1)).toBe('git worktree remove --force /g')

    task.hidden = { commit: 'd'.repeat(40), paths: ['packages/plugins/agent-workers/tests/gate.spec.ts'], commands: [{ id: 'landed-gate-spec', command: 'corepack pnpm exec vitest run packages/plugins/agent-workers/tests/gate.spec.ts' }] }
    const ran: string[] = []
    const ok: Exec = (argv) => {
      ran.push(argv.join(' '))
      return { exit: 0, seconds: 1, output: argv[1] === 'diff' ? 'packages/plugins/agent-workers/src/gate.ts\n' : '' }
    }
    const h = gradeCommit({ setup: [], task, repo: '/r', commit: 'c1', at: '/g', keep: true, exec: ok, readFile: () => undefined })
    expect(h.hidden).toEqual([expect.objectContaining({ id: 'landed-gate-spec', passed: true })])
    expect(ran).toContain(`git checkout ${'d'.repeat(40)} -- packages/plugins/agent-workers/tests/gate.spec.ts`)
    expect(ran).not.toContain('git worktree remove --force /g')
  })

  it('is calibrated only when it fails on the base and passes on a known-good result', () => {
    const g = (checks: CheckResult[]) => ({ setup: [passing('setup-1')], checks, hidden: null })
    expect(calibration(g([failing('changes'), passing('check')]), g([passing('changes'), passing('check')]))).toEqual([])
    expect(calibration(g([passing('changes'), passing('check')]), g([passing('changes'), passing('check')]))).toEqual(['every check passes on the base: the grader cannot tell a replay that changed nothing'])
    expect(calibration(g([failing('changes')]), g([passing('changes'), failing('check')]))).toEqual(['on the known-good result check fail(s): the grader would fail the accepted change'])
    expect(calibration({ setup: [failing('setup-1')], checks: [], hidden: null }, g([]))).toEqual(['the setup failed: nothing was graded'])
  })
})
