/**
 * Turn mechanics every website driver shares, with no page or UI engine in them (each driver
 * keeps its own page reads): mode presets, the two-clock completion options, a conversation
 * binding reported once, the wait for a Deep research report (drift when it is done but cannot
 * be read), and a report's `Sources:` list.
 */
import { waitForStableCompletion, type WaitOptions } from './completion.ts'
import type { AskOptions, ProviderMode } from './driver.ts'
import { ProviderError } from './errors.ts'

/** A driver's turn clocks (ms). */
export interface TurnTimeouts {
  turnMs: number
  stallMs: number
  stableMs: number
  pollMs: number
  /** How long a finished Deep research report may stay unreadable before it is drift. */
  reportReadMs: number
}

/**
 * The configured mode presets: a lookup by name (or the default), refusing an unknown name.
 * A default that is not a configured mode is refused at once, when the driver is built.
 */
export function modePresets(provider: string, modes: Record<string, ProviderMode> = {}, defaultMode?: string): (name: string | undefined) => ProviderMode | undefined {
  if (defaultMode !== undefined && !modes[defaultMode]) {
    throw new ProviderError('config_error', `${provider}: default mode ${defaultMode} is not a configured mode`)
  }
  return (name) => {
    const key = name ?? defaultMode
    if (key === undefined) return undefined
    const preset = modes[key]
    if (!preset) throw new ProviderError('config_error', `${provider}: unknown mode ${key} (configured: ${Object.keys(modes).join(', ') || 'none'})`)
    return preset
  }
}

/** Completion options for one turn: its own deadlines when the caller set them, else the driver's. */
export function completionOptions(timeouts: TurnTimeouts, deadlines: AskOptions['deadlines'], signal: AbortSignal | undefined, pollMs: number = timeouts.pollMs): WaitOptions {
  return {
    timeoutMs: deadlines?.timeoutMs ?? timeouts.turnMs,
    stallTimeoutMs: deadlines?.stallTimeoutMs ?? timeouts.stallMs,
    stableMs: timeouts.stableMs,
    pollMs,
    ...(signal ? { signal } : {}),
  }
}

/** A poll step that reports the conversation's binding to `onBinding` once, as soon as the page shows it. */
export function bindingReporter(bindingOf: () => string | undefined, onBinding: ((binding: string) => void) | undefined): () => void {
  let bound = false
  return () => {
    if (!onBinding || bound) return
    const id = bindingOf()
    if (id) {
      bound = true
      onBinding(id)
    }
  }
}

/** A Deep research run as the page shows it. */
export interface ResearchState {
  running: boolean
  done: boolean
  text: string
  /** What the run shows while it works (its activity), when it shows any: a change is progress. */
  progress?: string
}

/**
 * Wait for a Deep research report on the turn clocks (polled at least every second). A report
 * that is done but stays unreadable past `reportReadMs` is drift, so the turn fails fast
 * instead of waiting out the stall deadline; `element` names the UI map entry to update.
 */
export async function waitForReport(state: () => Promise<ResearchState>, timeouts: TurnTimeouts, options: { provider: string; element: string; deadlines: AskOptions['deadlines']; signal: AbortSignal | undefined }): Promise<string> {
  let unreadableSince: number | undefined
  const completed = await waitForStableCompletion(async () => {
    const current = await state()
    if (current.done && !current.text) {
      unreadableSince ??= Date.now()
      if (Date.now() - unreadableSince > timeouts.reportReadMs) {
        throw new ProviderError('ui_drift', `${options.provider}: Deep research completed, but its report cannot be read; update ${options.element} in the UI map`)
      }
    } else unreadableSince = undefined
    return { responsePresent: current.done && current.text !== '', text: current.text, html: '', running: !current.done, ...(current.progress !== undefined ? { progress: current.progress } : {}) }
  }, completionOptions(timeouts, options.deadlines, options.signal, Math.max(timeouts.pollMs, 1000)))
  return completed.text
}

/**
 * A report followed by its sources (href → title, first title wins), since report text keeps only
 * labels. A title that only repeats the link (the URL itself, or its site, as source pills show
 * it) is left out.
 */
export function withSources(text: string, sources: ReadonlyMap<string, string>): string {
  return `${text}\n\nSources:\n${[...sources].map(([href, title]) => `- ${title && !repeatsLink(title, href) ? `${title} ` : ''}${href}`).join('\n')}`
}

/** Whether a link's title is only its URL or its site ("sqlite.org" of https://www.sqlite.org/wal.html). */
function repeatsLink(title: string, href: string): boolean {
  const bare = (s: string): string => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
  let host = ''
  try {
    host = new URL(href).hostname
  } catch {
    // Not a URL: only the text itself can match.
  }
  return bare(title) === bare(href) || (host !== '' && bare(title) === bare(host))
}

/** A URL without its `utm_*` tracking parameters, which sites add to the links they cite. */
export function withoutTracking(href: string): string {
  try {
    const url = new URL(href)
    const tracking = Array.from(url.searchParams.keys()).filter((key) => key.startsWith('utm_'))
    for (const key of tracking) url.searchParams.delete(key)
    return url.href
  } catch {
    return href
  }
}

/** Markdown with tracking parameters dropped from its link and reference targets (`](url`, `]: url`). */
export function withoutTrackingLinks(markdown: string): string {
  return markdown.replace(/(\]\(<?|^ {0,3}\[[^\]\n]+\]:[ \t]*<?)(https?:\/\/[^\s)>"]+)/gm,
    (_, lead: string, url: string) => lead + (/[?&]utm_/.test(url) ? withoutTracking(url) : url))
}

/** A URL as compared for presence: no tracking parameters, no final slash or trailing punctuation. */
const comparable = (url: string): string => withoutTracking(url.replace(/[.,;:!?]+$/, '')).replace(/\/$/, '')

/**
 * An answer followed by the sources (href → title) its text does not already carry, without
 * tracking parameters; the text alone when it carries them all. A source is carried only by a URL
 * in the text that is the same once tracking parameters, a final slash (a page reports
 * `https://a.example/` for the text's `https://a.example`), and trailing punctuation are set aside.
 */
export function withMissingSources(text: string, sources: ReadonlyMap<string, string>): string {
  const carried = new Set((text.match(/https?:\/\/[^\s)>"\]]+/g) ?? []).map(comparable))
  const missing = new Map<string, string>()
  for (const [href, title] of sources) {
    const clean = withoutTracking(href)
    if (!carried.has(comparable(clean)) && !missing.has(clean)) missing.set(clean, title)
  }
  return missing.size ? withSources(text, missing) : text
}
