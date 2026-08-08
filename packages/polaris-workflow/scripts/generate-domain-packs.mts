/**
 * 生成 N 个「域包」(domain packs) 用于压测 DSL。
 * 每个包是独立 .ord：domain + entity + ports + flows（可选 module）。
 *
 * Usage: pnpm exec tsx scripts/generate-domain-packs.mts [count=1000]
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const COUNT = Math.max(1, Number(process.argv[2] ?? 1000))
const OUT = join(process.cwd(), 'generated', 'domain-packs')

/** 行业/场景词表 — 只作业务包内容，不进内核 */
const INDUSTRIES = [
  'retail', 'warehouse', 'factory', 'clinic', 'lab', 'hotel', 'fleet', 'farm',
  'energy', 'media', 'edu', 'finance', 'logistics', 'kitchen', 'studio', 'museum',
  'airport', 'port', 'mine', 'pharmacy', 'dental', 'vet', 'gym', 'spa',
  'cinema', 'theater', 'library', 'court', 'city', 'park', 'rail', 'ship',
  'drone', 'robot', 'iot', 'security', 'hr', 'crm', 'support', 'billing',
  'inventory', 'quality', 'safety', 'env', 'water', 'waste', 'power', 'hvac',
  'print', 'pack', 'cnc', 'weld', 'paint', 'inspect', 'assemble', 'test',
  'photo', 'video', 'audio', 'live', 'ads', 'seo', 'social', 'mail',
  'ticket', 'booking', 'pos', 'kiosk', 'vending', 'locker', 'gate', 'access',
  'coldchain', 'fresh', 'bakery', 'brew', 'textile', 'wood', 'metal', 'chem',
  'semicon', 'pcb', 'battery', 'solar', 'wind', 'hydro', 'nuclear', 'space',
  'game', 'esport', 'sports', 'event', 'wedding', 'funeral', 'ngo', 'gov',
]

const VERBS = [
  'Intake', 'Plan', 'Allocate', 'Execute', 'Verify', 'Release', 'Archive',
  'Dispatch', 'Settle', 'Notify', 'Measure', 'Calibrate', 'Sync', 'Approve',
  'Reject', 'Retry', 'Escalate', 'Close', 'Open', 'Transfer', 'Merge', 'Split',
]

const EFFECTS = ['ffi', 'read', 'write', 'ffi', 'ffi'] as const

function slug(i: number): string {
  const ind = INDUSTRIES[i % INDUSTRIES.length]
  const n = Math.floor(i / INDUSTRIES.length) + 1
  return `${ind}_${String(n).padStart(3, '0')}`
}

function domainName(s: string): string {
  return s
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!
}

/** 构造变体：让不同包踩不同语法角落 */
type Variant =
  | 'minimal' // 1 entity 1 port 1 flow
  | 'standard' // 典型
  | 'multi_port' // 多 port 串联 call
  | 'module_wrap' // 包在 module 里
  | 'branchy' // 多 flow 状态机
  | 'wide_io' // 多 input/output 字段
  | 'unicode' // 中文 title/label
  | 'long_chain' // 长 step 链

function variantFor(i: number): Variant {
  const v: Variant[] = [
    'minimal',
    'standard',
    'multi_port',
    'module_wrap',
    'branchy',
    'wide_io',
    'unicode',
    'long_chain',
  ]
  return v[i % v.length]!
}

