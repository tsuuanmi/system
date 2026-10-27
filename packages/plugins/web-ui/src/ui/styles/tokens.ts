/** The visual system's design tokens (docs/design/web-ui.md#visual-system), written once; every colour, space, type size, and radius of the stylesheet is one of them. */
type ColourName = 'fg' | 'page' | 'bg' | 'sunk' | 'muted' | 'line' | 'edge' | 'accent' | 'on-accent' | 'bad' | 'ok' | 'wait'
type Tokens<K extends string> = { readonly [P in K]: string }

const LIGHT: Tokens<ColourName> = {
  fg: '#1f1f1f', page: '#f8f9fa', bg: '#fff', sunk: '#f0f2f4', muted: '#5f6368', line: '#e3e3e3', edge: '#c4c7c5', accent: '#0b57d0', 'on-accent': '#fff', bad: '#b3261e', ok: '#146c2e', wait: '#7a5900',
}
const DARK: Tokens<ColourName> = {
  fg: '#e3e3e3', page: '#131314', bg: '#1e1f20', sunk: '#282a2c', muted: '#a8abaf', line: '#333537', edge: '#5f6368', accent: '#a8c7fa', 'on-accent': '#062e6f', bad: '#f2b8b5', ok: '#6dd58c', wait: '#f0c75e',
}
/** Space (the 8 px grid), type (three sizes), radii, and the measures of the layout. */
const SIZES: Tokens<'s1' | 's2' | 's3' | 's4' | 'small' | 'body' | 'large' | 'r1' | 'r2' | 'radius' | 'round' | 'measure' | 'side' | 'main'> = {
  s1: '4px', s2: '8px', s3: '16px', s4: '24px', small: '12px', body: '14px', large: '18px', r1: '4px', r2: '8px', radius: '12px', round: '999px', measure: '75ch', side: '1fr', main: '3fr',
}

/** Custom properties as declarations: `--name: value;`, in order. */
const declare = (tokens: Readonly<Record<string, string>>): string => Object.entries(tokens).map(([name, value]) => `--${name}: ${value};`).join(' ')

/** The size tokens up to the layout measures, then the safe areas (T240): the spacing scale, or the screen's own inset where it is larger. */
const { measure, side, main, ...scale } = SIZES

export const ROOT = `:root { color-scheme: light dark;
  /* Colours: the page, a surface on it, a sunk surface, text, muted text, a hairline, a control's edge, the one accent, and the three status colours. */
  ${declare(LIGHT)}
  /* Space (the 8 px grid), type (three sizes), radii, and the measures of the layout. */
  ${declare(scale)}
  ${declare({ measure, side, main })}
  /* The safe areas (T240): the spacing scale, or the screen's own inset where it is larger (the Dynamic Island, the home indicator). */
  --safe-top: max(var(--s2), env(safe-area-inset-top)); --safe-right: max(var(--s4), env(safe-area-inset-right));
  --safe-bottom: max(var(--s4), env(safe-area-inset-bottom)); --safe-left: max(var(--s4), env(safe-area-inset-left));
  --safe-bar: max(var(--s2), env(safe-area-inset-bottom)); --bar-room: calc(var(--s4) * 4 + env(safe-area-inset-bottom)); }
@media (prefers-color-scheme: dark) { :root { ${declare(DARK)} } }`
