/**
 * ChatGPT Web provider driver (ADR-0005, ADR-0021), registered on `ctx.providers`.
 * @module @tsuuanmi/system-provider-chatgpt-web
 */
import * as plugin from './plugin.ts'

export { ChatGptWebDriver, type DriverOptions, type DriverTimeouts, shippedMap } from './driver.ts'
export { type Config, apply, inject, name } from './plugin.ts'
export default plugin
