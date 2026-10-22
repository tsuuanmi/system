/**
 * Conformance suite for `ctx.egress` (INV-12; docs/design/routing.md#data-locality-policy;
 * docs/security/threat-model.md). It holds any provider to the documented contract through
 * `ctx.egress` and the decisions it records in `ctx.artifacts`: classification per Worker class,
 * local-private kept on the machine unless the operator widened a class, a credential scan of the
 * actual outgoing payload, operator deny patterns, a fail-closed default for anything without a
 * policy, and an `egress` decision for every check that never holds the matched secret.
 * `boot` returns a context that provides `ctx.egress` and `ctx.artifacts`, configured with
 * {@link EGRESS_CONFIG}.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../../libs/conformance/runner.ts'
import { type Classification, type Config, type EgressVerdict, WORKER_CLASSES } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/** The default Worker classes, whose defaults the suite checks. */
const DEFAULT_CLASSES = ['website', 'agent', 'model', 'model-local'] as const

/**
 * The configuration every provider under test runs with: the default Worker classes, plus one
 * class an operator widened to admit local-private (`workerClasses` replaces the whole default,
 * so it lists every class), the default classification, the secret scan, and one deny pattern.
 */
export const EGRESS_CONFIG: Config = {
  workerClasses: { ...WORKER_CLASSES, 'local-tool': ['public', 'operator-shared', 'local-private'] },
  defaultClassification: 'operator-shared',
  scanSecrets: true,
  denyPatterns: [{ name: 'internal-hostname', pattern: '\\b[a-z0-9-]+\\.corp\\.example\\b' }],
}

