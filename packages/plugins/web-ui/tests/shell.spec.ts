import { describe, expect, it } from 'vitest'
import { renderShell } from '../src/ui/shell.ts'
import { css, stylesheet } from '../src/ui/styles/css.ts'
import { DARK, declare, LIGHT } from '../src/ui/styles/tokens.ts'
import { APP_CSS, PAGE_HTML } from './client-build.ts'

describe('the page shell and the styles are TypeScript', () => {
  it('renders the same shell for the same input, with its script and stylesheet', () => {
    expect(renderShell({ stylesheets: [{ src: '/ui/app.css' }], scripts: [{ src: '/ui/app.js' }] })).toBe(PAGE_HTML)
    expect(PAGE_HTML).toContain('<link rel="stylesheet" href="/ui/app.css">')
    expect(PAGE_HTML).toContain('<script src="/ui/app.js"></script>')
    expect(PAGE_HTML).toContain('<a href="/ui/?view=policy" id="policy-link" aria-label="Autonomy policy"><span class="wide">Autonomy </span>policy</a>')
  })

  it('puts a script\'s integrity hash and CSP nonce on its tag', () => {
    const html = renderShell({ stylesheets: [{ src: '/ui/app.css', nonce: 'n1' }], scripts: [{ src: '/ui/app.js', integrity: 'sha256-abc', nonce: 'n2' }] })
    expect(html).toContain('<link rel="stylesheet" href="/ui/app.css" nonce="n1">')
    expect(html).toContain('<script src="/ui/app.js" integrity="sha256-abc" crossorigin="anonymous" nonce="n2"></script>')
  })

  it('builds the stylesheet from the tokens, once each', () => {
    expect(declare({ a: '1px', b: '2px' })).toBe('--a: 1px; --b: 2px;')
    expect(css`x { ${'y'} }`).toBe('x { y }')
    expect(stylesheet('a', 'b')).toBe('\na\nb\n')
    expect(APP_CSS).toContain(`:root { color-scheme: light dark;\n  /* Colours`)
    expect(APP_CSS).toContain(declare(LIGHT))
    expect(APP_CSS).toContain(`@media (prefers-color-scheme: dark) { :root { ${declare(DARK)} } }`)
    expect(APP_CSS).not.toMatch(/\$\{|undefined/)
  })
})
