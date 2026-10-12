/**
 * The scientific-research profile (REQ-WF-9): the second domain on the same engine, and the
 * architecture test. It ships with no engine change: its procedure is contributed through the
 * `profiles` seam (`ctx.workflow.template`), its structured steps through the engine's
 * `resultSchema` (REQ-ART-5), its other checks through `ctx.workers.contract`, and its typed
 * artifacts through `ctx.artifacts`, from the engine's own event log.
 *
 * `study` frames a question as testable hypotheses, reviews the literature with citations,
 * extracts an evidence table, has it critiqued independently, and concludes per hypothesis,
 * citing the evidence. `study-deep` reviews with Deep research instead.
 * @module @tsuuanmi/system-profile-scientific-research
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import { type ContentId, extractJson, SchemaRegistry } from '@tsuuanmi/system-libs'
import type { NodeTemplate } from '@tsuuanmi/system-workflow'
import type {} from '@tsuuanmi/system-workers'

export const name = 'profile-scientific-research'
export const inject = ['workflow', 'workers', 'artifacts', 'eventLog']

const FRAME = [
  'Frame the research question below as 2 to 4 testable hypotheses, for a study that will review the published evidence.',
  'Reply with only a JSON object in a ```json block, shaped like:',
  '{"schema": "hypothesis-set@1.0", "question": "...", "hypotheses": [{"id": "H1", "statement": "...", "supportIf": "what evidence would support it", "refuteIf": "what evidence would refute it"}]}',
  '',
  'Question: {{input}}',
].join('\n')

const LITERATURE = [
  'Review the published evidence on the question and hypotheses below. Search the web for primary studies, systematic reviews, and meta-analyses.',
  'For every claim, give its source as a full URL inline. Note study design, size, and limitations. Report evidence against the hypotheses as carefully as evidence for them.',
  '',
  '{{node:frame:1}}',
].join('\n')

const EVIDENCE = [
  'Extract an evidence table from the literature review below, for the hypotheses below. Use only claims the review states, each with its source URL from the review.',
  'Reply with only a JSON object in a ```json block, shaped like:',
  '{"schema": "evidence-table@1.0", "evidence": [{"id": "E1", "claim": "...", "source": "https://...", "bears": [{"hypothesis": "H1", "direction": "supports" | "refutes" | "neutral"}], "strength": "strong" | "moderate" | "weak"}]}',
  '',
  '<hypotheses>',
  '{{node:frame:1}}',
  '</hypotheses>',
  '',
  '<review>',
  '{{node:literature:1}}',
  '</review>',
].join('\n')

const CRITIQUE = [
  'You are an independent critic. You see only the hypotheses and the evidence table, not how they were produced.',
  'Point out weak or misread evidence, strength ratings that are too generous, missing counter-evidence, and conclusions the evidence would not support. Refer to evidence by id (E1, E2, ...).',
  '',
  '<hypotheses>',
  '{{node:frame:1}}',
  '</hypotheses>',
  '',
  '<evidence>',
  '{{node:evidence:1}}',
  '</evidence>',
].join('\n')

const CONCLUDE = [
  'Conclude the study: for each hypothesis (H1, H2, ...), state whether the evidence supports it, refutes it, or is insufficient, with a confidence (high, moderate, low).',
  'Cite the evidence each conclusion rests on as [E1], [E2], and so on, and take the critique into account. Say what evidence would change the conclusion.',
  '',
  'Question: {{input}}',
  '',
  '<hypotheses>',
  '{{node:frame:1}}',
  '</hypotheses>',
  '',
  '<evidence>',
  '{{node:evidence:1}}',
  '</evidence>',
  '',
  '<critique>',
  '{{node:critique:1}}',
  '</critique>',
].join('\n')

function study(deep: boolean): NodeTemplate[] {
  return [
    { nodeId: 'frame:1', objective: 'Frame the question as testable hypotheses', prompt: FRAME, capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', resultSchema: 'hypothesis-set@1.0' },
    {
      nodeId: 'literature:1', objective: 'Review the published evidence, with citations', dependsOn: ['frame:1'], prompt: LITERATURE,
      ...(deep
        ? { capabilities: ['reason', 'deep-research'], tier: 'frontier' as const, conversation: 'persistent' as const }
        : { capabilities: ['reason', 'web-search'], tier: 'standard' as const, conversation: 'temporary' as const }),
      acceptance: 'acceptance.cited',
    },
    { nodeId: 'evidence:1', objective: 'Extract the evidence table', dependsOn: ['frame:1', 'literature:1'], prompt: EVIDENCE, capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer', resultSchema: 'evidence-table@1.0' },
    { nodeId: 'critique:1', objective: 'Critique the evidence independently', dependsOn: ['frame:1', 'evidence:1'], prompt: CRITIQUE, capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' },
    {
      nodeId: 'conclusion:1', objective: 'Conclude per hypothesis, citing the evidence', dependsOn: ['frame:1', 'evidence:1', 'critique:1'], prompt: CONCLUDE,
      capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.cited-conclusions',
    },
  ]
}

export const STUDY = study(false)
export const STUDY_DEEP = study(true)

/** The steps whose results are typed artifacts: their JSON body, schema, and artifact kind. */
const TYPED: Record<string, { schema: string; kind: 'criteria' | 'evidence' }> = {
  'frame:1': { schema: 'hypothesis-set@1.0', kind: 'criteria' },
  'evidence:1': { schema: 'evidence-table@1.0', kind: 'evidence' },
}

