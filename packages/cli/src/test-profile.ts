/**
 * The `system-test` profile (T323): the profile every live update, and every mechanism newly
 * switched on, runs on first, so the live flow is never the first to meet it. It composes the same
 * bundle and the same patch rows as the live profile, apart from what this file changes:
 *
 * - its own data directory (`<home>/system-test`: store, vault, tokens, discovery file) and its own
 *   port, so it shares neither a file nor a socket with the live profile;
 * - no website account and no agent account: every row that signs in to one is off, and so is the
 *   account catalog, so no account the live profile uses is opened a second time (one context per
 *   account, never shared);
 * - Workers are the scripted `fake` source (`workers-fake`, off in the bundle, on here) and the
 *   API model rows the live patch carries, which the canary (`scripts/live-stage.sh`) drives.
 */
import { parse, stringify } from 'yaml'

/** The live profile's port is the bundle's (`webserver`, 47317); the test profile listens on the next one. */
export const TEST_PORT = 47318

/**
 * Every row that signs in to a website or an agent account, runs a real agent, or holds an account
 * catalog: all optional rows (docs/architecture/plugin-model.md#required-and-optional-rows).
 */
export const TEST_OFF_ROWS = [
  'accounts', 'display', 'browser', 'providers', 'provider-chatgpt-web', 'provider-gemini-web', 'login', 'turns',
  'agent-runtimes', 'runtime-claude-agent-sdk', 'runtime-codex-sdk', 'runtime-acp', 'runtime-antigravity-cli', 'agent-workers',
  'gateway-anthropic', 'gateway-responses', 'notify',
] as const

/** The rows the test profile sets itself: its port, and every file or directory it keeps, under `state`. */
export function testRows(state: string): Array<Record<string, unknown>> {
  return [
    { id: 'webserver', config: { host: '127.0.0.1', port: TEST_PORT } },
    { id: 'store', config: { path: `${state}/system.db` } },
    { id: 'credentials', config: { path: `${state}/vault.enc`, keyFile: `${state}/vault.key` } },
    { id: 'web-ui', config: { tokenDir: state } },
    { id: 'mcp-server', config: { tokenDir: state, discoveryFile: `${state}/mcp.json` } },
    // The fake Workers: the only Workers the canary runs on (beside any API model rows the live patch carries).
    { id: 'workers-fake', disabled: false },
    ...TEST_OFF_ROWS.map((id) => ({ id, disabled: true })),
  ]
}

/**
 * The live profile's patch as the test profile takes it: every entry, so the same rows compose and a
 * mechanism the live patch switches on is switched on here too, but what signs in to an account. An
 * entry that sets a row is kept unless the row is one the test profile turns off; an entry that
 * inserts rows keeps each of them but a row of an off id, or of an off row's package
 * (`offPackages`: another instance of a row that signs in), and an entry that sets such a dropped
 * row goes with it. Any other entry is refused, never passed over: the stage would then run another
 * composition than the live one (INV-2).
 */
export function stagePatch(live: readonly unknown[], offPackages: ReadonlySet<string> = new Set()): unknown[] {
  const off = new Set<string>(TEST_OFF_ROWS)
  const dropped = new Set<string>()
  const kept: unknown[] = []
  for (const entry of live) {
    const e = entry !== null && typeof entry === 'object' ? entry as Record<string, unknown> : undefined
    if (e && Array.isArray(e.insert)) {
      const rows = (e.insert as Array<{ id?: unknown; name?: unknown }>).filter((row) => {
        const signsIn = (typeof row.id === 'string' && off.has(row.id)) || (typeof row.name === 'string' && offPackages.has(row.name))
        if (signsIn && typeof row.id === 'string') dropped.add(row.id)
        return !signsIn
      })
      if (rows.length) kept.push({ ...e, insert: rows })
    } else if (e && typeof e.id === 'string') {
      if (!off.has(e.id) && !dropped.has(e.id)) kept.push(entry)
    } else {
      throw new Error(`the live patch holds an entry the test profile cannot reproduce (${JSON.stringify(entry)?.slice(0, 120)}): only entries that set a row (id) or insert rows (insert) are staged, so stage this update by hand`)
    }
  }
  return kept
}

/** {@link testProfilePatch} of a live patch file's text (a list of patch entries). */
export function testProfilePatchOf(state: string, liveText: string, offPackages: ReadonlySet<string> = new Set()): string {
  const live = parse(liveText) as unknown
  if (live !== null && !Array.isArray(live)) throw new Error('the live patch is not a list of patch entries')
  return testProfilePatch(state, live ?? [], offPackages)
}

/**
 * The patch of the `system-test` profile with its data in `state`: the live patch's entries kept by
 * {@link stagePatch} (the stage's), then this profile's own, which win.
 */
export function testProfilePatch(state: string, live: readonly unknown[] = [], offPackages: ReadonlySet<string> = new Set()): string {
  return `# The system-test profile (T323): its own data directory and port, no website or agent account, and\n# the fake Workers. Live updates and newly switched-on mechanisms run here first.\n${stringify([...stagePatch(live, offPackages), ...testRows(state)])}`
}
