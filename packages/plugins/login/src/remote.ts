/**
 * The remote login desktop (docs/design/browser-runtime.md#interactive-login-manual-and-the-fallback-for-everything,
 * ADR-0017), ported from tsuuanmi/internet `src/browser/remote-login.ts`:
 * - a plain Chrome (no automation attached) on the account's login profile, drawn on a
 *   private, X-authenticated Xvfb;
 * - a VNC server (TigerVNC `x0vncserver`, or `x11vnc`) listening only on an owner-only
 *   unix socket, so no TCP port exists for other local users;
 * - a loopback HTTP server behind a random URL token that serves noVNC and proxies its
 *   WebSocket to that socket, with Save and Cancel. The operator reaches it over `ssh -L`.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { type XvfbHandle, startXvfb } from '@tsuuanmi/system-display-virtual'
import { registerSecretPath } from '@tsuuanmi/system-libs'
import { OWNED_PROFILE_SWITCH, ProviderError } from '@tsuuanmi/system-provider-core'
import { WebSocketServer } from 'ws'

export type RemoteState = 'waiting' | 'saving' | 'complete' | 'failed' | 'ended'

export interface RemoteSessionInfo {
  account: string
  /** Open after the SSH tunnel is up. */
  url: string
  /** Run on the operator's machine. */
  sshCommand: string
  expiresAt: string
  /** Private directory holding the VNC socket (removed when the session ends). */
  socketDir: string
  state: RemoteState
  message: string
}

export interface RemoteOptions {
  account: string
  profileDir: string
  loginUrl: string
  chromePath: string
  vncPath: string
  ttlMs: number
  /** Port for the loopback page (0 picks a free one). */
  port: number
  /** Called after the login Chrome has exited; stores the account. */
  onSave: () => Promise<unknown>
  onEnded: () => void
}

const LOOPBACK = '127.0.0.1'
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])
// The package exports only `./core/rfb.js`; its directory is the package root's `core/`.
const NOVNC_ROOT = dirname(dirname(createRequire(import.meta.url).resolve('@novnc/novnc')))
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

const running = (child: ChildProcess | undefined): child is ChildProcess => child?.pid !== undefined && child.exitCode === null && child.signalCode === null

function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!running(child)) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

async function stop(child: ChildProcess | undefined, graceMs: number): Promise<void> {
  if (!running(child)) return
  child.kill('SIGTERM')
  if (!(await exited(child, graceMs))) {
    child.kill('SIGKILL')
    await exited(child, 2000)
  }
}

/** VNC arguments for a unix-socket-only server on `display`. */
function vncArgs(vncPath: string, display: string, socket: string): string[] {
  if (basename(vncPath) === 'x11vnc') return ['-display', display, '-unixsockonly', socket, '-forever', '-shared', '-nopw', '-quiet']
  return ['-display', display, '-rfbport', '-1', '-rfbunixpath', socket, '-rfbunixmode', '0600', '-SecurityTypes', 'None']
}

export class RemoteLogin {
  private state: RemoteState = 'waiting'
  private message = 'Sign in, then press Save account.'
  private readonly token = randomBytes(32).toString('base64url')
  private xvfb: XvfbHandle | undefined
  private vnc: ChildProcess | undefined
  private chrome: ChildProcess | undefined
  private server: Server | undefined
  private wss: WebSocketServer | undefined
  private timer: NodeJS.Timeout | undefined
  private origin = ''
  readonly socketDir: string
  private readonly unregisterSocketDir: () => void
  private readonly socket: string
  private readonly expiresAt: string

  private constructor(private readonly options: RemoteOptions) {
    this.socketDir = mkdtempSync(join(tmpdir(), 'system-remote-login-'))
    // The VNC socket shows and drives the login browser: agent Workers never reach it (ADR-0024).
    this.unregisterSocketDir = registerSecretPath(this.socketDir)
    this.socket = join(this.socketDir, 'vnc.sock')
    this.expiresAt = new Date(Date.now() + options.ttlMs).toISOString()
  }

