// A project's weekly report and its maturity metrics (T253, T256): a small page of their own, linked from the project's group on
// Home and from its board, with the commands that print them, each behind its copy button.
import type { ProjectsResponse } from '../src/api.js'
import { copyId, el, table } from './dom.js'
import { pageHead } from './glossary.js'
import { anchor, filterHome } from './router.js'
import { api, show } from './state.js'

const REPORTS = [
  ['Weekly report', 'The week of the project, from its records', 'system report --project '],
  ['Maturity metrics', 'How far it runs by itself, from its records', 'system metrics --project '],
] as const

export async function reportsView(): Promise<void> {
  const projectId = new URLSearchParams(location.search).get('project') || ''
  let title = projectId
  try { title = (await api<ProjectsResponse>('projects')).projects.find((x) => x.projectId === projectId)?.title ?? projectId } catch {}
  show(pageHead('reports', 'Reports · ' + title),
    table(['Report', 'What it says', 'Command'], REPORTS.map(([what, says, command]) => el('tr', {}, el('td', {}, el('strong', {}, what)), el('td', {}, says),
      el('td', {}, el('code', {}, command + projectId), copyId('Copy command', command + projectId)))), 'reports'),
    el('p', {}, anchor('/ui/?project=' + encodeURIComponent(projectId), title + ' on Home', () => filterHome(projectId))))
}
