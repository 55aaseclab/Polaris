/**
 * 对抗性压测：对照 manifest.expect 判定
 * pass → pipeline+run 必须成功
 * validate_fail → validate 必须失败
 * parse_fail → parse 必须失败
 * runtime_fail → pipeline 过但 run 失败
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../src/dsl/parser.ts'
import { validate } from '../src/dsl/validator.ts'
import { compile } from '../src/dsl/compiler.ts'
import { flattenDomain } from '../src/dsl/ast.ts'
import { DocStore } from '../src/dsl/runtime.ts'
import { DslInterpreter } from '../src/dsl/interpreter.ts'
import { createMockHost } from '../src/dsl/host.ts'

const ROOT = join(process.cwd(), 'generated', 'adversarial-packs')
const REPORT = join(process.cwd(), 'generated', 'reports')

interface Manifest {
  count: number
  cases: { id: string; expect: string; note: string; file: string }[]
}

function runCreate(ast: ReturnType<typeof flattenDomain> extends never ? never : import('../src/dsl/ast.ts').DomainAst) {
  const flat = flattenDomain(ast)
  const host = createMockHost(flat.ports)
  const store = new DocStore()
  const interp = new DslInterpreter(ast, store, host)
  const flow = flat.flows.find((f) => f.create) ?? flat.flows[0]
  if (!flow) return { ok: false, message: 'no flow' }
  const input: Record<string, string | number> = {}
  for (const f of flow.inputs) {
    if (f.type === 'Number' || f.type === 'Money') input[f.name] = Math.max(f.min ?? 1, 1)
    else input[f.name] = `v-${f.name}`
  }
  return interp.interpret(flow.name, input)
}

function main() {
  if (!existsSync(join(ROOT, 'manifest.json'))) {
    console.error('Run generate-adversarial-packs.mts first')
    process.exit(1)
  }
  const man = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as Manifest
  let okN = 0
  let badN = 0
  const surprises: { id: string; expect: string; actual: string; note: string; detail?: string }[] = []

  for (const c of man.cases) {
    const src = readFileSync(join(ROOT, c.file), 'utf8')
    const parsed = parse(src)

    let actual: string
    let detail = ''

    if (!parsed.ok || !parsed.ast) {
      actual = 'parse_fail'
      detail = parsed.errors.map((e) => e.message).join('; ')
    } else {
      const v = validate(parsed.ast)
      if (!v.ok) {
        actual = 'validate_fail'
        detail = v.issues
          .filter((i) => i.level === 'error')
          .map((i) => i.code)
          .join(',')
      } else {
        try {
          compile(parsed.ast)
          const r = runCreate(parsed.ast)
          actual = r.ok ? 'pass' : 'runtime_fail'
          detail = r.ok ? '' : r.message
        } catch (e) {
          actual = 'runtime_fail'
          detail = e instanceof Error ? e.message : String(e)
        }
      }
    }

    const match = actual === c.expect
    if (match) okN++
    else {
      badN++
      surprises.push({ id: c.id, expect: c.expect, actual, note: c.note, detail })
    }
  }

  mkdirSync(REPORT, { recursive: true })
  const report = {
    at: new Date().toISOString(),
    total: man.count,
    matched: okN,
    mismatched: badN,
    surprises,
  }
  writeFileSync(join(REPORT, 'adversarial-report.json'), JSON.stringify(report, null, 2))

  console.log(`adversarial: matched ${okN}/${man.count} mismatched ${badN}`)
  if (surprises.length) {
    console.log('surprises (weaknesses or wrong expects):')
    for (const s of surprises) {
      console.log(`  ${s.id}: expect=${s.expect} actual=${s.actual} — ${s.note}`)
      if (s.detail) console.log(`    ${s.detail}`)
    }
  }
  process.exit(badN > 0 ? 2 : 0)
}

main()
