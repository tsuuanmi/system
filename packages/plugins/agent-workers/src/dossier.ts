/**
 * The task dossier's tools an agent Worker's run holds (ADR-0070, docs/design/task-dossier.md):
 * `dossier_read` and `dossier_append`, host tools (agent-runtime-core `HostTool`) the runtime offers
 * as `mcp__system__dossier_read` and `mcp__system__dossier_append`, answered in System's own process.
 * Each is bound, when the run is built, to the step the run serves: its workflow run, its step, and
 * its execution, from this source's own record of the run (`agent_runs`), never from the agent's
 * input, which names only the entry. So the engine records the entry as the step's Worker's, and
 * takes it only while that execution is the one its step runs; no caller of System's own surface can
 * write as a step's Worker. Given only to a run that serves a step of a board task's workflow run,
 * never to a review member's (its gate allows no call), and only where the runtime offers host tools.
 * @module @tsuuanmi/system-agent-workers/dossier
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostTool, ToolResult } from '@tsuuanmi/system-agent-runtime-core'

/** The step a run's dossier tools are bound to: the engine's `DossierCaller`. */
export interface DossierCaller {
  runId: string
  nodeId: string
  /** This source's execution of the step: the agent run's id. */
  execution: string
}

/** The kinds a Worker appends: an author's `evidence` is the output of the checks it ran (T267), the Worker's report, not the System's. */
const WORKER_KINDS = ['plan', 'progress', 'review', 'response', 'evidence'] as const

/** What `dossier_append` takes, as the engine's `appendToDossier` does. */
export interface DossierEntryInput {
  kind: (typeof WORKER_KINDS)[number]
  text: string
  commits?: string[]
  refs?: string[]
  finding?: string
  inReplyTo?: string
}

/**
 * The workflow engine's dossier, as a Worker's run reaches it (`Workflow.readDossier` and
 * `Workflow.appendToDossier`), found by its service name: this source does not depend on the engine.
 */
export interface StepDossiers {
  readDossier(caller: DossierCaller, page: { from?: number | undefined; limit?: number | undefined }): { total: number; entries: unknown[]; next?: number | undefined; taskId: string }
  appendToDossier(caller: DossierCaller, entry: DossierEntryInput): { id: string; seq: number }
  /** Keep a command the step's Worker ran, for the engine's evidence gate (T284); an engine without it records none. */
  recordCommand?(caller: DossierCaller, report: CommandReport): void
}

/** A command a step's Worker ran, as its runtime reported it (T284): what the System records itself. */
export interface CommandReport {
  command: string
  exitCode?: number | undefined
  isError: boolean
  /** The runtime reported no end of it (a background launch, an interrupted command): it carries no exit code. */
  unfinished?: true | undefined
  tail: string
}

/**
 * The recorder of the commands a run ran (T284): each `Bash` result its runtime reports, for the step
 * its dossier tools are bound to, kept by the engine for its evidence gate. A result its runtime
 * reports unfinished, or a background launch (`run_in_background`, whatever its runtime said), is
 * recorded as unfinished, with no exit code: its launch is never taken for its end. Never fails the
 * run: a record the engine refuses (the step ended) is dropped, with a warning.
 */
export function commandRecorder(ctx: Context, dossiers: StepDossiers, caller: DossierCaller): (result: ToolResult) => void {
  const bound: DossierCaller = { runId: caller.runId, nodeId: caller.nodeId, execution: caller.execution }
  return (result) => {
    const input = result.input as { command?: unknown; run_in_background?: unknown } | null
    const command = input?.command
    if (result.tool !== 'Bash' || typeof command !== 'string' || !command.trim() || !dossiers.recordCommand) return
    const unfinished = result.unfinished === true || input?.run_in_background === true
    try {
      dossiers.recordCommand(bound, {
        command: command.slice(0, 500), isError: result.isError,
        ...(unfinished ? { unfinished: true as const } : result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), tail: result.tail,
      })
    } catch (error) {
      ctx.logger.warn(`agent Workers: a command of ${bound.nodeId} in ${bound.runId} was not recorded: ${(error as Error)?.message?.slice(0, 200) ?? String(error)}`)
    }
  }
}

