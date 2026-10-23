// A Codex stand-in for the runtime's tests: what Codex 0.164 does with a run's configuration, as
// observed live (docs/design/agent-runtimes.md#tool-gate). It runs the PreToolUse hook a run
// installs (`sh -c <command>`, the call as JSON on stdin; exit 0 with no output lets the call run,
// exit 2 blocks it with stderr as the reason), streams the items an allowed call produces, and, for
// the probe, plays one turn against the probe's scripted model.
import { spawn } from 'node:child_process'
import type { ThreadEvent, ThreadItem, ThreadOptions } from '@openai/codex-sdk'
import type { CodexClient, ConfinedExec } from '../src/index.ts'

/** The hook's command from a run's `--config` overrides, as Codex reads `hooks.PreToolUse`. */
export function hookCommand(overrides: readonly string[]): string | undefined {
  const definition = overrides.find((o) => o.startsWith('hooks.PreToolUse='))
  const quoted = definition && /command=("(?:[^"\\]|\\.)*")/.exec(definition)?.[1]
  return quoted ? JSON.parse(quoted) as string : undefined
}

/** Runs the hook as Codex does; `blocked` with the reason it gave, or not. */
export function runHook(command: string, env: Record<string, string>, call: { tool: string; input: unknown; id: string }, cwd: string): Promise<{ blocked: boolean; reason: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => {
      // Codex 0.164: exit 2 blocks with stderr; any other failure, or output it cannot read, lets the call run.
      if (code === 2) resolve({ blocked: true, reason: stderr.split('\n').filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n').trim() })
      else resolve({ blocked: false, reason: stdout })
    })
    child.stdin.end(JSON.stringify({
      session_id: 'thread-1', turn_id: 'turn-1', transcript_path: null, cwd, hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'bypassPermissions',
      tool_name: call.tool, tool_input: call.input, tool_use_id: call.id,
    }))
  })
}

/** One step of a scripted turn: an event Codex streams, or a tool call it makes (through the hook, when one is installed). */
export type Step = ThreadEvent | { call: { tool: string; input: unknown }; item?: ThreadItem }

export interface Recorded {
  options: ThreadOptions
  resume?: string
  prompt?: string
  /** What the hook said about each call, in order (a call with no hook installed runs). */
  hooks: Array<{ tool: string; blocked: boolean; reason: string }>
}

/** A Codex client stand-in: records what it was asked, plays `script` for each run, and honours the run's signal. */
export function scripted(script: (prompt: string) => Step[] = (prompt) => [
  { type: 'thread.started', thread_id: 'h-1' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: `echo: ${prompt}` } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
]) {
  const calls: Recorded[] = []
  const lastClient: { program?: string | undefined; config?: unknown; overrides?: string[] | undefined; env?: Record<string, string> | undefined } = {}
  const thread = (resume: string | undefined, options: ThreadOptions) => {
    const call: Recorded = { ...(resume ? { resume } : {}), options, hooks: [] }
    calls.push(call)
    let id: string | null = resume ?? null
    const overrides = lastClient.overrides ?? []
    const env = lastClient.env ?? {}
    return {
      get id() { return id },
      runStreamed: async (prompt: string, opts?: { signal?: AbortSignal }) => {
        call.prompt = prompt
        const steps = script(prompt)
        return {
          events: (async function* (): AsyncGenerator<ThreadEvent> {
            let n = 0
            for (const step of steps) {
              if (opts?.signal?.aborted) throw new Error('The operation was aborted')
              if ('call' in step) {
                n += 1
                const command = hookCommand(overrides)
                const said = command ? await runHook(command, env, { ...step.call, id: `call_${n}` }, options.workingDirectory!) : { blocked: false, reason: '' }
                call.hooks.push({ tool: step.call.tool, ...said })
                // A blocked call produces no item; an allowed one produces its own.
                if (!said.blocked && step.item) {
                  yield { type: 'item.started', item: step.item }
                  yield { type: 'item.completed', item: step.item }
                }
                continue
              }
              if (step.type === 'thread.started') id = step.thread_id
              yield step
            }
            if (opts?.signal?.aborted) throw new Error('The operation was aborted')
          })(),
        }
      },
    }
  }
  const client = (options: { codexPathOverride?: string; config?: unknown; configOverrides?: string[]; env?: Record<string, string> }): CodexClient => {
    lastClient.program = options.codexPathOverride
    lastClient.config = options.config
    lastClient.overrides = options.configOverrides
    lastClient.env = options.env
    return { startThread: (o) => thread(undefined, o), resumeThread: (id, o) => thread(id, o) }
  }
  return { calls, client, lastClient }
}

export interface ProbeBehaviour {
  /** Codex runs the hook (default), or skips it (an untrusted hook: Codex runs the tool unasked). */
  hook?: 'runs' | 'skipped'
  /** A terminal session starts for a `tty` command (the terminal devices were not hidden). */
  terminal?: boolean
  /** The request offers a hosted tool too. */
  hosted?: boolean
  /** Codex's exit code. */
  code?: number
}

/** Plays the probe's turn as Codex would, from the command line the runtime built: `--config`, `--cd`, the scripted model. */
export function probeExec(behaviour: ProbeBehaviour = {}, seen: string[][] = []): ConfinedExec {
  return async (command, env) => {
    const args = command.args.slice(command.args.indexOf('--') + 2)
    seen.push(args)
    const overrides = args.flatMap((a, i) => (args[i - 1] === '--config' ? [a] : []))
    const cwd = args[args.indexOf('--cd') + 1]!
    const provider = overrides.find((o) => o.startsWith('model_providers.'))!
    const base = /base_url="([^"]+)"/.exec(provider)![1]!
    const hook = hookCommand(overrides)
    const tools = [{ type: 'function', name: 'exec_command' }, { type: 'function', name: 'write_stdin' }, { type: 'custom', name: 'apply_patch' }, ...(behaviour.hosted ? [{ type: 'web_search' }] : [])]
    const input: unknown[] = []
    const lines = [JSON.stringify({ type: 'thread.started', thread_id: 'probe' })]
    for (let turn = 0; turn < 5; turn++) {
      const response = await fetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools, input }) })
      const items = (await response.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as { type: string; item?: Record<string, unknown> })
        .filter((e) => e.type === 'response.output_item.done').map((e) => e.item!)
      let done = false
      for (const item of items) {
        if (item.type === 'message') {
          lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: (item.content as Array<{ text: string }>)[0]!.text } }))
          done = true
          continue
        }
        const { cmd, tty } = JSON.parse(item.arguments as string) as { cmd: string; tty?: boolean }
        input.push(item)
        const said = hook && behaviour.hook !== 'skipped' ? await runHook(hook, env, { tool: 'Bash', input: { command: cmd }, id: item.call_id as string }, cwd) : { blocked: false, reason: '' }
        const output = said.blocked ? `Command blocked by PreToolUse hook: ${said.reason}. Command: ${cmd}`
          : tty ? (behaviour.terminal ? 'Process running with session ID 7\nOutput:\n' : 'exec_command failed: CreateProcess { message: "failed to openpty: Permission denied" }')
            : `Process exited with code 0\nOutput:\n${cmd.replace(/^echo /, '')}\n`
        input.push({ type: 'function_call_output', call_id: item.call_id, output })
      }
      if (done) break
    }
    lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }))
    return { code: behaviour.code ?? 0, stdout: `${lines.join('\n')}\n` }
  }
}
