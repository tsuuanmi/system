/**
 * The one edit the plugin host makes to the operator's profile patch (`cordis.patch.yml`, DSH's
 * profile patch: docs/architecture/plugin-model.md#composition): a row turned off or on at runtime
 * is kept by its targeted entry's `disabled`, so a restart keeps it (ADR-0078). Line by line, so the
 * operator's comments and every other entry stay as they are; a patch it cannot edit that way is
 * refused, never rewritten (INV-2).
 * @module
 */
import { SwitchError } from '@tsuuanmi/system-plugin-host-core'

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `text` with row `id`'s targeted entry (`- id: <id>` at the top level) saying `disabled: <disabled>`:
 * its `disabled` line replaced, or added under its `id`; with no such entry, one appended. A patch
 * that names the row in a flow mapping (`- { id: … }`) or is a flow list other than the empty `[]`
 * is refused: the host does not rewrite what it cannot edit by lines.
 */
export function editPatch(text: string, id: string, disabled: boolean): string {
  const lines = text.split('\n')
  const quoted = `['"]?${escape(id)}['"]?`
  const item = new RegExp(`^- id:\\s*${quoted}\\s*(#.*)?$`)
  const flow = new RegExp(`[{,]\\s*id:\\s*${quoted}\\s*[,}]`)
  if (lines.some((line) => flow.test(line))) throw new SwitchError('patch', `the profile's patch names row ${id} in a flow mapping ({ id: … }), which the host does not edit: set its disabled by hand, then turn it again`)
  const at = lines.findIndex((line) => item.test(line))
  const value = `  disabled: ${disabled}`
  if (at >= 0) {
    let end = at + 1
    while (end < lines.length && !/^[^\s#]/.test(lines[end]!)) end++
    const own = lines.slice(at + 1, end).findIndex((line) => /^ {2}disabled:/.test(line))
    if (own >= 0) lines[at + 1 + own] = value
    else lines.splice(at + 1, 0, value)
    return lines.join('\n')
  }
  const entry = [`- id: ${id}`, value]
  const empty = lines.findIndex((line) => /^\[\]\s*(#.*)?$/.test(line))
  if (empty >= 0) {
    lines.splice(empty, 1, ...entry)
    return lines.join('\n')
  }
  if (lines.some((line) => line.startsWith('['))) throw new SwitchError('patch', `the profile's patch is a flow list, which the host does not edit: add "- id: ${id}" with "disabled: ${disabled}" by hand`)
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return `${body}${entry.join('\n')}\n`
}