/** The engine's dossier, when an engine that keeps one is loaded. */
export function dossiersOf(ctx: Context): StepDossiers | undefined {
  const service = ctx.get('workflow' as never) as Partial<StepDossiers> | undefined
  return typeof service?.readDossier === 'function' && typeof service.appendToDossier === 'function' ? service as StepDossiers : undefined
}

/** The bounds the engine holds an entry to (workflow `DOSSIER_LIMITS`), so a call over them is refused before it reaches the engine. */
const LIMITS = { text: 4000, refs: 16, commits: 16, finding: 200, pageMax: 50 } as const

/**
 * The run's two dossier tools, bound to `caller`. A refusal by the engine (the step no longer
 * running, a kind its role does not write, a link to nothing stored) is the call's error result,
 * with why; nothing is appended then.
 */
export function dossierTools(dossiers: StepDossiers, caller: DossierCaller): HostTool[] {
  const bound: DossierCaller = { runId: caller.runId, nodeId: caller.nodeId, execution: caller.execution }
  const refused = (error: unknown): { text: string; isError: boolean } => ({ text: `refused: ${(error as Error)?.message?.slice(0, 1000) ?? String(error)}`, isError: true })
  return [
    {
      name: 'dossier_read', readOnly: true,
      description: `Read your board task's dossier: its append-only entries whole (plan, progress, review, response, and evidence: the System's, and the author's own pasted checks), oldest first from \`from\` (default 1), at most \`limit\` (default 20, at most ${LIMITS.pageMax}); \`next\` is where the next page starts. Your brief holds its latest entries; read the rest here.`,
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { from: { type: 'integer', minimum: 1, description: 'The first entry to read (default 1)' }, limit: { type: 'integer', minimum: 1, maximum: LIMITS.pageMax, description: 'Entries to read (default 20)' } },
      },
      call: async (input) => {
        try {
          const page = dossiers.readDossier(bound, { from: input.from as number | undefined, limit: input.limit as number | undefined })
          return { text: JSON.stringify(page), isError: false }
        } catch (error) {
          return refused(error)
        }
      },
    },
    {
      name: 'dossier_append', readOnly: false,
      description: 'Append one entry to your board task\'s dossier, as the Worker of the step you run; it never changes once appended. The author writes `plan` at the start (approach, files, risks), `progress` after each step (what was done, its commits, what remains, small decisions and why), and `response` per finding of a review (fixed in which commit, or not and why; `finding` names it, `inReplyTo` the review entry). Before it ends, the author runs the required checks and writes `evidence`: each command, its exit code, and the real output lines that hold the result, verbatim. A reviewer writes `review`: its findings on the subject it reviewed. The next Worker, and the reviewer, read the dossier, never your conversation.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: [...WORKER_KINDS], description: 'plan, progress, response, or evidence (a writing step); review (a review)' },
          text: { type: 'string', minLength: 1, maxLength: LIMITS.text, description: 'The entry, in plain words' },
          commits: { type: 'array', maxItems: LIMITS.commits, items: { type: 'string', maxLength: 64 }, description: 'The commits it names (hex ids)' },
          refs: { type: 'array', maxItems: LIMITS.refs, items: { type: 'string', maxLength: 80 }, description: 'Stored artifacts it links (sha256:… ids)' },
          finding: { type: 'string', minLength: 1, maxLength: LIMITS.finding, description: 'A response: the finding it answers' },
          inReplyTo: { type: 'string', maxLength: 80, description: 'A response: the review entry it answers (its id)' },
        },
      },
      call: async (input) => {
        try {
          const entry = {
            kind: input.kind as DossierEntryInput['kind'], text: input.text as string,
            ...(input.commits ? { commits: input.commits as string[] } : {}), ...(input.refs ? { refs: input.refs as string[] } : {}),
            ...(input.finding !== undefined ? { finding: input.finding as string } : {}), ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo as string } : {}),
          }
          const { id, seq } = dossiers.appendToDossier(bound, entry)
          return { text: `Appended entry #${seq} (${id}) to your board task's dossier, as the Worker of step ${bound.nodeId}; it never changes.`, isError: false }
        } catch (error) {
          return refused(error)
        }
      },
    },
  ]
}
