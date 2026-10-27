import { BASE } from './base.ts'
import { stylesheet } from './css.ts'
import { PAGES } from './pages.ts'

/** The stylesheet the server serves at `/ui/app.css`. */
export const APP_CSS: string = stylesheet(BASE, PAGES)
