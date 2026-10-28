/**
 * The one-time import of the lead's decision registry (`decisions.json`, PROP-0019 section 2.7): a file
 * of numbered decisions, each asked or answered, read into `operator-decision@1.0` records. It reads
 * the shapes such a file is written in (a list, `{decisions: [...]}`, or an object keyed by number) and
 * refuses, naming each problem, anything it cannot read exactly: a number twice, a gap in the numbers,
 * an entry that is no valid record. It never guesses a missing time or truncates a text (INV-9, INV-14).
 */
import { isRecord } from '@tsuuanmi/system-libs'
import type { OperatorDecision } from './index.ts'

const ID = /^D?([1-9][0-9]{0,8})$/i
/** The most problems one refusal names. */
const MAX_PROBLEMS = 20
/** The most decisions one registry holds (INV-9): a file past it is refused before any entry is read. */
export const MAX_ENTRIES = 10_000

const first = (entry: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const key of keys) if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') return entry[key]
  return undefined
}

/** A text from a string, or from an object that names it (`text`, `label`, `title`, `ref`, `url`, `path`, `href`). */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isRecord(value)) {
    for (const key of ['text', 'label', 'title', 'words', 'ref', 'url', 'path', 'href']) if (typeof value[key] === 'string') return value[key]
  }
  return undefined
}

/** Options as a list of lines: strings, objects that name their text, or a map from a letter to its text. */
function optionsOf(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (Array.isArray(value)) {
    const lines = value.map((o) => {
      if (isRecord(o) && typeof o['id'] === 'string' && typeof (o['text'] ?? o['label'] ?? o['description']) === 'string') return `${o['id']}: ${String(o['text'] ?? o['label'] ?? o['description'])}`
      return textOf(o)
    })
    return lines.every((l) => l !== undefined) ? lines as string[] : undefined
  }
  if (isRecord(value)) {
    const lines = Object.entries(value).map(([key, o]) => { const t = textOf(o); return t === undefined ? undefined : `${key}: ${t}` })
    return lines.every((l) => l !== undefined) ? lines as string[] : undefined
  }
  return undefined
}

function instant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * The entries of a registry file, each with the key it was filed under (an object keyed by number);
 * undefined when the file is none of the known shapes, and `too many` past {@link MAX_ENTRIES}, told
 * before any entry is read.
 */
function entriesOf(json: unknown): Array<{ key?: string; entry: unknown }> | 'too many' | undefined {
  if (Array.isArray(json)) return json.length > MAX_ENTRIES ? 'too many' : json.map((entry) => ({ entry }))
  if (!isRecord(json)) return undefined
  const list = json['decisions'] ?? json['items']
  if (Array.isArray(list)) return list.length > MAX_ENTRIES ? 'too many' : list.map((entry) => ({ entry }))
  const values = isRecord(list) ? list : json
  const keys = Object.keys(values)
  if (keys.length > MAX_ENTRIES) return 'too many'
  return keys.length && keys.every((key) => ID.test(key)) ? keys.map((key) => ({ key, entry: values[key] })) : undefined
}

/**
 * The numbers missing below the highest, as at most {@link MAX_PROBLEMS} ranges (`D3`, `D5 to D998`)
 * and how many more ranges there are: read from the sorted numbers, so its work is bounded by the
 * entries, never by how large a number is (INV-9).
 */
function gapsOf(numbers: readonly number[]): { ranges: string[]; more: number } {
  const sorted = [...numbers].sort((a, b) => a - b)
  const ranges: string[] = []
  let more = 0
  let previous = 0
  for (const n of sorted) {
    if (n > previous + 1) {
      if (ranges.length < MAX_PROBLEMS) ranges.push(n - 1 === previous + 1 ? `D${previous + 1}` : `D${previous + 1} to D${n - 1}`)
      else more++
    }
    previous = n
  }
  return { ranges, more }
}

/**
 * The records of a registry file in number order, or every problem that makes it unfit: a duplicate
 * number, a gap in 1..N, an entry unreadable as a record. `validate` is the record schema's check.
 */