function genPack(i: number): { id: string; source: string; variant: Variant } {
  const id = slug(i)
  const Dom = domainName(id)
  const v = variantFor(i)
  const verb = pick(VERBS, i)
  const verb2 = pick(VERBS, i + 3)
  const ind = INDUSTRIES[i % INDUSTRIES.length]!

  const statusVals = ['Draft', 'Active', 'Done', 'Failed', `S${(i % 7) + 1}`]
  // 保证至少 2 个可 transition 的
  const stA = statusVals[1]!
  const stB = statusVals[2]!

  // ~12.5% 使用中文标识（锁住 Unicode ID 修复）
  const useZh = i % 8 === 7
  const entity = useZh ? `任务${verb}` : `${verb}Job`
  const portA = useZh ? `设备${verb}` : `${verb}Device`
  const portB = useZh ? `服务${verb2}` : `${verb2}Service`
  const portC = useZh ? `通知${(i % 9) + 1}` : `Notify${(i % 9) + 1}`

  const effectA = pick(EFFECTS, i)
  const effectB = pick(EFFECTS, i + 1)

  let body = ''

  const enumBlock = `enum JobStatus {
  ${statusVals.join(',\n  ')}
}
`

  const entityBlock = `entity ${entity} {
  id     : ID
  name   : String
  qty    : Number
  amount : Money
  status : JobStatus
  ref    : String?
}
`

  const portBlock = (name: string, effect: string, extraIn = false) => `port ${name} {
  in {
    name : String
    qty  : Number${extraIn ? '\n    tag  : String?' : ''}
  }
  out {
    ticketId : String
    ok       : Boolean
  }
  effect ${effect}
}
`

  const ports =
    v === 'minimal'
      ? portBlock(portA, effectA)
      : v === 'multi_port' || v === 'long_chain'
        ? portBlock(portA, effectA) + '\n' + portBlock(portB, effectB, true) + '\n' + portBlock(portC, 'ffi')
        : portBlock(portA, effectA) + '\n' + portBlock(portB, effectB)

  const titleMain =
    v === 'unicode'
      ? `"${ind}·${verb}自动化"`
      : `"${Dom} ${verb}"`

  const descMain =
    v === 'unicode'
      ? `"域包 ${id}：压测 DSL 的计算与 FFI 边界"`
      : `"domain pack ${id} variant=${v}"`

  // --- flows ---
  function flowCreate(name: string, title: string, withSecondCall: boolean, long: boolean): string {
    const needsList = withSecondCall ? `${portA}, ${portB}` : portA
    const midSteps = long
      ? `
    pure_map "映射" {
      uses { name, qty }
      output { lineKey : String }
    }
    call_a "调用设备" {
      uses { name, qty }
      call ${portA}
      output { ticketId : String }
    }
    pure_check "校验票" {
      uses { ticketId, lineKey }
      output { checked : Boolean }
    }
    call_b "调用服务" {
      uses { name, qty }
      call ${portB}
      output { serviceRef : String }
    }
`
      : withSecondCall
        ? `
    prep "准备" {
      uses { name, qty }
      output { lineKey : String }
    }
    call_a "调用 ${portA}" {
      uses { name, qty }
      call ${portA}
      output { ticketId : String }
    }
    call_b "调用 ${portB}" {
      uses { name, qty }
      call ${portB}
      output { serviceRef : String }
    }
`
        : `
    prep "准备" {
      uses { name, qty }
      output { lineKey : String }
    }
    call_a "调用 ${portA}" {
      uses { name, qty }
      call ${portA}
      output { ticketId : String }
    }
`

    const outs = withSecondCall
      ? `ticketId : String from ticketId
    serviceRef : String from serviceRef
    status : JobStatus from record.status`
      : `ticketId : String from ticketId
    status : JobStatus from record.status`

    const wideInputs =
      v === 'wide_io'
        ? `
    tag1 : String required label "标签1"
    tag2 : String required label "标签2"
    note : String required label "备注"
    score : Number required min 0 label "分"
`
        : ''

    return `flow ${name} title ${title} on ${entity} {
  create
  needs { ${needsList} }
  description ${descMain}
  input {
    name   : String required label "名称"
    qty    : Number required min 1 label "数量"
    amount : Money  required min 0 label "金额"${wideInputs}
  }
  require { true }
  steps {${midSteps}
  }
  output {
    ${outs}
  }
  transition status -> ${stA}
  emit ${name}Done
  ui {
    layout form
    primary "提交"
    icon "plus-circle"
  }
}
`
  }

  function flowFollow(name: string, title: string): string {
    return `flow ${name} title ${title} on ${entity} {
  needs { ${portA} }
  description "follow-up ${id}"
  input {
    recordId : String required label "单据"
    name     : String required label "名称"
    qty      : Number required min 1 label "数量"
  }
  require { status == ${stA} }
  steps {
    finish "收尾" {
      uses { recordId, name, qty }
      call ${portA}
      output { ticketId : String }
    }
  }
  output {
    ticketId : String from ticketId
    status   : JobStatus from record.status
  }
  transition status -> ${stB}
  emit ${name}Done
  ui {
    layout form
    primary "完成"
    icon "workflow"
  }
}
`
  }

  let flows = ''
  if (v === 'minimal') {
    flows = flowCreate(`Run${verb}`, titleMain, false, false)
  } else if (v === 'branchy') {
    flows =
      flowCreate(`Open${verb}`, titleMain, true, false) +
      '\n' +
      flowFollow(`Close${verb}`, v === 'unicode' ? `"收尾·${verb}"` : `"Close ${verb}"`) +
      '\n' +
      flowFollow(`Alt${verb}`, `"Alt ${verb}"`)
    // Alt has same require - ok for stress
  } else if (v === 'long_chain') {
    flows = flowCreate(`Pipeline${verb}`, titleMain, true, true)
  } else if (v === 'multi_port') {
    flows = flowCreate(`Multi${verb}`, titleMain, true, false)
  } else if (v === 'wide_io') {
    flows = flowCreate(`Wide${verb}`, titleMain, false, false)
  } else {
    flows = flowCreate(`Run${verb}`, titleMain, true, false) + '\n' + flowFollow(`Done${verb}`, `"Done ${verb}"`)
  }

  const core = `${enumBlock}
${entityBlock}
${ports}
${flows}`

  if (v === 'module_wrap') {
    body = `domain ${Dom} version "0.1"
title ${titleMain}
description ${descMain}

module Pack${verb} code "${String((i % 99) + 1).padStart(2, '0')}" title ${titleMain} {
  description ${descMain}
  outputs { "result", "ticket", "audit" }

${core.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}
}
`
  } else {
    body = `domain ${Dom} version "0.1"
title ${titleMain}
description ${descMain}

${core}
`
  }

  return { id, source: body, variant: v }
}

// --- main ---
if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })

const manifest: { id: string; file: string; variant: string }[] = []
const t0 = Date.now()

for (let i = 0; i < COUNT; i++) {
  const { id, source, variant } = genPack(i)
  const file = `${id}.ord`
  writeFileSync(join(OUT, file), source, 'utf8')
  manifest.push({ id, file, variant })
  if ((i + 1) % 200 === 0) console.log(`generated ${i + 1}/${COUNT}`)
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ count: COUNT, packs: manifest }, null, 2))
writeFileSync(
  join(OUT, 'README.md'),
  `# Generated domain packs (域包)

- count: **${COUNT}**
- generated: ${new Date().toISOString()}
- purpose: stress-test Business DSL parser / validator / compiler / interpreter + MockHost

Each \`.ord\` is an independent **域包** (domain pack): vocabulary + ports + flows.
Industry words are pack content only — not language keywords.

Run: \`pnpm exec tsx scripts/stress-domain-packs.mts\`
`,
)

console.log(`OK ${COUNT} packs → ${OUT} in ${Date.now() - t0}ms`)
