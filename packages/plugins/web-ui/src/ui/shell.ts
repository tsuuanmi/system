/** A script or stylesheet of the page: its URL, and optionally its subresource-integrity hash and CSP nonce. */
export interface Asset {
  src: string
  /** `sha256-<base64>` and the like: the `integrity` attribute. */
  integrity?: string
  /** The CSP nonce the response's policy names: the `nonce` attribute. */
  nonce?: string
}

export interface ShellInput {
  stylesheets: readonly Asset[]
  scripts: readonly Asset[]
}

/** The page's navigation: a link's id, its address, and its words (`wide` is dropped on a phone). */
const NAV: ReadonlyArray<{ id: string; href: string; label: string; aria?: string; wide?: string }> = [
  { id: 'home-link', href: '/ui/', label: 'Home' },
  { id: 'board-link', href: '/ui/?view=board', label: 'Board' },
  { id: 'workers-link', href: '/ui/?view=workers', label: 'Workers' },
  { id: 'policy-link', href: '/ui/?view=policy', label: 'policy', aria: 'Autonomy policy', wide: 'Autonomy ' },
  { id: 'help-link', href: '/ui/?view=help', label: 'Help' },
]

const attributes = (asset: Asset): string =>
  `${asset.integrity ? ` integrity="${asset.integrity}" crossorigin="anonymous"` : ''}${asset.nonce ? ` nonce="${asset.nonce}"` : ''}`

const link = (n: (typeof NAV)[number]): string =>
  `<a href="${n.href}" id="${n.id}"${n.aria ? ` aria-label="${n.aria}"` : ''}>${n.wide ? `<span class="wide">${n.wide}</span>` : ''}${n.label}</a>`

/** The page's HTML: a shell the script fills; it carries no data. Same input, same bytes. */
export function renderShell(input: ShellInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1e1f20" media="(prefers-color-scheme: dark)">
<title>system: runs, approvals, reviews, board, Workers, and policy</title>
${input.stylesheets.map((s) => `<link rel="stylesheet" href="${s.src}"${attributes(s)}>`).join('\n')}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><h1><a href="/ui/" id="home">system</a></h1><nav aria-label="Pages">${NAV.map(link).join(' ')}</nav><span id="status" aria-live="off"></span></header>
<div id="stale" class="stale" role="status" hidden></div>
<div id="outcome"></div>
<main id="main" tabindex="-1"></main>
${input.scripts.map((s) => `<script src="${s.src}"${attributes(s)}></script>`).join('\n')}
</body>
</html>
`
}
