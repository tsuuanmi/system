// `system lead brief --project <id> [--json] [--since <time>]` (PROP-0019 section 3): the flags, and the
// page it prints from a stand-in for the `lead_brief` tool.
import { describe, expect, it } from 'vitest'
import { leadBrief, parseLead, type ToolOutcome } from '../src/index.ts'

describe('system lead brief', () => {
  it('parses --project, --json, and --since, and refuses the rest', () => {
    expect(parseLead(['brief'])).toEqual({ action: 'brief', json: false, ids: [] })
    expect(parseLead(['brief', '--project', 'alpha', '--json', '--since', '2026-10-27T00:00:00Z'])).toEqual({ action: 'brief', json: true, project: 'alpha', since: '2026-10-27T00:00:00Z', ids: [] })
    for (const bad of [['brief', '--since'], ['brief', '--since', 'yesterday'], ['brief', '--timeout', '5'], ['brief', 'extra'], ['wait', '--since', '2026-10-27T00:00:00Z'], ['brief', '--since', '2026-10-27T00:00:00Z', '--since', '2026-10-28T00:00:00Z']]) {
      expect(parseLead(bad), bad.join(' ')).toBeUndefined()
    }
  })

  it('prints the page, or its record with --json, and throws a refusal with its reason', async () => {
    const seen: Array<Record<string, unknown>> = []
    const lines: string[] = []
    const call = async (_tool: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
      seen.push(args)
      return { isError: false, text: 'LEAD BRIEF  project alpha', structured: { project: 'alpha' } }
    }
    expect(await leadBrief(parseLead(['brief', '--project', 'alpha', '--since', '2026-10-27T00:00:00Z'])!, call, (line) => lines.push(line))).toBe(0)
    expect(await leadBrief(parseLead(['brief', '--json'])!, call, (line) => lines.push(line))).toBe(0)
    expect(seen).toEqual([{ projectId: 'alpha', since: '2026-10-27T00:00:00Z' }, {}])
    expect(lines).toEqual(['LEAD BRIEF  project alpha', '{"project":"alpha"}'])
    await expect(leadBrief(parseLead(['brief', '--project', 'beta'])!, async () => ({ isError: true, text: 'reaches only project alpha', structured: undefined }))).rejects.toThrow('reaches only project alpha')
  })
})
