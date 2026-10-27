// `system lead wait|inbox|ack` (D107): the flags, and the loop a lead runs instead of polling, against
// a stand-in for the `lead_inbox` tool: it prints a notice as soon as one is unread, asks again while
// none is, and ends with exit 1 when its timeout passes first.
import { describe, expect, it } from 'vitest'
import { leadInbox, type LeadNoticeView, parseLead, type ToolOutcome } from '../src/index.ts'

const notice: LeadNoticeView = { id: 'alpha:task.landed:task-a:7', project: 'alpha', kind: 'task.landed', title: 'Landed: board task task-a', text: 'Board task task-a landed.', act: ['system lead wait'] }
const answer = (structured: Record<string, unknown>): ToolOutcome => ({ isError: false, text: '', structured })

describe('system lead', () => {
  it('parses wait, inbox, and ack with their flags, and refuses the rest', () => {
    expect(parseLead(['wait'])).toEqual({ action: 'wait', json: false, ids: [] })
    expect(parseLead(['wait', '--project', 'alpha', '--timeout', '30', '--json'])).toEqual({ action: 'wait', json: true, project: 'alpha', timeoutSeconds: 30, ids: [] })
    expect(parseLead(['inbox', '--project', 'alpha'])).toEqual({ action: 'inbox', json: false, project: 'alpha', ids: [] })
    expect(parseLead(['ack', '--project', 'alpha', 'a', 'b'])).toEqual({ action: 'ack', json: false, project: 'alpha', ids: ['a', 'b'] })
    for (const bad of [[], ['ack'], ['wait', '--timeout', '0'], ['wait', '--timeout', '90000'], ['wait', '--project'], ['inbox', '--timeout', '5'], ['wait', 'extra'], ['wait', '--project', 'a', '--project', 'b']]) {
      expect(parseLead(bad), bad.join(' ')).toBeUndefined()
    }
  })

  it('wait asks again while nothing is unread, and prints the notice that comes', async () => {
    const calls: Array<Record<string, unknown>> = []
    const lines: string[] = []
    const call = async (_tool: string, args: Record<string, unknown>) => {
      calls.push(args)
      return answer({ notices: calls.length < 3 ? [] : [notice] })
    }
    const code = await leadInbox(parseLead(['wait', '--project', 'alpha'])!, call, (line) => lines.push(line))
    expect(code).toBe(0)
    expect(calls).toEqual([{ projectId: 'alpha', waitSeconds: 55 }, { projectId: 'alpha', waitSeconds: 55 }, { projectId: 'alpha', waitSeconds: 55 }])
    expect(lines).toEqual(['[task.landed] Landed: board task task-a  (alpha:task.landed:task-a:7)', '  Board task task-a landed.', '  → system lead wait'])
  })

  it('wait times out with exit 1 when no notice comes, asking for no more than the time left', async () => {
    let clock = 0
    const asked: number[] = []
    const call = async (_tool: string, args: Record<string, unknown>) => {
      asked.push(args.waitSeconds as number)
      clock += (args.waitSeconds as number) * 1000
      return answer({ notices: [] })
    }
    const lines: string[] = []
    const code = await leadInbox(parseLead(['wait', '--timeout', '100'])!, call, (line) => lines.push(line), () => clock)
    expect(code).toBe(1)
    expect(asked).toEqual([55, 45])
    expect(lines).toEqual([])
  })

  it('inbox prints what is unread once, ack names the ids, and an error of the tool is thrown', async () => {
    const lines: string[] = []
    const seen: Array<Record<string, unknown>> = []
    const call = async (_tool: string, args: Record<string, unknown>) => {
      seen.push(args)
      return answer('ack' in args ? { notices: [], acked: ['a'], unknown: ['b'] } : { notices: [notice] })
    }
    expect(await leadInbox(parseLead(['inbox', '--json'])!, call, (line) => lines.push(line))).toBe(0)
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: notice.id })
    expect(await leadInbox(parseLead(['ack', 'a', 'b'])!, call, (line) => lines.push(line))).toBe(0)
    expect(seen[1]).toEqual({ ack: ['a', 'b'] })
    expect(lines.at(-1)).toBe('acked 1; unknown or handled already: b')
    await expect(leadInbox(parseLead(['inbox'])!, async () => ({ isError: true, text: 'refused', structured: undefined }))).rejects.toThrow('refused')
  })
})
