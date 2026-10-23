import { describe, expect, it } from 'vitest'
import { runtimeOf } from '../src/teams.ts'

describe('a team member\'s session records the runtime that serves it (worker-session@1.x binding.runtime)', () => {
  it('records an Antigravity CLI member as antigravity-cli, no longer as local-tool (worker-session@1.1)', () => {
    expect(runtimeOf('agents', 'antigravity-cli')).toBe('antigravity-cli')
    expect(runtimeOf('agents', 'claude-agent-sdk')).toBe('claude-agent-sdk')
    expect(runtimeOf('agents', 'codex-sdk')).toBe('codex-sdk')
    expect(runtimeOf('website', 'chatgpt')).toBe('website')
    // A kind the vocabulary does not name is still recorded as local-tool: the engine never names a runtime (INV-11).
    expect(runtimeOf('agents', 'some-new-runtime')).toBe('local-tool')
  })
})