export function readRegistry(json: unknown, file: string, validate: (record: OperatorDecision) => string | undefined): { records: OperatorDecision[] } | { problems: string[] } {
  const entries = entriesOf(json)
  if (entries === 'too many') return { problems: [`the registry holds more than ${MAX_ENTRIES} decisions, the most one import reads`] }
  if (!entries) return { problems: ['the file is not a decision registry: expected a list of decisions, {"decisions": [...]}, or an object keyed by number'] }
  if (!entries.length) return { problems: ['the registry holds no decision'] }
  const problems: string[] = []
  const byNumber = new Map<number, OperatorDecision>()
  const seen = new Set<number>()
  for (const [index, { key, entry }] of entries.entries()) {
    const where = `entry ${index + 1}${key ? ` (${key})` : ''}`
    if (!isRecord(entry)) { problems.push(`${where}: not an object`); continue }
    const idMatch = ID.exec(String(first(entry, ['id', 'n', 'number']) ?? key ?? ''))
    if (!idMatch) { problems.push(`${where}: no decision number (D<n>)`); continue }
    const n = Number(idMatch[1])
    const at = `D${n}`
    if (seen.has(n)) { problems.push(`${at}: the number is in the file twice`); continue }
    seen.add(n)
    const record = recordOf(entry, n, file, problems)
    if (!record) continue
    const bad = validate(record)
    if (bad) { problems.push(`${at}: ${bad}`); continue }
    byNumber.set(n, record)
  }
  // Every number the file holds, read or not: an entry refused for its own problem is no gap.
  const { ranges, more } = gapsOf([...seen])
  // First, so the bound on what a refusal names never cuts it.
  if (ranges.length) problems.unshift(`gap in the numbers: ${ranges.join(', ')}${more ? ` and ${more} more range(s)` : ''} missing below D${Math.max(...seen)}: a number is never skipped`)
  if (problems.length) return { problems: problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `and ${problems.length - MAX_PROBLEMS} more`] : problems }
  return { records: [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([, record]) => record) }
}

/** One entry as a record; undefined, with its problem told, when it cannot be read. */
function recordOf(entry: Record<string, unknown>, n: number, file: string, problems: string[]): OperatorDecision | undefined {
  const at = `D${n}`
  const question = textOf(first(entry, ['question', 'title', 'text']))
  if (question === undefined) { problems.push(`${at}: no question`); return undefined }
  const status = String(first(entry, ['status', 'state']) ?? '').toLowerCase()
  const state = status === 'answered' || status === 'decided' ? 'answered' : status === 'asked' || status === 'open' || status === 'pending' ? 'asked' : undefined
  if (!state) { problems.push(`${at}: status is ${JSON.stringify(status)}, not asked or answered`); return undefined }
  const askedAt = instant(first(entry, ['askedAt', 'asked', 'asked_at', 'created', 'date']))
  if (!askedAt) { problems.push(`${at}: no asked time`); return undefined }
  const options = optionsOf(first(entry, ['options', 'choices']))
  if (!options) { problems.push(`${at}: options are not lines of text`); return undefined }
  const links = first(entry, ['links', 'refs', 'causes'])
  const linkLines = links === undefined ? [] : Array.isArray(links) ? links.map(textOf) : [textOf(links)]
  if (linkLines.some((l) => l === undefined)) { problems.push(`${at}: links are not lines of text`); return undefined }
  const recommendation = first(entry, ['recommendation', 'recommended'])
  if (recommendation !== undefined && typeof recommendation !== 'string') { problems.push(`${at}: recommendation is not text`); return undefined }
  const project = first(entry, ['projectId', 'project'])
  if (project !== undefined && typeof project !== 'string') { problems.push(`${at}: project is not text`); return undefined }
  const base: OperatorDecision = {
    schema: 'operator-decision@1.0', id: at, ...(project !== undefined ? { projectId: project } : {}), state, question,
    ...(options.length ? { options } : {}), ...(recommendation !== undefined ? { recommendation } : {}), ...(linkLines.length ? { links: linkLines as string[] } : {}),
    askedAt, askedBy: 'import', importedFrom: file, revision: state === 'answered' ? 1 : 0,
  }
  if (state === 'asked') return base
  const answer = textOf(first(entry, ['answer', 'decision', 'resolution']))
  const answeredAt = instant(first(entry, ['answeredAt', 'answered', 'answered_at', 'decidedAt']))
  if (answer === undefined) { problems.push(`${at}: answered, but no answer`); return undefined }
  if (!answeredAt) { problems.push(`${at}: answered, but no answered time`); return undefined }
  return { ...base, answeredAt, answer, answeredBy: 'import' }
}
