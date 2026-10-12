/**
 * What the client-protocol gateways share (docs/design/gateways.md): the text tool protocol for
 * website models (ADR-0022), threads bound to provider conversations, and the request guard.
 * Each gateway owns only its wire format.
 * @module @tsuuanmi/system-gateway-turns
 */
export * from './guard.ts'
export * from './protocol.ts'
export * from './threads.ts'
