/**
 * Passive network observation (docs/design/ui-operations.md#network-observation): the
 * engine watches what the page itself requests and never sends requests of its own.
 */
import type { Page, Request, Response } from 'patchright-core'
import type { NetworkPattern } from './map.ts'

interface Compiled {
  id: string
  pattern: NetworkPattern
  url: RegExp
}

export class NetworkObserver {
  private readonly compiled: Compiled[]
  private readonly counts = new Map<string, number>()
  /** Streaming responses whose body has not finished, per signal id. */
  private readonly open = new Map<string, Set<Request>>()
  private readonly detach: () => void

  constructor(page: Page, patterns: Record<string, NetworkPattern>) {
    this.compiled = Object.entries(patterns).map(([id, pattern]) => ({ id, pattern, url: new RegExp(pattern.url) }))
    const onRequest = (request: Request): void => {
      for (const c of this.compiled) {
        if (c.pattern.status === undefined && c.pattern.contentType === undefined && !c.pattern.header && !c.pattern.open && this.requestMatches(c, request)) this.bump(c.id)
      }
    }
    const onResponse = (response: Response): void => {
      for (const c of this.compiled) {
        if (!this.responseMatches(c, response)) continue
        if (c.pattern.open) this.openSet(c.id).add(response.request())
        else if (c.pattern.status !== undefined || c.pattern.contentType !== undefined || c.pattern.header) this.bump(c.id)
      }
    }
    const onDone = (request: Request): void => {
      for (const set of this.open.values()) set.delete(request)
    }
    page.on('request', onRequest)
    page.on('response', onResponse)
    page.on('requestfinished', onDone)
    page.on('requestfailed', onDone)
    this.detach = () => {
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfinished', onDone)
      page.off('requestfailed', onDone)
    }
  }

  /** How many matching events were seen; for `open` patterns, whether one is still open (0/1). */
  seen(id: string): number {
    const pattern = this.compiled.find((c) => c.id === id)?.pattern
    if (pattern?.open) return this.open.get(id)?.size ? 1 : 0
    return this.counts.get(id) ?? 0
  }

  dispose(): void {
    this.detach()
  }

  private bump(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1)
  }

  private openSet(id: string): Set<Request> {
    let set = this.open.get(id)
    if (!set) this.open.set(id, (set = new Set()))
    return set
  }

  private requestMatches(c: Compiled, request: Request): boolean {
    if (c.pattern.method && request.method() !== c.pattern.method) return false
    return c.url.test(new URL(request.url()).pathname) || c.url.test(request.url())
  }

  private responseMatches(c: Compiled, response: Response): boolean {
    if (!this.requestMatches(c, response.request())) return false
    if (c.pattern.status !== undefined && response.status() !== c.pattern.status) return false
    const headers = response.headers()
    if (c.pattern.contentType && !(headers['content-type'] ?? '').includes(c.pattern.contentType)) return false
    if (c.pattern.header) {
      const value = headers[c.pattern.header.name.toLowerCase()]
      if (value === undefined || (c.pattern.header.equals !== undefined && value !== c.pattern.header.equals)) return false
    }
    return true
  }
}
