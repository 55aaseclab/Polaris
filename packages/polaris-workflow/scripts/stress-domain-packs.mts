/**
 * 压测：对 generated/domain-packs 下全部域包跑
 *   parse → validate → compile → interpret(create flow) → compile-run
 * 汇总失败，写 reports/stress-report.json
 *
 * Usage: pnpm exec tsx scripts/stress-domain-packs.mts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runPipeline } from '../src/dsl/pipeline.ts'
import { flattenDomain } from '../src/dsl/ast.ts'
import { DocStore } from '../src/dsl/runtime.ts'
import { DslInterpreter } from '../src/dsl/interpreter.ts'
import { createMockHost } from '../src/dsl/host.ts'

const ROOT = join(process.cwd(), 'generated', 'domain-packs')
const REPORT_DIR = join(process.cwd(), 'generated', 'reports')

interface PackResult {
  file: string
  ok: boolean
  phase?: string
  message?: string
  warnings?: number
  flow?: string
  ms: number
}

function sampleInput(flowName: string, fields: { name: string; type: string; inputKind?: string; min?: number }[]) {
  const input: Record<string, string | number> = {}
  for (const f of fields) {
    if (f.name === 'recordId') continue
    if (f.type === 'Number' || f.type === 'Money' || f.inputKind === 'number' || f.inputKind === 'money') {
      input[f.name] = Math.max(f.min ?? 1, 1)
    } else {
      input[f.name] = `v-${f.name}`
    }
  }
  return input
}

async function main() {
  if (!existsSync(ROOT)) {
    console.error('No packs. Run: pnpm exec tsx scripts/generate-domain-packs.mts 1000')
    process.exit(1)
  }

  const files = readdirSync(ROOT)
    .filter((f) => f.endsWith('.ord'))
    .sort()

  console.log(`stress ${files.length} domain packs…`)

  const results: PackResult[] = []
  const errorBuckets = new Map<string, number>()
  let pass = 0
  let fail = 0
  const tAll = Date.now()

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    const t0 = Date.now()
    const source = readFileSync(join(ROOT, file), 'utf8')

    try {
      const pipe = runPipeline(source)
      if (!pipe.ok || !pipe.ast || !pipe.program) {
        const msg =
          pipe.parseErrors.map((e) => e.message).join('; ') ||
          pipe.issues
            .filter((x) => x.level === 'error')
            .map((x) => `${x.code}:${x.message}`)
            .join('; ') ||
          'pipeline failed'
        const phase = pipe.stages.parse === 'fail' ? 'parse' : pipe.stages.validate === 'fail' ? 'validate' : 'compile'
        fail++
        errorBuckets.set(msg.slice(0, 120), (errorBuckets.get(msg.slice(0, 120)) ?? 0) + 1)
        results.push({ file, ok: false, phase, message: msg, ms: Date.now() - t0 })
        continue
      }

      const warnings = pipe.issues.filter((x) => x.level === 'warning').length
      const flat = flattenDomain(pipe.ast)
      const host = createMockHost(flat.ports)
      const store = new DocStore()
      const interp = new DslInterpreter(pipe.ast, store, host)

      // 找第一个 create flow
      const createFlow = flat.flows.find((f) => f.create) ?? flat.flows[0]
      if (!createFlow) {
        fail++
        results.push({ file, ok: false, phase: 'run', message: 'no flows', ms: Date.now() - t0 })
        continue
      }

      const meta = pipe.program.flows.find((h) => h.meta.name === createFlow.name)?.meta
      const input = sampleInput(createFlow.name, meta?.fields ?? [])

      const r1 = interp.interpret(createFlow.name, input)
      if (!r1.ok) {
        fail++
        const msg = `interpret: ${r1.message}`
        errorBuckets.set(msg.slice(0, 120), (errorBuckets.get(msg.slice(0, 120)) ?? 0) + 1)
        results.push({
          file,
          ok: false,
          phase: 'interpret',
          message: msg,
          flow: createFlow.name,
          warnings,
          ms: Date.now() - t0,
        })
        continue
      }

      const store2 = new DocStore()
      const r2 = pipe.program.run(createFlow.name, input, store2, host)
      if (!r2.ok) {
        fail++
        const msg = `compile-run: ${r2.message}`
        errorBuckets.set(msg.slice(0, 120), (errorBuckets.get(msg.slice(0, 120)) ?? 0) + 1)
        results.push({
          file,
          ok: false,
          phase: 'compile-run',
          message: msg,
          flow: createFlow.name,
          warnings,
          ms: Date.now() - t0,
        })
        continue
      }

      pass++
      results.push({
        file,
        ok: true,
        flow: createFlow.name,
        warnings,
        ms: Date.now() - t0,
      })
    } catch (e) {
      fail++
      const msg = e instanceof Error ? e.message : String(e)
      errorBuckets.set(msg.slice(0, 120), (errorBuckets.get(msg.slice(0, 120)) ?? 0) + 1)
      results.push({ file, ok: false, phase: 'exception', message: msg, ms: Date.now() - t0 })
    }

    if ((i + 1) % 100 === 0) {
      console.log(`… ${i + 1}/${files.length} pass=${pass} fail=${fail}`)
    }
  }

  const totalMs = Date.now() - tAll
  const failures = results.filter((r) => !r.ok)
  const topErrors = [...errorBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)

  mkdirSync(REPORT_DIR, { recursive: true })
  const report = {
    at: new Date().toISOString(),
    total: files.length,
    pass,
    fail,
    passRate: files.length ? +(pass / files.length).toFixed(4) : 0,
    totalMs,
    avgMs: files.length ? +(totalMs / files.length).toFixed(2) : 0,
    topErrors: topErrors.map(([message, count]) => ({ count, message })),
    failures: failures.slice(0, 200),
  }
  writeFileSync(join(REPORT_DIR, 'stress-report.json'), JSON.stringify(report, null, 2))
  writeFileSync(
    join(REPORT_DIR, 'stress-summary.md'),
    `# Domain pack stress report

| metric | value |
|--------|------:|
| total  | ${report.total} |
| pass   | ${report.pass} |
| fail   | ${report.fail} |
| pass % | ${(report.passRate * 100).toFixed(2)}% |
| time   | ${report.totalMs} ms |
| avg    | ${report.avgMs} ms/pack |

## Top errors

${topErrors.map(([m, c]) => `- **${c}** × \`${m.replace(/`/g, "'")}\``).join('\n') || '_none_'}

## Sample failures

${failures
  .slice(0, 40)
  .map((f) => `- \`${f.file}\` [${f.phase}] ${f.message}`)
  .join('\n') || '_none_'}
`,
  )

  console.log('\n=== STRESS DONE ===')
  console.log(`pass ${pass}/${files.length} (${(report.passRate * 100).toFixed(2)}%) fail ${fail}`)
  console.log(`time ${totalMs}ms  avg ${report.avgMs}ms/pack`)
  console.log(`report → ${join(REPORT_DIR, 'stress-report.json')}`)
  if (topErrors.length) {
    console.log('top errors:')
    for (const [m, c] of topErrors.slice(0, 10)) console.log(`  ${c}× ${m}`)
  }
  process.exit(fail > 0 ? 2 : 0)
}

main()
