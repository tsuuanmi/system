// A scripted ACP agent over stdio, for tests. It answers `echo: <prompt>`; "permission" asks for
// permission first, "read:<path>" asks the client to read a file, "hang" waits for a cancel,
// "stubborn" ignores both a cancel and SIGTERM, "env:<NAME>" answers with that variable,
// "look:<path>" reads the disk on its own (as any agent can), without asking the client.
import { existsSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const cancelled = new Map()
new AgentSideConnection((conn) => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, agentInfo: { name: 'scripted', version: '1.0.0' } }
  },
  async newSession() {
    return { sessionId: 'h-1' }
  },
  async loadSession() {
    return {}
  },
  async authenticate() {
    return {}
  },
  async cancel({ sessionId }) {
    cancelled.get(sessionId)?.()
  },
  async prompt({ sessionId, prompt }) {
    const text = prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const say = (t) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } })
    if (text.includes('stubborn')) {
      process.on('SIGTERM', () => undefined)
      await new Promise(() => undefined)
    }
    const env = /env:(\S+)/.exec(text)
    if (env) {
      await say(`env: ${process.env[env[1]] ?? 'unset'}`)
      return { stopReason: 'end_turn' }
    }
    const look = /look:(\S+)/.exec(text)
    if (look) {
      await say(`look: ${existsSync(look[1]) ? 'present' : 'absent'}`)
      return { stopReason: 'end_turn' }
    }
    if (text.includes('hang')) {
      await new Promise((resolve) => cancelled.set(sessionId, resolve))
      return { stopReason: 'cancelled' }
    }
    if (text.includes('permission')) {
      const answer = await conn.requestPermission({
        sessionId, toolCall: { toolCallId: 't-1', title: 'Write notes.txt', kind: 'edit' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      })
      await say(`permission: ${answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled'}`)
      return { stopReason: 'end_turn' }
    }
    const read = /read:(\S+)/.exec(text)
    if (read) {
      try {
        const file = await conn.readTextFile({ sessionId, path: read[1] })
        await say(`read: ${file.content}`)
      } catch (error) {
        await say(`read refused: ${error.message}`)
      }
      return { stopReason: 'end_turn' }
    }
    await say('echo: ')
    await say(text)
    return { stopReason: 'end_turn' }
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
