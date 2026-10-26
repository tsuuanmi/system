/**
 * A read-only research role on agent runtimes (T262, ADR-0074): its Workers read their workspace and
 * search and fetch the web, and nothing else. No writing tool, no shell: their `tools`, at every tier
 * they offer, are reads and the two web tools only, their sandbox is `read-only`, and their gate
 * refuses any call that would write or run a command (`research-role`), whatever the runtime offers.
 * They take research work only (`kinds`, default `[research]`), so an ordinary ask never spends their
 * plan's quota (P1).
 *
 * They prove `reason` while ready, and `web-search` only by the web probe: one real search, on the
 * probe's own fixed query ({@link WEB_PROBE_QUERY}), through the run's gate and the autonomy
 * policy's web access grant as every web call is, recorded as a decision that the offer names as
 * its evidence. A probe that does not search, or whose search the policy does not let run unasked,
 * proves nothing, so the Worker offers `reason` only.
 * @module
 */
import { WEB_RUN_TOOLS } from '@tsuuanmi/system-agent-runtime-core'

/** The reading tools a research role keeps (the runtime's own; Claude Code's names, as the gate's table keys them). */
export const RESEARCH_READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']
/** Every tool a research role's run may list: reads and the web tools, never a writing tool or a shell. */
export const RESEARCH_TOOLS: readonly string[] = [...RESEARCH_READ_TOOLS, ...WEB_RUN_TOOLS]
/** The kind of work a research role takes by default (ADR-0057): the research template's literature steps name it. */
export const RESEARCH_KIND = 'research'

/**
 * The web probe's own query, fixed in code and public: nothing of any run, workspace, or operator is
 * in it, so its egress check reads a constant. Its answer must name a URL of its results.
 */
export const WEB_PROBE_QUERY = 'Wikipedia main page'

/** The prompt of the web probe: one search of the fixed query, and the first result's URL as the whole answer. */
export const WEB_PROBE_PROMPT = [
  'This is a probe of your web search tool. Make exactly one tool call:',
  `WebSearch with the query "${WEB_PROBE_QUERY}" and no other argument.`,
  'Then answer with only the URL of its first result, on one line, and nothing else. Make no other tool call.',
].join('\n')

/** How long a web probe's result stands (24 h), from when it started: the next is made then, in the background. */
export const WEB_PROBE_TTL_MS = 24 * 60 * 60_000
/** How long a failed web probe stands before it is made again (1 h). */
export const WEB_PROBE_RETRY_MS = 60 * 60_000
/** The web probe's own deadline (3 min). */
export const WEB_PROBE_TIMEOUT_MS = 3 * 60_000

/** What a research Worker's configuration must hold, and what it takes by default. */
export interface ResearchShape {
  id: string
  sandbox: 'read-only' | 'workspace-write'
  research?: boolean | undefined
  reviewMember?: boolean | undefined
  tools?: string[] | undefined
  /** The tiers it offers (ADR-0073), each with the tools it may name of its own. */
  tiers?: ReadonlyArray<{ tier: string; tools?: string[] | undefined }> | undefined
  kinds?: string[] | undefined
}

/**
 * Why a research Worker's configuration cannot hold its role, or undefined: it is `read-only`, never a
 * review member (whose gate allows no call), and its tools, its own and each tier's, are reads and the
 * web tools only (no `Write`, `Edit`, or `Bash`).
 */
export function researchProblem(worker: ResearchShape): string | undefined {
  if (!worker.research) return undefined
  if (worker.sandbox !== 'read-only') return 'a research role is read-only (sandbox: read-only): it writes nothing and runs no command'
  if (worker.reviewMember) return 'a research role is not a review member: a review member\'s gate allows no call, and research searches the web'
  const named = [...(worker.tools ?? []), ...(worker.tiers ?? []).flatMap((t) => t.tools ?? [])]
  const other = [...new Set(named.filter((t) => !RESEARCH_TOOLS.includes(t)))]
  if (other.length) return `a research role's tools are ${RESEARCH_TOOLS.join(', ')} only; refusing ${other.join(', ')}`
  return undefined
}

/** A research Worker with its defaults: every research tool when it lists none, and research work only when it names no kind. */
export function withResearchDefaults<T extends ResearchShape>(worker: T): T {
  if (!worker.research) return worker
  return { ...worker, tools: worker.tools?.length ? [...worker.tools] : [...RESEARCH_TOOLS], kinds: worker.kinds ? [...worker.kinds] : [RESEARCH_KIND] }
}

/** The query or URL a web call sends, as the gate's table names its field; undefined for any other tool. */
export function webTarget(tool: string, input: unknown): string | undefined {
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const value = tool === 'WebSearch' ? record.query : tool === 'WebFetch' ? record.url : undefined
  return typeof value === 'string' ? value : undefined
}

/**
 * Whether a web call's query or URL names a path of this machine: the run's workspace or the
 * operator's home, as written, which is local-private whatever the run's classification says. Its
 * egress check runs on top of this (credential patterns, the class's classifications).
 */
export function namesLocalPath(target: string, paths: readonly string[]): boolean {
  return paths.some((p) => p.length > 1 && target.includes(p))
}

/** Whether a probe's answer names a result: an http(s) URL. */
export const answersWithUrl = (text: string): boolean => /\bhttps?:\/\/[^\s<>"']+/i.test(text)