const schemas = new SchemaRegistry()

/** The JSON object an answer carries (in a ```json block, or bare), validated against `schema`. */
export function typedBody(text: string, schema: string): { ok: true; body: Record<string, unknown> } | { ok: false; reason: string } {
  const value = extractJson(text)
  if (!value) return { ok: false, reason: `the answer has no ${schema} JSON object` }
  const body = { ...value, schema }
  try {
    schemas.assert(schema, body)
  } catch (error) {
    return { ok: false, reason: (error as Error).message.slice(0, 500) }
  }
  return { ok: true, body }
}

const textOf = (body: unknown): string => String((body as { text?: unknown } | undefined)?.text ?? '')

export function apply(ctx: Context): void {
  ctx.workers.contract('acceptance.cited-conclusions', ({ body }) => {
    const text = textOf(body)
    const hypotheses = new Set(text.match(/\bH[1-9][0-9]?\b/g) ?? [])
    const cited = new Set(text.match(/\[E[1-9][0-9]{0,2}\]/g) ?? [])
    if (!hypotheses.size) return { accepted: false, reasons: ['the conclusion names no hypothesis (H1, H2, ...)'] }
    if (!cited.size) return { accepted: false, reasons: ['the conclusion cites no evidence ([E1], [E2], ...)'] }
    return { accepted: true, reasons: [`concludes on ${[...hypotheses].join(', ')}, citing ${[...cited].join(', ')}`] }
  })
  ctx.effect(() => ctx.workflow.template('study', STUDY))
  ctx.effect(() => ctx.workflow.template('study-deep', STUDY_DEEP))

  // A typed step's accepted result becomes a typed artifact derived from it. When the step's
  // result changes (the operator superseded it or an input of it, and it ran again), the new typed
  // artifact supersedes the last one.
  ctx.on('system/event', (event) => {
    const { runId, nodeId } = event
    const typed = nodeId ? TYPED[nodeId] : undefined
    if ((event.type !== 'workflow.node.completed' && event.type !== 'workflow.node.superseded') || !typed || !runId || !nodeId) return
    const run = ctx.workflow.get(runId)
    if (!run || (run.template !== 'study' && run.template !== 'study-deep')) return
    const result = ctx.workflow.records(runId).find((r) => r.nodeId === nodeId)?.outputReceipt?.result
    const answer = result ? ctx.artifacts.get(result) : undefined
    if (!answer) return
    const parsed = typedBody(textOf(answer.body), typed.schema)
    if (!parsed.ok) return
    const previous = ctx.artifacts.list({ kind: typed.kind, runId, nodeId }).filter((a) => a.bodySchema === typed.schema).at(-1)
    if (previous?.inputs.includes(result!)) return
    ctx.artifacts.put({
      kind: typed.kind, bodySchema: typed.schema, body: parsed.body, inputs: [result!],
      ...(previous ? { lineage: { supersedes: [previous.id as ContentId] } } : {}),
      classification: answer.classification, producer: { type: 'system', ref: name }, runId, nodeId,
    })
  })
}
