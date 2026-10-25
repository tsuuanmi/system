/**
 * Writes `scripts/test-durations.json`, the committed table the suite's sequencer orders test files
 * by (docs/engineering/testing.md#test-groups), from a vitest JSON report of a full run:
 *
 *   pnpm test --reporter=json --outputFile=$TMPDIR/vitest-report.json
 *   pnpm gen:test-durations $TMPDIR/vitest-report.json
 *
 * The table holds exactly the report's files, so a removed file leaves it and a new one enters it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { durationsFromReport, type JsonReport } from './test-durations.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const TABLE = fileURLToPath(new URL('./test-durations.json', import.meta.url))

function main(argv: string[]): number {
  const [report] = argv
  if (!report) {
    console.error('usage: gen-test-durations.ts <vitest JSON report> (pnpm test --reporter=json --outputFile=<file>)')
    return 2
  }
  const json = JSON.parse(readFileSync(report, 'utf8')) as Partial<JsonReport>
  if (!Array.isArray(json.testResults) || !json.testResults.length) {
    console.error(`${report} holds no test results: is it a vitest JSON report of a run?`)
    return 1
  }
  const table = durationsFromReport(json as JsonReport, root)
  writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`)
  console.log(`scripts/test-durations.json: ${Object.keys(table).length} file(s)`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)))