  static async start(options: RemoteOptions): Promise<RemoteLogin> {
    const session = new RemoteLogin(options)
    try {
      await session.launch()
      return session
    } catch (error) {
      await session.end()
      throw error
    }
  }

  info(): RemoteSessionInfo {
    const port = new URL(this.origin).port
    return {
      account: this.options.account, url: `${this.origin}/${this.token}/`,
      sshCommand: `ssh -L ${port}:${LOOPBACK}:${port} <this-host>`, expiresAt: this.expiresAt,
      socketDir: this.socketDir, state: this.state, message: this.message,
    }
  }

  async end(): Promise<void> {
    if (this.state === 'ended') return
    if (this.state !== 'complete' && this.state !== 'failed') this.state = 'ended'
    clearTimeout(this.timer)
    for (const client of this.wss?.clients ?? []) client.terminate()
    this.wss?.close()
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()))
    this.server?.closeAllConnections()
    await stop(this.chrome, 10_000)
    await stop(this.vnc, 2000)
    await this.xvfb?.stop().catch(() => undefined)
    rmSync(this.socketDir, { recursive: true, force: true })
    this.unregisterSocketDir()
    this.state = this.state === 'complete' || this.state === 'failed' ? this.state : 'ended'
    this.options.onEnded()
  }

  private async launch(): Promise<void> {
    this.xvfb = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 5000 })
    const env = { ...process.env, DISPLAY: this.xvfb.display, XAUTHORITY: this.xvfb.authority }
    this.vnc = spawn(this.options.vncPath, vncArgs(this.options.vncPath, this.xvfb.display, this.socket), { env, stdio: 'ignore' })
    const deadline = Date.now() + 5000
    while (!existsSync(this.socket)) {
      if (!running(this.vnc)) throw new ProviderError('config_error', `the VNC server (${this.options.vncPath}) exited before listening; install x0vncserver (tigervnc-scraping-server) or x11vnc`)
      if (Date.now() > deadline) throw new ProviderError('config_error', 'the VNC server did not create its socket in time')
      await new Promise((done) => setTimeout(done, 100))
    }
    // A plain Chrome with no automation attached: the operator signs in exactly as usual.
    this.chrome = spawn(this.options.chromePath, [
      // Marked as started by system, so a crashed host's login browser can be reclaimed (ADR-0030).
      `--user-data-dir=${this.options.profileDir}`, OWNED_PROFILE_SWITCH, '--no-first-run', '--no-default-browser-check', '--restore-last-session',
      '--disable-background-mode', '--window-position=0,0', '--window-size=1920,1080', '--lang=en-US', this.options.loginUrl,
    ], { env, stdio: 'ignore' })
    this.chrome.once('exit', () => {
      if (this.state === 'waiting') this.message = 'Chrome is closed. Press Save account to verify the signed-in profile, or Cancel.'
    })
    this.wss = new WebSocketServer({ noServer: true })
    this.server = createServer((req, res) => void this.handle(req, res))
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.allowedHost(req) || req.url !== `/${this.token}/websockify`) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
        return
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const vnc = connect(this.socket)
        vnc.on('data', (chunk) => ws.send(chunk))
        ws.on('message', (data) => vnc.write(data as Buffer))
        vnc.on('close', () => ws.close())
        vnc.on('error', () => ws.close())
        ws.on('close', () => vnc.destroy())
      })
    })
    // A taken port is a typed failure, never an uncaught 'error' event.
    await new Promise<void>((done, fail) => {
      const onError = (error: Error): void => fail(new ProviderError('config_error', `the remote login page cannot listen on ${LOOPBACK}:${this.options.port}: ${error.message}`, { cause: error }))
      this.server!.once('error', onError)
      this.server!.listen(this.options.port, LOOPBACK, () => {
        this.server!.off('error', onError)
        done()
      })
    })
    this.origin = `http://${LOOPBACK}:${(this.server.address() as { port: number }).port}`
    this.timer = setTimeout(() => void this.end(), this.options.ttlMs)
    this.timer.unref()
  }

  private allowedHost(req: IncomingMessage): boolean {
    return ALLOWED_HOSTS.has((req.headers.host ?? '').split(':')[0] ?? '')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    const base = `/${this.token}/`
    const url = req.url ?? '/'
    if (!this.allowedHost(req) || !url.startsWith(base)) return void res.writeHead(404).end()
    const path = url.slice(base.length)
    if (req.method === 'GET' && path === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
      return
    }
    if (req.method === 'GET' && path === 'status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: this.state, message: this.message }))
      return
    }
    if (req.method === 'GET' && path.startsWith('novnc/')) return this.serveNoVnc(path.slice('novnc/'.length), res)
    if (req.method === 'POST' && (path === 'save' || path === 'cancel')) {
      // Only this page may press the buttons: a POST from any other origin is refused.
      if (req.headers.origin !== this.origin) return void res.writeHead(403).end()
      if (path === 'cancel') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: 'ended' }))
        void this.end()
        return
      }
      const result = await this.save()
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      return
    }
    res.writeHead(404).end()
  }

  private async save(): Promise<{ state: RemoteState; message: string }> {
    if (this.state === 'saving') return { state: this.state, message: this.message }
    this.state = 'saving'
    this.message = 'Closing Chrome and saving the account…'
    try {
      // Chrome must release the profile before it can be reopened and captured.
      await stop(this.chrome, 10_000)
      await this.options.onSave()
      this.state = 'complete'
      this.message = 'Account saved. You can close this page.'
    } catch (error) {
      this.state = 'failed'
      this.message = `Save failed: ${(error as Error).message}`
    }
    setTimeout(() => void this.end(), 1500).unref()
    return { state: this.state, message: this.message }
  }

  private serveNoVnc(relative: string, res: ServerResponse): void {
    const decoded = decodeURIComponent(relative.split('?')[0] ?? '')
    const file = resolve(NOVNC_ROOT, decoded)
    const allowed = [join(NOVNC_ROOT, 'core') + sep, join(NOVNC_ROOT, 'vendor') + sep]
    if (!allowed.some((root) => file.startsWith(root)) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end()
    const real = realpathSync(file)
    if (!allowed.some((root) => real.startsWith(realpathSync(root.slice(0, -1)) + sep))) return void res.writeHead(404).end()
    const type = TYPES[real.slice(real.lastIndexOf('.'))] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type }).end(readFileSync(real))
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>system: remote login</title>
<style>html,body{height:100%;margin:0;background:#111;color:#eee;font:14px system-ui}body{display:grid;grid-template-rows:auto 1fr}
header{display:flex;gap:8px;align-items:center;padding:10px;background:#202124}#status{flex:1}button{padding:8px 14px}#screen{overflow:hidden}</style></head>
<body><header><span id="status">Connecting…</span><button id="save">Save account</button><button id="cancel">Cancel</button></header><main id="screen"></main>
<script type="module">
import RFB from './novnc/core/rfb.js'
const status = document.getElementById('status')
const rfb = new RFB(document.getElementById('screen'), location.href.replace(/^http/, 'ws') + 'websockify')
rfb.scaleViewport = true
rfb.addEventListener('connect', () => { status.textContent = 'Sign in, then press Save account.' })
rfb.addEventListener('disconnect', () => { status.textContent = 'Disconnected.' })
async function post(path) {
  const res = await fetch(path, { method: 'POST' })
  const body = await res.json().catch(() => ({ message: 'HTTP ' + res.status }))
  status.textContent = body.message ?? body.state
}
document.getElementById('save').onclick = () => { status.textContent = 'Saving…'; post('save') }
document.getElementById('cancel').onclick = () => post('cancel')
</script></body></html>`
