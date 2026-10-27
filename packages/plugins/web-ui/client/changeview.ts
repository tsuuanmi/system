// A proposed policy change as the operator reads it: the effective modes it moves and the record's diff.
import type { PolicyChange } from '../src/api.js'
import { copyId, el, shortId } from './dom.js'

/** A line diff of two texts (longest common subsequence). Bounded by the policy body (128 KiB). */
const lineDiff = (before: string, after: string): Array<['same' | 'del' | 'add', string]> => {
  const a = before.split('\n'), b = after.split('\n')
  const n = a.length, m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (lcs[i] as Uint16Array)[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  const out: Array<['same' | 'del' | 'add', string]> = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['same', a[i] ?? '']); i++; j++ }
    else if (at(i + 1, j) >= at(i, j + 1)) out.push(['del', a[i++] ?? ''])
    else out.push(['add', b[j++] ?? ''])
  }
  while (i < n) out.push(['del', a[i++] ?? ''])
  while (j < m) out.push(['add', b[j++] ?? ''])
  return out
}
export const pretty = (value: unknown): string => value === undefined ? '' : JSON.stringify(value, null, 2)
export const diffView = (before: unknown, after: unknown): HTMLElement => el('pre', { class: 'diff' }, lineDiff(pretty(before), pretty(after)).map(([kind, line]) =>
  el('span', kind === 'same' ? {} : { class: kind }, (kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ') + line + '\n')))
const effectView = (effect: PolicyChange['effect']) => effect.length
  ? el('ul', {}, effect.map((e) => el('li', {}, (e.projectId ? 'project ' + e.projectId : 'studio') + ': ' + e.actionClass + ' ', el('span', { class: 'state' }, e.from + ' → ' + e.to))))
  : el('p', { class: 'muted' }, 'No effective mode moves: only expiry, batching, commands, or required checks change.')
const windowText = (seconds: number) => seconds % 86400 === 0 ? seconds / 86400 + (seconds === 86400 ? ' day' : ' days')
  : seconds % 3600 === 0 ? seconds / 3600 + (seconds === 3600 ? ' hour' : ' hours') : seconds + ' seconds'
export const changeView = (change: PolicyChange): HTMLElement => el('div', { class: 'panel' },
  el('p', {}, el('strong', {}, change.policy.id + (change.previous ? ' version ' + change.previous.version + ' → ' + change.policy.version : ' (new, version ' + change.policy.version + ')')),
    copyId('Copy change ID', change.changeId), copyId('Copy request ID', change.requestId)),
  change.note ? el('p', {}, change.note) : null,
  // A change the queue proposed itself says so, and why: never the operator's own proposal (INV-6).
  change.origin ? el('p', {}, el('strong', {}, 'Proposed by the queue, not by you: '), 'you approved ', el('code', {}, change.origin.shape.command),
    ' ' + change.origin.approved + ' times among the requests of the last ' + windowText(change.origin.windowSeconds) + ', and rejected none; decision ', shortId(change.origin.decision, 'Copy decision ID')) : null,
  el('details', {}, el('summary', {}, 'Hashes of both sets'), el('p', { class: 'muted' }, 'Set ', shortId(change.hash, 'Copy set hash'), ', proposed on ', shortId(change.baseHash, 'Copy base hash'))),
  effectView(change.effect),
  diffView(change.previous, change.policy))
