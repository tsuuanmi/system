/**
 * Regenerating a repository's generated files for a landing (T166): a merge of an accepted run's
 * branch whose only conflicts are in files the repository declares generated
 * (`worktreeSetup[].generated`) is resolved by running the repository's own commands for them, in the
 * run's worktree, rather than refused. Each command is judged by the autonomy policy as a `command`
 * with its exact argv and runs only when the policy allows it unasked (as a run's checks, ./checks.ts);
 * it runs in the setup's confinement (the host read-only but the worktree and the setup's private
 * views, no network) within the setup's deadline, with pnpm's verify-deps-before-run off and offline
 * as a check is (./setup.ts `noInstallEnvironment`), so it never starts an install, and only in a
 * worktree its setup prepared under the definition loaded now, so its dependencies are there. Anything else is a refusal naming why (INV-2):
 * the git side (what changed, the repeat, the merge commit) is the worktree's owner's (./worktrees.ts).
 * @module @tsuuanmi/system-agent-workers/regenerate
 */
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { CHECKS } from './gate.ts'
import { confineIn, generatedPath, noInstallEnvironment, runBounded, type Setup } from './setup.ts'

/** How much of a failed command's output a refusal keeps, from the end (INV-9). */
const OUTPUT_TAIL = 1500

/** One run of a repository's generated files' commands: the policy's decisions they ran on, or why they did not all run and exit 0. */
export type RegenerationRun = { ok: true; autonomy: string[] } | { ok: false; reason: string }

/** What a landing may regenerate in one repository: which files are generated, and how to make them. */
export interface Regeneration {
  /** The commands' lines, as configured, for the record. */
  readonly lines: readonly string[]
  /** Whether the repository-relative `path` is one of the declared generated files. */
  generated(path: string): boolean
  /** Run every command once, in order, confined in the worktree at `worktree`; never throws. */
  run(worktree: string): Promise<RegenerationRun>
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * The regeneration of the repository at `repository` (a real path) for a worktree whose stored setup
 * hash is `setupHash`, or undefined when its setup declares no generated files. `runDir`: where the
 * setups' private views are made (`<worktreeRoot>/.setup`).
 */
export function regenerationOf(ctx: Context, setups: ReadonlyMap<string, Setup>, runDir: string, repository: string, setupHash: string | null): Regeneration | undefined {
  const setup = [...setups.values()].find((s) => real(s.repository) === repository)
  const generated = setup?.generated
  if (!setup || !generated) return undefined
  return {
    lines: generated.lines,
    generated: (path) => generatedPath(generated.paths, path),
    run: async (worktree) => {
      // The commands need what the setup installs: a worktree it did not prepare under the definition loaded now would not hold it.
      if (setupHash !== setup.hash) return { ok: false, reason: `the worktree ${worktree} was not set up under ${repository}'s setup as loaded now (${setup.hash}), so the generated files' commands do not run there` }
      const approvals = ctx.get('approvals')
      if (!approvals) return { ok: false, reason: 'no approval queue (ctx.approvals) is loaded, and no command runs without its autonomy decision' }
      const autonomy: string[] = []
      for (const [i, argv] of generated.commands.entries()) {
        const line = generated.lines[i]!
        const verdict = await approvals.check({ class: 'command', command: argv })
        autonomy.push(verdict.decision)
        const pending = verdict.failedChecks ?? []
        if ((verdict.mode === 'auto' || verdict.mode === 'notify') && pending.every((c) => CHECKS.includes(c))) continue
        return {
          ok: false,
          reason: verdict.mode === 'ask'
            ? `the autonomy policy asks the operator about the generated files' command ${i + 1} (${line}): it runs only as a command the policy allows unasked, such as a line on the studio policy's commands list`
            : verdict.mode === 'forbid' ? `the autonomy policy forbids the generated files' command ${i + 1} (${line})`
              : `the autonomy policy gave the generated files' command ${i + 1} (${line}) ${verdict.mode === 'auto' || verdict.mode === 'notify' ? `checks pending that no rule can require (${pending.join(', ')})` : `a mode this source does not know (${String(verdict.mode)})`}`,
        }
      }
      const path = real(worktree)
      if (!path) return { ok: false, reason: `the worktree ${worktree} cannot be read` }
      let confined
      try {
        confined = await confineIn(ctx, setup, path, runDir)
      } catch (error) {
        return { ok: false, reason: `the generated files' commands cannot be confined: ${(error as Error).message}` }
      }
      try {
        const deadline = AbortSignal.timeout(setup.timeoutSeconds * 1000)
        const env = noInstallEnvironment()
        for (const [i, argv] of generated.commands.entries()) {
          const line = generated.lines[i]!
          let ended
          try {
            ended = await runBounded(confined.command(argv), env, deadline)
          } catch (error) {
            return { ok: false, reason: `the generated files' command ${i + 1} (${line}) ${(error as Error).message.replace(/^its commands /, '')}` }
          }
          if (deadline.aborted) return { ok: false, reason: `the generated files' command ${i + 1} (${line}) did not finish within the setup's ${setup.timeoutSeconds} s; it was stopped${tail(ended.output)}` }
          if (ended.code !== 0) return { ok: false, reason: `the generated files' command ${i + 1} (${line}) ${ended.code === null ? `ended on signal ${ended.signal ?? 'unknown'}` : `exited with code ${ended.code}`}${tail(ended.output)}` }
        }
      } finally {
        confined.dispose()
      }
      return { ok: true, autonomy: [...new Set(autonomy)] }
    },
  }
}

/** `. Its output ended: …`, the last part of what a command printed, when it printed anything. */
function tail(output: string): string {
  const text = output.trim()
  return text ? `. Its output ended: ${text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text}` : ''
}