// Credentials made at run time, never committed (scanners ignore documented example keys, and the
// repository's secret scan would refuse a literal one).
const PRIVATE_KEY = String(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
const AWS_KEY = `AKIA${Array.from(randomBytes(16), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('')}`
const AWS_PAIR = `aws_access_key_id = ${AWS_KEY}\naws_secret_access_key = ${randomBytes(30).toString('base64').slice(0, 40)}`
/** One line of each secret's body, which must never reach a verdict or a decision. */
const SECRET_TEXT = [AWS_KEY, PRIVATE_KEY.split('\n')[1]!]

const schemas = new SchemaRegistry()

type EgressDecision = {
  schema: string; decisionType: string
  candidates: Array<{ option: string; selected: boolean; reasons: string[] }>
  decider: { type: string; id: string; version: string }
  outcome: { option: 'allow' | 'deny'; detail?: { workerClass?: string; classification?: string; payloadHash?: string; findings?: Array<{ rule: string; at: number }> } }
}

/** The decision a verdict names: stored, schema-valid, of type `egress`, and agreeing with the verdict (INV-13). */
const decisionOf = (ctx: Context, verdict: EgressVerdict): EgressDecision => {
  const envelope = ctx.artifacts.get(verdict.decision)
  expect(envelope?.kind, `${verdict.decision} is a decision`).toBe('decision')
  const body = envelope!.body as EgressDecision
  schemas.assertRecord(body as unknown as { schema: string })
  expect(body.decisionType).toBe('egress')
  expect(body.outcome.option).toBe(verdict.allowed ? 'allow' : 'deny')
  expect(body.candidates.map((c) => c.option).sort()).toEqual(['allow', 'deny'])
  expect(body.candidates.filter((c) => c.selected).map((c) => c.option)).toEqual([body.outcome.option])
  return body
}

const check = async (ctx: Context, payload: string, workerClass: string, classification?: Classification): Promise<EgressVerdict> => {
  const verdict = await ctx.egress.check({ payload, workerClass, ...(classification ? { classification } : {}) })
  decisionOf(ctx, verdict)
  return verdict
}

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>): Scenario<Boot> => ({
  id: `egress.${id}`, since: '1.0', title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const egressSuite = defineSuite<Boot>({
  seam: 'egress',
  contract: '1.0',
  scenarios: [
    scenario('shared-content-allowed', 'lets public and operator-shared content without a credential leave for every default Worker class (INV-12)', async (ctx) => {
      for (const workerClass of DEFAULT_CLASSES) {
        for (const classification of ['public', 'operator-shared'] as const) {
          const verdict = await check(ctx, 'Summarize the A2A protocol.', workerClass, classification)
          expect(verdict, `${classification} to ${workerClass}`).toMatchObject({ allowed: true, findings: [] })
        }
      }
    }),
    scenario('local-private-stays', 'keeps local-private content on the machine for every default Worker class, model-local included, and lets it go only to a class the operator widened (INV-12)', async (ctx) => {
      for (const workerClass of DEFAULT_CLASSES) {
        const verdict = await check(ctx, 'patient 42: notes', workerClass, 'local-private')
        expect(verdict.allowed, `local-private to ${workerClass}`).toBe(false)
        expect(verdict.reason).toBeTruthy()
      }
      expect((await check(ctx, 'patient 42: notes', 'local-tool', 'local-private')).allowed).toBe(true)
    }),
    scenario('unknown-fails-closed', 'denies content for a Worker class with no egress policy, and content of an unknown classification, whatever the payload (INV-2, INV-12)', async (ctx) => {
      for (const classification of ['public', 'operator-shared', 'local-private'] as const) {
        const verdict = await check(ctx, 'harmless text', 'satellite', classification)
        expect(verdict.allowed, `${classification} to an unknown class`).toBe(false)
        expect(verdict.reason).toBeTruthy()
      }
      for (const workerClass of [...DEFAULT_CLASSES, 'local-tool']) {
        const verdict = await check(ctx, 'harmless text', workerClass, 'secret' as Classification)
        expect(verdict.allowed, `an unknown classification to ${workerClass}`).toBe(false)
      }
    }),
    scenario('default-classification', 'judges content whose caller states no classification as the configured default, and records the classification it used (INV-12, INV-13)', async (ctx) => {
      const verdict = await check(ctx, 'harmless text', 'website')
      expect(verdict.allowed).toBe(true)
      expect(decisionOf(ctx, verdict).outcome.detail).toMatchObject({ workerClass: 'website', classification: 'operator-shared' })
    }),
    scenario('credential-refused', 'refuses a payload that carries a credential, even public content to a permitted class, naming each finding by rule (INV-12)', async (ctx) => {
      for (const secret of [AWS_PAIR, PRIVATE_KEY]) {
        for (const workerClass of [...DEFAULT_CLASSES, 'local-tool']) {
          const verdict = await check(ctx, `please debug this:\n${secret}`, workerClass, 'public')
          expect(verdict.allowed, `a credential to ${workerClass}`).toBe(false)
          expect(verdict.findings.length).toBeGreaterThan(0)
          for (const finding of verdict.findings) expect(finding.rule).toMatch(/\S/)
        }
      }
    }),
    scenario('actual-payload', 'scans the whole actual payload: a credential after a long harmless prefix is found at its offset (INV-12)', async (ctx) => {
      const prefix = `${'Lorem ipsum dolor sit amet. '.repeat(2000)}\n`
      const payload = `${prefix}aws_access_key_id = ${AWS_KEY}\n`
      const verdict = await check(ctx, payload, 'website', 'public')
      expect(verdict.allowed).toBe(false)
      expect(verdict.findings.some((f) => f.at >= prefix.length && f.at <= payload.indexOf(AWS_KEY))).toBe(true)
    }),
    scenario('deny-patterns', 'refuses a payload that matches an operator deny pattern, naming the pattern (INV-12)', async (ctx) => {
      const verdict = await check(ctx, 'ssh to db1.corp.example and run the report', 'website', 'operator-shared')
      expect(verdict.allowed).toBe(false)
      expect(verdict.findings).toEqual([expect.objectContaining({ rule: 'internal-hostname', at: 'ssh to '.length })])
      expect((await check(ctx, 'ssh to db1.example.org', 'website', 'operator-shared')).allowed).toBe(true)
    }),
    scenario('secret-never-recorded', 'records findings as rule ids and offsets plus a payload hash, never the matched text, in the verdict or the decision (INV-12, INV-13)', async (ctx) => {
      for (const secret of [AWS_PAIR, PRIVATE_KEY]) {
        const payload = `config:\n${secret}`
        const verdict = await check(ctx, payload, 'website', 'operator-shared')
        const decision = decisionOf(ctx, verdict)
        expect(decision.outcome.detail?.payloadHash).toBe(sha256(payload))
        expect(decision.outcome.detail?.findings).toEqual(verdict.findings)
        const recorded = `${JSON.stringify(verdict)}\n${JSON.stringify(ctx.artifacts.get(verdict.decision))}`
        for (const text of SECRET_TEXT) expect(recorded).not.toContain(text)
      }
    }),
    scenario('every-check-decided', 'records every check, allowed or denied, as one new schema-valid egress decision whose selected candidate is the verdict (INV-13)', async (ctx) => {
      const before = ctx.artifacts.list({ kind: 'decision', decisionType: 'egress' }).length
      const verdicts = [
        await ctx.egress.check({ payload: 'one', classification: 'public', workerClass: 'website' }),
        await ctx.egress.check({ payload: 'two', classification: 'local-private', workerClass: 'model' }),
        await ctx.egress.check({ payload: 'three', classification: 'public', workerClass: 'satellite' }),
      ]
      expect(verdicts.map((v) => v.allowed)).toEqual([true, false, false])
      expect(new Set(verdicts.map((v) => v.decision)).size).toBe(3)
      for (const verdict of verdicts) {
        const decision = decisionOf(ctx, verdict)
        const selected = decision.candidates.find((c) => c.selected)!
        expect(selected.reasons.length).toBeGreaterThan(0)
        expect(decision.decider.id).toBeTruthy()
      }
      expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'egress' }).length).toBe(before + 3)
    }),
  ],
})
