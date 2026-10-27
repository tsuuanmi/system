// The page's script: a classic script that takes the token from the address at once (before the modules load, so a page left
// straight after it keeps the token) and loads the page's modules (`boot.ts` and what it imports, each under 600 lines, no
// `any`; the server serves every compiled file of this directory). It has no import or export of its own, so it parses on its own.
const given = new URLSearchParams(location.hash.slice(1)).get('token')
if (given) {
  try { sessionStorage.setItem('system.token', given) } catch {}
  history.replaceState(null, '', location.pathname + location.search)
}
import('./boot.js').catch((error: unknown) => {
  const main = document.getElementById('main')
  if (main) main.textContent = 'The page could not be loaded: ' + (error instanceof Error ? error.message : String(error))
})
