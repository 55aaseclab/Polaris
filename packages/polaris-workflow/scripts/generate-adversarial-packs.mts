/**
 * 对抗性域包：故意踩边角 / 非法结构
 * - expect: pass | validate_fail | parse_fail | runtime_fail
 *
 * Usage: pnpm exec tsx scripts/generate-adversarial-packs.mts
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'generated', 'adversarial-packs')

type Expect = 'pass' | 'parse_fail' | 'validate_fail' | 'runtime_fail'

interface Case {
  id: string
  expect: Expect
  note: string
  source: string
}

const cases: Case[] = []

function add(id: string, expect: Expect, note: string, source: string) {
  cases.push({ id, expect, note, source: source.trim() + '\n' })
}

// ── Should PASS (edge) ──────────────────────────────────────

add(
  'pass_unicode_heavy',
  'pass',
  '中文 title/label/description 全开',
  `
domain UnicodeHeavy version "0.1"
title "仓储·自动分拣"
description "中文域包压测：标签与说明含标点、书名号《》"

enum JobStatus { Draft, Active, Done }

entity 任务单 {
  id : ID
  name : String
  qty : Number
  status : JobStatus
}

port 分拣臂 {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}

flow 执行分拣 title "执行分拣" on 任务单 {
  create
  needs { 分拣臂 }
  input {
    name : String required label "货品名称"
    qty : Number required min 1 label "件数"
  }
  require { true }
  steps {
    go "调用分拣臂" {
      uses { name, qty }
      call 分拣臂
      output { ticketId : String label "票号" }
    }
  }
  output {
    ticketId : String from ticketId
    status : JobStatus from record.status
  }
  transition status -> Active
  emit Sorted
  ui { layout form primary "开始" icon "plus-circle" }
}
`,
)

add(
  'pass_many_steps',
  'pass',
  '30 步纯计算链 + 1 次 FFI',
  `
domain ManySteps version "0.1"
title "LongChain"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
${Array.from({ length: 30 }, (_, i) => {
  const prev = i === 0 ? 'name' : `k${i - 1}`
  return `    s${i} "step${i}" {
      uses { ${prev}, qty }
      output { k${i} : String }
    }`
}).join('\n')}
    fin "ffi" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output {
    ticketId : String from ticketId
    status : JobStatus from record.status
  }
  transition status -> Active
  emit Done
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'pass_many_ports',
  'pass',
  '20 个 port，flow 只 call 其中 2 个',
  `
domain ManyPorts version "0.1"
title "ManyPorts"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
${Array.from({ length: 20 }, (_, i) => `port P${i} {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}`).join('\n')}
flow Run title "Run" on Job {
  create
  needs { P0, P19 }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    a "a" {
      uses { name, qty }
      call P0
      output { ticketId : String }
    }
    b "b" {
      uses { name, qty }
      call P19
      output { otherId : String }
    }
  }
  output {
    ticketId : String from ticketId
    status : JobStatus from record.status
  }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'pass_optional_port_in',
  'pass',
  'port.in 可选字段可不出现在 uses',
  `
domain OptIn version "0.1"
title "OptIn"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in {
    name : String
    qty : Number
    hint : String?
  }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    c "c" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output {
    ticketId : String from ticketId
    status : JobStatus from record.status
  }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'pass_module_only',
  'pass',
  '全部构造在 module 内，顶层无 entity',
  `
domain ModOnly version "0.1"
title "ModOnly"
module Core code "01" title "Core" {
  outputs { "a" }
  enum JobStatus { Draft, Active, Done }
  entity Job { id : ID, name : String, qty : Number, status : JobStatus }
  port Dev {
    in { name : String, qty : Number }
    out { ticketId : String }
    effect ffi
  }
  flow Run title "Run" on Job {
    create
    needs { Dev }
    input {
      name : String required
      qty : Number required min 1
    }
    require { true }
    steps {
      c "c" {
        uses { name, qty }
        call Dev
        output { ticketId : String }
      }
    }
    output {
      ticketId : String from ticketId
      status : JobStatus from record.status
    }
    transition status -> Active
    emit X
    ui { layout form primary "Go" icon "plus-circle" }
  }
}
`,
)

add(
  'pass_record_ambient',
  'pass',
  '非 create flow uses 单据字段 rawRef（环境读取）',
  `
domain Ambient version "0.1"
title "Ambient"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus, rawRef : String? }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
port Enrich {
  in { rawRef : String, name : String }
  out { richId : String }
  effect ffi
}
flow Open title "Open" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    c "c" {
      uses { name, qty }
      call Dev
      output { rawRef : String }
    }
  }
  output {
    rawRef : String from rawRef
    status : JobStatus from record.status
  }
  transition status -> Active
  emit Opened
  ui { layout form primary "Open" icon "plus-circle" }
}
flow EnrichFlow title "Enrich" on Job {
  needs { Enrich }
  input {
    recordId : String required
    name : String required
  }
  require { status == Active }
  steps {
    e "e" {
      uses { rawRef, name }
      call Enrich
      output { richId : String }
    }
  }
  output {
    richId : String from richId
    status : JobStatus from record.status
  }
  transition status -> Done
  emit Enriched
  ui { layout form primary "Enrich" icon "workflow" }
}
`,
)

// ── Should VALIDATE FAIL ────────────────────────────────────

add(
  'fail_unknown_call',
  'validate_fail',
  'call 不存在的 port',
  `
domain BadCall version "0.1"
title "BadCall"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    c "c" {
      uses { name, qty }
      call NotExist
      output { ticketId : String }
    }
  }
  output { ticketId : String from ticketId }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'fail_bad_uses_order',
  'validate_fail',
  'uses 引用尚未产出的上游 out',
  `
domain BadUses version "0.1"
title "BadUses"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    early "early" {
      uses { ghostKey, qty }
      output { a : String }
    }
    later "later" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output { ticketId : String from ticketId }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'fail_unknown_entity',
  'validate_fail',
  'flow on 未知实体',
  `
domain BadOn version "0.1"
title "BadOn"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on NoSuchEntity {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    c "c" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output { ticketId : String from ticketId }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'fail_bad_flow_output',
  'validate_fail',
  'flow.output from 不存在的名字',
  `
domain BadOut version "0.1"
title "BadOut"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    c "c" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output {
    missing : String from totallyMissing
  }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'fail_dup_port',
  'validate_fail',
  '重复 port 名',
  `
domain DupPort version "0.1"
title "DupPort"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
port Dev {
  in { name : String, qty : Number }
  out { other : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    c "c" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output { ticketId : String from ticketId }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'fail_bad_require',
  'validate_fail',
  '非法 require 表达式',
  `
domain BadReq version "0.1"
title "BadReq"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { qty > 0 && status != Draft }
  steps {
    c "c" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output { ticketId : String from ticketId }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

// ── Should PARSE FAIL ───────────────────────────────────────

add(
  'fail_parse_no_domain',
  'parse_fail',
  '缺少 domain 头',
  `
entity Job { id : ID }
flow Run title "Run" {
  steps { a "a" }
}
`,
)

add(
  'fail_parse_unclosed',
  'parse_fail',
  '未闭合花括号',
  `
domain Unclosed version "0.1"
title "Unclosed"
entity Job {
  id : ID
  name : String
`,
)

// ── Should PASS but currently WEAK (we want to fix) ─────────

add(
  'pass_needs_implies_capability',
  'pass',
  'needs 列出 port，step 未 call 也允许（仅能力预留）',
  `
domain NeedsReserve version "0.1"
title "NeedsReserve"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
port Spare {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev, Spare }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    c "c" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output { ticketId : String from ticketId }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'pass_pure_only_flow',
  'pass',
  '无 port、无 call 的纯计算 flow',
  `
domain PureOnly version "0.1"
title "PureOnly"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
flow Run title "Run" on Job {
  create
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    map "map" {
      uses { name, qty }
      output { lineKey : String }
    }
  }
  output {
    lineKey : String from lineKey
    status : JobStatus from record.status
  }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

add(
  'pass_duplicate_step_output_shadow',
  'pass',
  '下游 out 同名覆盖上游（警告即可，应能跑）',
  `
domain Shadow version "0.1"
title "Shadow"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, status : JobStatus }
port Dev {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}
flow Run title "Run" on Job {
  create
  needs { Dev }
  input {
    name : String required
    qty : Number required min 1
  }
  require { true }
  steps {
    a "a" {
      uses { name, qty }
      output { ticketId : String }
    }
    b "b" {
      uses { name, qty }
      call Dev
      output { ticketId : String }
    }
  }
  output { ticketId : String from ticketId }
  transition status -> Active
  emit X
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
)

// Generate bulk near-duplicates of pass cases mixed with industry names → pad to 100+ adversarial? 
// User wanted 1000 domain packs already; adversarial is for finding bugs.
// Add 50 more auto edge pass variants

for (let i = 0; i < 80; i++) {
  const Dom = `Edge${i}`
  const pure = i % 3 === 0
  add(
    `pass_edge_${String(i).padStart(3, '0')}`,
    'pass',
    `auto edge #${i}`,
    `
domain ${Dom} version "0.1"
title "Edge ${i}"
enum JobStatus { Draft, Active, Done }
entity Job { id : ID, name : String, qty : Number, amount : Money, status : JobStatus }
${
  pure
    ? ''
    : `port Dev${i} {
  in { name : String, qty : Number }
  out { ticketId : String }
  effect ffi
}`
}
flow Run title "Run" on Job {
  create
  ${pure ? '' : `needs { Dev${i} }`}
  input {
    name : String required
    qty : Number required min 1
    amount : Money required min 0
  }
  require { true }
  steps {
    p "prep" {
      uses { name, qty }
      output { key : String }
    }
    ${
      pure
        ? `q "more" {
      uses { key, amount }
      output { line : String }
    }`
        : `c "call" {
      uses { name, qty }
      call Dev${i}
      output { ticketId : String }
    }`
    }
  }
  output {
    ${pure ? 'line : String from line' : 'ticketId : String from ticketId'}
    status : JobStatus from record.status
  }
  transition status -> Active
  emit E${i}
  ui { layout form primary "Go" icon "plus-circle" }
}
`,
  )
}

// Chinese entity names in on clause - pass_unicode already
// Identifier starting with number - should parse_fail
add(
  'fail_parse_bad_ident',
  'parse_fail',
  '非法标识（若 parser 吞掉则暴露弱点）',
  `
domain 9Bad version "0.1"
entity Job { id : ID }
`,
)

// --- write ---
if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })

const manifest = cases.map((c) => {
  writeFileSync(join(OUT, `${c.id}.ord`), c.source)
  return { id: c.id, expect: c.expect, note: c.note, file: `${c.id}.ord` }
})

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ count: cases.length, cases: manifest }, null, 2))
console.log(`adversarial ${cases.length} packs → ${OUT}`)
console.log(
  'expect counts',
  Object.entries(
    manifest.reduce(
      (a, c) => {
        a[c.expect] = (a[c.expect] ?? 0) + 1
        return a
      },
      {} as Record<string, number>,
    ),
  ),
)
