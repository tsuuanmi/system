// The autonomy policy in force, its history, and a proposed change with its diff; a proposal is a policy-change request in the approval queue, and only the operator's approval there applies it.
import type { PolicyChange, PolicyRecord, PolicyResponse, PolicyRule, ProposeResponse } from '../src/api.js'
import { ago, chip, copyId, decision, el, fold, qty, shortId, table, type Child } from './dom.js'
import { changeView, diffView, pretty } from './changeview.js'
import { pageHead, whatIs } from './glossary.js'
import { decideLink } from './router.js'
import { queue } from './queue.js'
import { api, asApiError, errorState, report, say, show } from './state.js'

const MODE: Record<string, string> = { auto: 'Automatic', notify: 'Notify', ask: 'Ask approval', forbid: 'Blocked' }, TONE: Record<string, string> = { auto: 'ok', notify: 'info', ask: 'warn', forbid: 'bad' }
const MODES = ['auto', 'notify', 'ask', 'forbid'] as const
const modeChip = (m: string) => chip(MODE[m] ?? m, TONE[m] ?? 'idle')
const WHY: Record<string, string> = { merge: 'an accepted result lands only on your approval', 'external-send': 'it cannot be undone', deploy: 'it cannot be undone', 'delete-data': 'it cannot be undone', spend: 'it is your decision', charter: 'it is your decision', funding: 'it is your decision', 'policy-change': 'it is your decision', remediation: 'a fix that writes, or a lost run going on, is yours to allow', promotion: 'the system never approves its own change' }
const NEW = '(a new project policy)'
const hours = (seconds: number) => String(Math.round(seconds / 36) / 100), minutes = (seconds: number) => String(Math.round(seconds / 0.6) / 100)
const agoOf = (t?: string) => t ? ago(t) : '-'
export async function policyView(): Promise<void> {
  let value: PolicyResponse
  try { value = await api<PolicyResponse>('policy') } catch (error) {
    const e = asApiError(error)
    show(pageHead('policy'), e.status === 503 ? el('p', { class: 'muted' }, 'The approval queue is not running, so there is no autonomy policy to show.') : errorState('The policy could not be read: ' + e.message + '.'))
    return
  }
  const { set, policies, effective, changes, proposals } = value
  const q = await queue(), okQueue = q && !('error' in q) ? q : undefined
  const askedCards = (changes ?? []).filter((c) => c.state === 'asked').flatMap((c) => { const r = okQueue?.requests.find((x) => x.requestId === c.requestId); return r && okQueue ? [okQueue.card(r)] : [] })
  const columns = effective.map((e) => e.projectId ? 'project ' + e.projectId : 'studio')
  const classes = (effective[0]?.effective ?? []).map((e) => e.actionClass)
  // The proposed record, edited as a form or, under Advanced, as JSON; both edit one draft. The queue validates the proposal: the page refuses nothing it would take.
  const fixed = new Set(value.alwaysAsk ?? [])
  const editor = el('textarea', { 'aria-label': 'Proposed policy record (JSON)', spellcheck: 'false' })
  const note = el('input', { placeholder: 'why (optional)', 'aria-label': 'Note for the proposed change' }), preview = el('div', {}), form = el('div', {})
  const pick = el('select', { 'aria-label': 'Policy to change' }, policies.map((p) => el('option', { value: p.id }, p.id)), el('option', { value: NEW }, NEW))
  const selected = () => policies.find((p) => p.id === pick.value)
  let draft: PolicyRecord
  const edit = (change: (d: PolicyRecord) => void) => { change(draft); editor.value = pretty(draft); preview.replaceChildren() }
  const number = (label: string, id: string, shown: string, onvalue: (n: number | undefined) => void, step = 'any') => {
    const input = el('input', { id, type: 'number', value: shown, min: '0', step, class: 'number' })
    input.addEventListener('input', () => onvalue(input.value === '' ? undefined : Number(input.value)))
    return el('label', { for: id }, label, input)
  }
  const setKey = <K extends string>(target: Partial<Record<K, number>>, key: K, n: number | undefined) => { if (n === undefined) delete target[key]; else target[key] = n }
  const setBatch = (key: 'maxSize' | 'maxWaitSeconds', n: number | undefined) => edit((d) => {
    const next = { ...d.batch }
    setKey(next, key, n)
    if (next.maxSize === undefined && next.maxWaitSeconds === undefined) delete d.batch; else d.batch = next
  })
  const setExpiry = (key: 'defaultSeconds' | 'maxSeconds', h: number | undefined) => edit((d) => { const next = { ...d.expiry }; setKey(next, key, h === undefined ? undefined : Math.round(h * 3600)); d.expiry = next })
  const buildForm = () => {
    const p = draft, studio = p.scope !== 'project'
    const ruleOf = (c: string) => (p.rules ?? []).find((r) => r.actionClass === c)
    const modeRow = (c: string) => {
      const rule = ruleOf(c)
      if (fixed.has(c)) return el('tr', {}, el('td', {}, c), el('td', {}, el('strong', {}, rule?.mode === 'forbid' ? 'Blocked' : 'Approval required')),
        el('td', { class: 'muted' }, rule?.mode === 'forbid' ? el('div', { class: 'state failed' }, 'Blocked here; change it under Advanced') : null,
          el('details', { class: 'fold inline' }, el('summary', {}, 'Why always'), 'It always asks, whatever a rule says: ' + (WHY[c] || 'the queue always asks for it') + '.'), whatIs('always-ask')))
      const select = el('select', { id: 'mode-' + c, 'aria-label': 'Mode of ' + c },
        el('option', { value: '' }, studio ? 'Use default (' + MODE[p.default ?? ''] + ')' : 'Use studio policy'),
        MODES.map((m) => el('option', { value: m }, MODE[m])))
      select.value = rule ? rule.mode : ''
      select.addEventListener('change', () => edit((d) => {
        const kept = (d.rules ?? []).filter((r) => r.actionClass !== c), mode = select.value
        d.rules = !mode ? kept : ruleOf(c) ? (d.rules ?? []).map((r): PolicyRule => r.actionClass === c ? { ...r, mode } : r) : [...kept, { actionClass: c, mode }]
        buildForm(); document.getElementById('mode-' + c)?.focus()
      }))
      return el('tr', {}, el('td', {}, el('label', { for: 'mode-' + c }, c)), el('td', {}, select),
        el('td', { class: 'muted' }, rule ? [rule.requires?.length ? 'Requires: ' + rule.requires.join(', ') : null, rule.expiresSeconds ? 'Expires: ' + hours(rule.expiresSeconds) + ' h' : null].filter(Boolean).join(' · ') : ''))
    }
    const fallback = el('select', { id: 'policy-default', 'aria-label': 'Default mode' }, el('option', { value: 'ask' }, MODE.ask), el('option', { value: 'forbid' }, MODE.forbid))
    fallback.value = p.default ?? 'ask'
    fallback.addEventListener('change', () => edit((d) => { d.default = fallback.value; buildForm(); document.getElementById('policy-default')?.focus() }))
    const commands = el('textarea', { id: 'policy-commands', class: 'lines', 'aria-label': 'Workspace-write commands, one per line', spellcheck: 'false' })
    commands.value = (p.commands ?? []).join('\n')
    commands.addEventListener('input', () => edit((d) => {
      const lines = commands.value.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length) d.commands = lines; else delete d.commands
    }))
    const project = studio ? null : el('input', { id: 'policy-project', value: p.projectId || '', 'aria-label': 'Project of the new policy' })
    project?.addEventListener('input', () => edit((d) => { d.projectId = project.value.trim(); if (!selected()) d.id = project.value.trim() + '.policy' }))
    const batch = p.batch ?? {}, current = selected()
    form.replaceChildren(
      el('p', {}, el('strong', {}, p.id), ' · ' + (current ? 'Version ' + current.version + ' → ' + p.version : 'New project policy · Version ' + p.version),
        project ? el('span', {}, ' · ', el('label', { for: 'policy-project' }, 'project ', project)) : null),
      table(['Action type', 'Mode', 'Notes'], classes.map(modeRow), 'modes'),
      el('div', { class: 'batch-actions' },
        studio ? el('label', { for: 'policy-default' }, 'Default mode', fallback) : null,
        number('Request expiry (h)', 'policy-expiry', hours(p.expiry.defaultSeconds ?? 0), (h) => setExpiry('defaultSeconds', h)),
        number('Maximum expiry (h)', 'policy-expiry-max', hours(p.expiry.maxSeconds ?? 0), (h) => setExpiry('maxSeconds', h)),
        number('Batch size (requests)', 'policy-batch-size', batch.maxSize === undefined ? '' : String(batch.maxSize), (n) => setBatch('maxSize', n), '1'),
        number('Batch delay (min)', 'policy-batch-wait', batch.maxWaitSeconds === undefined ? '' : minutes(batch.maxWaitSeconds), (m) => setBatch('maxWaitSeconds', m === undefined ? undefined : Math.round(m * 60)))),
      el('label', { for: 'policy-commands' }, 'Workspace-write commands', commands),
      fold('How commands match', 'One command per line; a command a Worker runs is judged a workspace write when it matches a line word for word.'))
  }
  const fill = () => {
    const p = selected()
    draft = p ? { ...p, version: p.version + 1 }
      : { schema: 'autonomy-policy@1.0', id: 'project-id.policy', version: 1, scope: 'project', projectId: 'project-id', narrows: policies[0]?.id ?? '', rules: [{ actionClass: 'merge', mode: 'ask' }], default: 'ask', expiry: { defaultSeconds: 86400, maxSeconds: 1209600 } }
    editor.value = pretty(draft); preview.replaceChildren(); buildForm()
  }
  pick.addEventListener('change', fill)
  const parsed = (): unknown => { try { return JSON.parse(editor.value) } catch (error) { preview.replaceChildren(el('p', { class: 'state failed' }, 'Not JSON: ' + asApiError(error).message)); return undefined } }
  editor.addEventListener('input', () => {
    let next: Partial<PolicyRecord> | null
    try { next = JSON.parse(editor.value) } catch { return }
    if (next && typeof next === 'object' && !Array.isArray(next) && Array.isArray(next.rules) && next.expiry && typeof next.expiry === 'object') { draft = next as PolicyRecord; buildForm() }
  })
  const showDiff = () => {
    const proposed = parsed(), current = selected()
    if (proposed !== undefined) preview.replaceChildren(el('p', { class: 'muted' }, current ? 'Changes to ' + current.id + ' version ' + current.version + ':' : 'A new policy:'), diffView(current, proposed))
  }
  const propose = async () => {
    const proposed = parsed()
    if (proposed === undefined) return
    try {
      const { change, request } = await api<ProposeResponse>('policy/propose', { policy: proposed, note: note.value })
      say('proposed ' + change.changeId + ': decide request ' + request.requestId + ' in the approval queue')
      report(true, 'Proposed: ' + change.policy.id + ' version ' + change.policy.version, ['Approval needed — nothing changes until you approve it, at the top of this page or on Home.',
        fold('Record IDs', el('div', {}, 'Recorded as change ', shortId(change.changeId, 'Copy change ID'), '; request ', shortId(request.requestId, 'Copy request ID'), '.'))])
      await policyView()
    } catch (error) { preview.replaceChildren(el('p', { class: 'state failed', role: 'alert' }, 'Not proposed: ' + asApiError(error).message)) }
  }
  const history = (list: PolicyChange[]): Child[] => [
    el('h3', {}, 'History'), !list.length ? el('p', { class: 'muted' }, 'No policy changes yet.') : null,
    list.length ? table(['Policy', 'State', 'Proposed', 'In force from', 'Effect'], list.map((c) => el('tr', {},
      el('td', {}, c.policy.id + ' ' + (c.previous ? c.previous.version + ' → ' : '') + c.policy.version + (c.origin ? ' (proposed by the queue)' : '')),
      el('td', { class: 'nowrap' }, c.state === 'asked' ? decideLink(c.requestId, 'Approval needed')
        : chip(c.state + (c.declined ? ' (' + c.declined.cause + ')' : ''), c.state === 'applied' ? 'ok' : c.state === 'declined' ? 'bad' : 'idle')),
      el('td', { class: 'muted' }, agoOf(c.proposedAt)),
      el('td', { class: 'muted' }, c.applied ? [agoOf(c.applied.at), c.retired ? [' until ', agoOf(c.retired.at)] : null] : '-'),
      el('td', {}, c.effect.length ? fold(qty(c.effect.length, 'action') + ' changed', c.effect.map((e) => el('div', {}, (e.projectId || 'studio') + ' ' + e.actionClass + ' ' + e.from + '→' + e.to))) : '-', copyId('Copy change ID', c.changeId))))) : null,
    list.length ? el('details', {}, el('summary', {}, 'Diffs'), list.map(changeView)) : null,
  ]
  show(
    pageHead('policy'),
    askedCards.length ? el('section', { 'aria-label': 'Changes awaiting approval' }, el('h3', {}, 'Changes awaiting approval · ' + askedCards.length), askedCards) : null,
    set ? el('div', {}, el('p', {}, 'Active policy · ' + (set.source === 'store' ? 'Approved change' : 'Configuration')),
      el('details', { class: 'fold' }, el('summary', {}, 'Exact set'),
        set.source === 'store' && set.changeId ? el('div', {}, 'The change ', shortId(set.changeId, 'Copy change ID'), ' you approved, kept while the configuration it came from is unchanged.') : el('div', {}, 'The configuration in force.'),
        el('div', {}, 'set ', shortId(set.hash, 'Copy set hash')), set.configHash ? el('div', { class: 'muted' }, 'configuration ', shortId(set.configHash, 'Copy configuration hash')) : null)) : null,
    el('p', {}, MODES.map((m) => [modeChip(m), ' ']), whatIs('mode')),
    fold('About modes', 'Automatic: it runs on its own · Notify: it runs, then tells you · Ask approval: it waits for your approval on Home · Blocked: it never runs. Stored as auto, notify, ask, and forbid.'),
    table(['Action type', ...columns], classes.map((c) => el('tr', {}, el('td', {}, c), effective.map((e) => { const m = e.effective.find((x) => x.actionClass === c)?.mode; return el('td', m ? { title: m } : {}, m ? MODE[m] ?? m : '-') }))), 'queue'),
    el('h3', {}, 'Policies'),
    table(['Policy', 'Scope', 'Version'], policies.map((p) => el('tr', {}, el('td', {}, el('code', {}, p.id)), el('td', {}, p.scope + (p.projectId ? ' ' + p.projectId : '')), el('td', {}, String(p.version))))),
    proposals ? el('section', { class: 'panel', 'aria-label': 'Propose a change' },
      el('h3', {}, 'Propose a change'), el('p', { class: 'muted' }, 'Preview your changes, then submit for approval.'), el('p', {}, el('label', {}, 'Policy ', pick)), form,
      el('details', { class: 'advanced' }, el('summary', {}, 'Advanced: the record as JSON'), el('p', { class: 'muted' }, 'Every field of the record, as the form edits it; an edit here shows in the form once it is valid JSON. Nothing changes until you approve the change in the approval queue, and the whole set must load as a configuration would.'), editor),
      el('p', {}, note),
      el('div', { class: 'actions' }, decision('Show change', 'shows what your edit changes, below; proposes nothing', { onclick: showDiff }),
        decision('Propose', 'asks for your approval; nothing changes until you approve it', { class: 'primary', onclick: () => void propose() })),
      preview) : el('p', { class: 'muted' }, 'This approval queue changes its policy by configuration and a restart only.'),
    changes ? history(changes) : null)
  fill()
}
