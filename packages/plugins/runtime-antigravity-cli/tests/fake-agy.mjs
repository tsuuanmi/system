// A scripted Antigravity CLI for the runtime's tests: no model, no network. It answers
// `--version`, `models` (signed in unless FAKE_AGY_SIGNED_OUT), `plugin list --json`
// (FAKE_AGY_PLUGINS, default none), and `--print=/usage --output-format json` (below). In print mode it streams stream-json as agy does
// (`{"event":"<name>","<name>":{…}}`): an `init` naming the conversation `h-1`, then each tool call
// of the scenario, each first through the PreToolUse hooks of `$HOME/.gemini/config/hooks.json`,
// run as agy runs them (`sh -c` in that directory, the call as JSON on stdin, bounded by the
// hook's timeout), then a `result` answering `echo: <prompt>` with agy's usage fields. The
// scenario (FAKE_AGY_SCENARIO, a JSON file) may name `calls` (`{ name, args }`, or `{ input }`: a
// hook input as recorded from the real agy, given to the hooks as it is), `result` (overrides; null: no
// result), `exitCode`, `stderr`, `hang` (wait to be killed after the calls), and `events` (extra
// lines before the result). Each invocation appends what it saw to FAKE_AGY_LOG.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const env = process.env
const log = (entry) => {
  if (env.FAKE_AGY_LOG) appendFileSync(env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`)
}
const seen = {
  argv, cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(env).filter(([k]) => /^(HOME|XDG_|AGY_|SYSTEM_|PATH$|FORWARDED_|DAEMON_)/.test(k))),
}

if (argv[0] === '--version') {
  console.log('1.4.6')
  process.exit(0)
}
if (argv[0] === 'models') {
  log({ ...seen, command: 'models' })
  if (env.FAKE_AGY_SIGNED_OUT) {
    console.error('Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.')
    process.exit(1)
  }
  console.log('model-main')
  process.exit(0)
}
if (argv[0] === 'plugin' && argv[1] === 'list' && argv[2] === '--json') {
  console.log(env.FAKE_AGY_PLUGINS ?? '[]')
  process.exit(0)
}
// Its usage report, as print mode answers `/usage` itself (no turn): FAKE_AGY_USAGE (a file holding
// what it prints), else a report with no quota buckets; FAKE_AGY_USAGE_FAIL fails it with that message.
if (argv[0] === '--print=/usage' && argv[1] === '--output-format' && argv[2] === 'json' && argv.length === 3) {
  log({ ...seen, command: 'usage' })
  if (env.FAKE_AGY_USAGE_FAIL) {
    console.error(env.FAKE_AGY_USAGE_FAIL)
    process.exit(1)
  }
  process.stdout.write(env.FAKE_AGY_USAGE ? readFileSync(env.FAKE_AGY_USAGE, 'utf8')
    : `${JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: '', duration_seconds: 0, num_turns: 0, command: { name: 'usage', data: { groups: [] } } })}\n`)
  process.exit(0)
}
const print = argv.find((a) => a.startsWith('--print='))
if (!print || argv[argv.indexOf('--output-format') + 1] !== 'stream-json') {
  console.error(`fake agy: unexpected arguments ${JSON.stringify(argv)}`)
  process.exit(2)
}
const prompt = print.slice('--print='.length)
const scenario = env.FAKE_AGY_SCENARIO ? JSON.parse(readFileSync(env.FAKE_AGY_SCENARIO, 'utf8')) : {}
const emit = (event, payload) => process.stdout.write(`${JSON.stringify({ event, [event]: payload })}\n`)

/** The PreToolUse hooks of the home's hooks.json that match `tool`. */
function hooksFor(tool) {
  const file = join(env.HOME, '.gemini', 'config', 'hooks.json')
  if (!existsSync(file)) return []
  const spec = JSON.parse(readFileSync(file, 'utf8'))
  return Object.values(spec).filter((h) => h.enabled !== false).flatMap((h) => h.PreToolUse ?? [])
    .filter((group) => !group.matcher || group.matcher === '*' || new RegExp(`^(?:${group.matcher})$`).test(tool))
    .flatMap((group) => group.hooks.map((hook) => ({ ...hook, dir: dirname(file) })))
}

/** Run one hook as agy does; an answer it cannot read counts as a deny here. */
function runHook(hook, input) {
  const r = spawnSync('sh', ['-c', hook.command], { cwd: hook.dir, env, input: JSON.stringify(input), encoding: 'utf8', timeout: (hook.timeout ?? 30) * 1000 })
  try {
    return JSON.parse(r.stdout.trim().split('\n').at(-1))
  } catch {
    return { decision: 'deny', reason: `the hook failed (${r.status ?? r.signal}): ${r.stderr}` }
  }
}

emit('init', { conversation_id: 'h-1', model: 'model-main' })
const calls = []
for (const [stepIdx, call] of (scenario.calls ?? []).entries()) {
  const input = call.input ?? {
    toolCall: { name: call.name, args: call.args }, stepIdx, conversationId: 'h-1', workspacePaths: [process.cwd()],
    transcriptPath: join(env.HOME, '.gemini', 'antigravity-cli', 'brain', 'h-1', 'transcript.jsonl'), artifactDirectoryPath: join(env.HOME, '.gemini', 'antigravity-cli', 'brain', 'h-1'), modelName: 'model-main',
  }
  const name = input.toolCall.name
  let answer = { decision: 'allow' }
  for (const hook of hooksFor(name)) {
    answer = runHook(hook, input)
    if (answer.decision !== 'allow') break
  }
  calls.push({ name, answer })
  emit('step', { tool: name, status: answer.decision === 'allow' ? 'ran' : 'denied', ...(answer.reason ? { reason: answer.reason } : {}) })
}
log({ ...seen, command: 'print', prompt, calls })
for (const line of scenario.events ?? []) process.stdout.write(`${JSON.stringify(line)}\n`)
if (scenario.hang) setInterval(() => undefined, 1000)
else {
  if (scenario.stderr) process.stderr.write(`${scenario.stderr}\n`)
  if (scenario.result !== null) {
    emit('result', {
      conversation_id: 'h-1', status: 'SUCCESS', response: `echo: ${prompt}`, error: '', duration_seconds: 1, num_turns: 2,
      usage: { input_tokens: 1500, output_tokens: 300, thinking_tokens: 200, cache_read_tokens: 1000, total_tokens: 2000 },
      ...scenario.result,
    })
  }
  process.exitCode = scenario.exitCode ?? (scenario.result === null ? 1 : 0)
}
