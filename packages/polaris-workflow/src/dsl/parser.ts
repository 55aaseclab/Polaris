import type {
  DomainAst,
  EntityAst,
  EnumAst,
  FieldAst,
  FlowAst,
  FlowOutputAst,
  ImportAst,
  InputFieldAst,
  ModuleAst,
  ParseError,
  PipelineAst,
  PortAst,
  PortEffect,
  PortRef,
  StepAst,
  StepOutputAst,
} from './ast.js'
import { normalizeVersion, parsePortRef } from './ast.js'

export interface ParseResult {
  ok: boolean
  ast?: DomainAst
  errors: ParseError[]
}

/** Unicode-aware identifier (e.g. ReserveStock, 任务单, 分拣臂) */
const ID = String.raw`[\p{L}_][\p{L}\p{N}_]*`
function re(source: string, flags = ''): RegExp {
  const f = flags.includes('u') ? flags : flags + 'u'
  return new RegExp(source, f)
}


function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

function parseFieldLine(line: string): FieldAst | null {
  const m = line.match(re(`^(${ID})\\s*:\\s*(${ID})(\\?)?(?:\\s*=\\s*(.+))?$`))
  if (!m) return null
  const [, name, type, optional, def] = m
  const field: FieldAst = { name, type, optional: Boolean(optional) }
  if (def !== undefined) {
    const d = def.trim()
    if (d === 'true' || d === 'false') field.defaultValue = d === 'true'
    else if (/^-?\d+(\.\d+)?$/.test(d)) field.defaultValue = Number(d)
    else field.defaultValue = unquote(d)
  }
  return field
}

function parseInputLine(line: string): InputFieldAst | null {
  const m = line.match(re(`^(${ID})\\s*:\\s*(${ID})(.*)$`))
  if (!m) return null
  const [, name, type, rest] = m
  const input: InputFieldAst = { name, type }
  if (/\brequired\b/.test(rest)) input.required = true
  const minM = rest.match(/\bmin\s+(-?\d+(?:\.\d+)?)/)
  if (minM) input.min = Number(minM[1])
  const labelM = rest.match(/\blabel\s+("([^"]*)"|'([^']*)')/)
  if (labelM) input.label = labelM[2] ?? labelM[3]
  const phM = rest.match(/\bplaceholder\s+("([^"]*)"|'([^']*)')/)
  if (phM) input.placeholder = phM[2] ?? phM[3]
  return input
}

function extractBlock(src: string, openIdx: number): { body: string; end: number } | null {
  if (src[openIdx] !== '{') return null
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return { body: src.slice(openIdx + 1, i), end: i + 1 }
    }
  }
  return null
}

function parseEnum(body: string, name: string): EnumAst {
  const values = body
    .split(/[\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/,$/, '').trim())
  return { kind: 'Enum', name, values }
}

function parseEntity(body: string, name: string): EntityAst {
  const fields: FieldAst[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const f = parseFieldLine(line)
    if (f) fields.push(f)
  }
  return { kind: 'Entity', name, fields }
}

function parseFlow(header: string, body: string): FlowAst | ParseError {
  const nameM = header.match(re(`^flow\\s+(${ID})`, "i"))
  if (!nameM) return { message: `Invalid flow header: ${header}` }
  const name = nameM[1]
  const titleM = header.match(/\btitle\s+("([^"]*)"|'([^']*)')/)
  const title = titleM ? (titleM[2] ?? titleM[3]) : name
  const onM = header.match(re(`\\bon\\s+(${ID})`, "i"))
  const on = onM?.[1]

  let description: string | undefined
  let create = /\bcreate\b/i.test(header)
  const inputs: InputFieldAst[] = []
  const outputs: FlowOutputAst[] = []
  const needs: PortRef[] = []
  let requireExpr: string | undefined
  const steps: StepAst[] = []
  let transition: FlowAst['transition']
  let emit: string | undefined
  const ui: FlowAst['ui'] = { layout: 'form', primary: '提交' }

  let i = 0
  const text = body
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break

    const slice = text.slice(i)

    if (/^create\b/i.test(slice)) {
      create = true
      i += slice.match(/^create\b/i)![0].length
      continue
    }

    const descM = slice.match(/^description\s+("([^"]*)"|'([^']*)')/)
    if (descM) {
      description = descM[2] ?? descM[3]
      i += descM[0].length
      continue
    }

    const blockStart = slice.match(/^(input|output|require|steps|ui|transition|emit|needs)\b/i)
    if (!blockStart) {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl + 1
      continue
    }

    const kind = blockStart[1].toLowerCase()
    i += blockStart[0].length
    while (i < text.length && /\s/.test(text[i])) i++

    if (kind === 'emit') {
      const em = text.slice(i).match(re(`^(${ID})`))
      if (em) {
        emit = em[1]
        i += em[0].length
      }
      continue
    }

    if (kind === 'transition') {
      if (text[i] === '{') {
        const blk = extractBlock(text, i)
        if (!blk) return { message: `Unclosed transition in flow ${name}` }
        const tm = blk.body.match(re(`(${ID})\\s*->\\s*(${ID})`))
        if (tm) transition = { field: tm[1], to: tm[2] }
        i = blk.end
      } else {
        const tm = text.slice(i).match(re(`(${ID})\\s*->\\s*(${ID})`))
        if (tm) {
          transition = { field: tm[1], to: tm[2] }
          i += tm[0].length
        }
      }
      continue
    }

    if (text[i] !== '{') return { message: `Expected '{' after ${kind} in flow ${name}` }
    const blk = extractBlock(text, i)
    if (!blk) return { message: `Unclosed ${kind} block in flow ${name}` }

    if (kind === 'input') {
      for (const raw of blk.body.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        const inp = parseInputLine(line)
        if (inp) inputs.push(inp)
      }
    } else if (kind === 'output') {
      outputs.push(...parseFlowOutputs(blk.body))
    } else if (kind === 'needs') {
      needs.push(...parseUsesList(blk.body).map(parsePortRef))
    } else if (kind === 'require') {
      requireExpr = blk.body.trim().replace(/\s+/g, ' ')
    } else if (kind === 'steps') {
      const parsedSteps = parseStepsBlock(blk.body)
      if (typeof parsedSteps === 'string') return { message: parsedSteps }
      steps.push(...parsedSteps)
    } else if (kind === 'ui') {
      const layoutM = blk.body.match(/\blayout\s+(form|wizard)/i)
      if (layoutM) ui.layout = layoutM[1].toLowerCase() as 'form' | 'wizard'
      const primaryM = blk.body.match(/\bprimary\s+("([^"]*)"|'([^']*)')/)
      if (primaryM) ui.primary = primaryM[2] ?? primaryM[3]
      const iconM = blk.body.match(/\bicon\s+("([^"]*)"|'([^']*)')/)
      if (iconM) ui.icon = iconM[2] ?? iconM[3]
    }

    i = blk.end
  }

  return {
    kind: 'Flow',
    name,
    title,
    description,
    on,
    create,
    needs,
    inputs,
    outputs,
    require: requireExpr ? { expr: requireExpr } : undefined,
    steps,
    transition,
    emit,
    ui,
  }
}

function parsePort(header: string, body: string): PortAst | ParseError {
  const nm = header.match(re(`^port\\s+(${ID})`, 'i'))
  if (!nm) return { message: `Invalid port header: ${header}` }
  const name = nm[1]
  const verM = header.match(/\bversion\s+("([^"]*)"|'([^']*)'|([\d.^]+))/i)
  const version = normalizeVersion(verM ? (verM[2] ?? verM[3] ?? verM[4] ?? '1.0.0') : '1.0.0')
  let inFields: FieldAst[] = []
  let outFields: FieldAst[] = []
  let effect: PortEffect = 'ffi'

  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break
    const slice = body.slice(i)

    const effM = slice.match(/^effect\s+(pure|read|write|ffi|human|time)\b/i)
    if (effM) {
      effect = effM[1].toLowerCase() as PortEffect
      i += effM[0].length
      continue
    }

    const km = slice.match(/^(in|out)\b/i)
    if (!km) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    i += km[0].length
    while (i < body.length && /\s/.test(body[i])) i++
    if (body[i] !== '{') return { message: `Expected '{' after ${km[1]} in port ${name}` }
    const blk = extractBlock(body, i)
    if (!blk) return { message: `Unclosed ${km[1]} in port ${name}` }
    const fields: FieldAst[] = []
    for (const raw of blk.body.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const f = parseFieldLine(line)
      if (f) fields.push(f)
    }
    if (km[1].toLowerCase() === 'in') inFields = fields
    else outFields = fields
    i = blk.end
  }

  return { kind: 'Port', name, version, inFields, outFields, effect }
}

/** call Foo | call Foo@1.2.0 | call Inv.Foo@2 */
function parseCallRef(text: string): PortRef | null {
  const m = text.match(re(`^call\\s+(${ID}(?:\\.${ID})?)(?:@([\\d.]+))?`, 'i'))
  if (!m) return null
  const name = m[1]
  const version = m[2] ? normalizeVersion(m[2]) : undefined
  const raw = version ? `${name}@${version}` : name
  return { raw, name, version }
}

function parseImports(cleaned: string): ImportAst[] {
  const imports: ImportAst[] = []
  const reImport = re(
    `^\\s*import\\s+(${ID})\\s+version\\s+("([^"]*)"|'([^']*)'|([^\\s]+))(?:\\s+as\\s+(${ID}))?\\s*$`,
    'gim',
  )
  let m: RegExpExecArray | null
  while ((m = reImport.exec(cleaned)) !== null) {
    imports.push({
      kind: 'Import',
      domain: m[1],
      version: (m[3] ?? m[4] ?? m[5] ?? '1.0.0').trim(),
      as: m[6],
    })
  }
  return imports
}

/** pipeline Name title "..." { FlowA -> FlowB -> FlowC } — 仅行首，避免吃到 description 字符串 */
function parsePipelines(cleaned: string, errors: ParseError[]): PipelineAst[] {
  const list: PipelineAst[] = []
  const rePipe = re(`^[ \\t]*pipeline\\s+(${ID})`, 'gim')
  let m: RegExpExecArray | null
  while ((m = rePipe.exec(cleaned)) !== null) {
    const start = m.index
    const fromHeader = cleaned.slice(start)
    const brace = fromHeader.indexOf('{')
    if (brace < 0) {
      errors.push({ message: `pipeline ${m[1]} missing body` })
      continue
    }
    const abs = start + brace
    const blk = extractBlock(cleaned, abs)
    if (!blk) {
      errors.push({ message: `Unclosed pipeline ${m[1]}` })
      continue
    }
    const header = cleaned.slice(start, abs).trim()
    const titleM = header.match(/\btitle\s+("([^"]*)"|'([^']*)')/)
    const title = titleM ? (titleM[2] ?? titleM[3]) : undefined
    // FlowA -> FlowB -> FlowC  or comma / newline
    const steps = blk.body
      .split(/->|[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const idm = s.match(re(`^(${ID})`))
        return idm ? idm[1] : s
      })
      .filter(Boolean)
    list.push({ kind: 'Pipeline', name: m[1], title, steps })
  }
  return list
}

/** flow.output { name : Type [from step.out | name] [label "..."] } */
function parseFlowOutputs(body: string): FlowOutputAst[] {
  const list: FlowOutputAst[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(
      re(`^(${ID})\\s*:\\s*(${ID})(?:\\s+from\\s+(${ID}(?:\\.${ID})?))?(?:\\s+label\\s+("([^"]*)"|'([^']*)'))?`),
    )
    if (!m) continue
    list.push({
      name: m[1],
      type: m[2],
      from: m[3],
      label: m[5] ?? m[6],
    })
  }
  return list
}

function parseUsesList(body: string): string[] {
  return body
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/,$/, ''))
}

function parseStepOutputs(body: string): StepOutputAst[] {
  const list: StepOutputAst[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(
      re(`^(${ID})\\s*:\\s*(${ID})(?:\\s+label\\s+("([^"]*)"|'([^']*)'))?`),
    )
    if (!m) continue
    list.push({ name: m[1], type: m[2], label: m[4] ?? m[5] })
  }
  return list
}

/**
 * steps {
 *   id "label" { uses { a, b }  output { x: Type } }
 *   id "label"                           // 兼容旧写法
 *   id "label" uses a, b -> x: Type      // 单行紧凑
 * }
 */
function parseStepsBlock(body: string): StepAst[] | string {
  const steps: StepAst[] = []
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break

    const head = body.slice(i).match(re(`^(${ID})(?:\\s+(\"([^\"]*)\"|'([^']*)'))?`))
    if (!head) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    const id = head[1]
    const label = head[3] ?? head[4] ?? id
    i += head[0].length
    while (i < body.length && /[ \t]/.test(body[i])) i++

    let uses: string[] = []
    let outputs: StepOutputAst[] = []
    let call: PortRef | undefined

    // 块形式
    if (body[i] === '{') {
      const blk = extractBlock(body, i)
      if (!blk) return `Unclosed step body for ${id}`
      let j = 0
      const sb = blk.body
      while (j < sb.length) {
        while (j < sb.length && /\s/.test(sb[j])) j++
        if (j >= sb.length) break
        const part = sb.slice(j)

        const callRef = parseCallRef(part)
        if (callRef) {
          call = callRef
          const eaten = part.match(re(`^call\\s+(${ID}(?:\\.${ID})?)(?:@[\\d.]+)?`, 'i'))
          j += eaten?.[0].length ?? callRef.raw.length + 5
          continue
        }

        const km = part.match(/^(uses|output|out)\b/i)
        if (!km) {
          const nl = sb.indexOf('\n', j)
          j = nl === -1 ? sb.length : nl + 1
          continue
        }
        const k = km[1].toLowerCase()
        j += km[0].length
        while (j < sb.length && /\s/.test(sb[j])) j++
        if (sb[j] !== '{') return `Expected '{' after ${k} in step ${id}`
        const inner = extractBlock(sb, j)
        if (!inner) return `Unclosed ${k} in step ${id}`
        if (k === 'uses') uses = parseUsesList(inner.body)
        else outputs = parseStepOutputs(inner.body)
        j = inner.end
      }
      i = blk.end
    } else {
      const restLine = body.slice(i).split('\n')[0] ?? ''
      const callRef = parseCallRef(restLine.trim())
      if (callRef) {
        call = callRef
        i += restLine.length
      } else {
        const usesM = restLine.match(/^\s*uses\s+([^-{\n]+?)(?:\s*->\s*(.+))?$/)
        if (usesM) {
          uses = parseUsesList(usesM[1])
          if (usesM[2]) {
            for (const part of usesM[2].split(',')) {
              const om = part.trim().match(re(`^(${ID})\\s*:\\s*(${ID})$`))
              if (om) outputs.push({ name: om[1], type: om[2] })
            }
          }
          i += restLine.length
        } else if (body[i] === '\n') i++
      }
    }

    steps.push({ id, label, uses, outputs, call })
  }
  return steps
}

/** 解析 entity|enum|flow|port|outputs */
function parseMembers(
  src: string,
  errors: ParseError[],
): {
  entities: EntityAst[]
  enums: EnumAst[]
  flows: FlowAst[]
  ports: PortAst[]
  outputs: string[]
} {
  const entities: EntityAst[] = []
  const enums: EnumAst[] = []
  const flows: FlowAst[] = []
  const ports: PortAst[] = []
  const outputs: string[] = []

  const outBlock = src.match(/\boutputs\s*\{([^}]*)\}/i)
  if (outBlock) {
    for (const part of outBlock[1].split(/[\n,]+/)) {
      const t = part.trim()
      if (!t) continue
      outputs.push(unquote(t))
    }
  }

  const memberRe = new RegExp(String.raw`\b(entity|enum|flow|port)\s+${ID}`, "giu")
  const indices: { kind: string; index: number }[] = []
  let match: RegExpExecArray | null
  while ((match = memberRe.exec(src)) !== null) {
    indices.push({ kind: match[1].toLowerCase(), index: match.index })
  }

  for (let n = 0; n < indices.length; n++) {
    const { kind, index } = indices[n]
    const next = indices[n + 1]?.index ?? src.length
    const chunk = src.slice(index, next)
    const brace = chunk.indexOf('{')
    if (brace < 0) {
      errors.push({ message: `Missing body for ${kind}` })
      continue
    }
    const absBrace = index + brace
    const blk = extractBlock(src, absBrace)
    if (!blk) {
      errors.push({ message: `Unclosed body for ${kind}` })
      continue
    }
    const header = src.slice(index, absBrace).trim()

    if (kind === 'enum') {
      const nm = header.match(re(`^enum\\s+(${ID})`, "i"))
      if (!nm) {
        errors.push({ message: `Invalid enum: ${header}` })
        continue
      }
      enums.push(parseEnum(blk.body, nm[1]))
    } else if (kind === 'entity') {
      const nm = header.match(re(`^entity\\s+(${ID})`, "i"))
      if (!nm) {
        errors.push({ message: `Invalid entity: ${header}` })
        continue
      }
      entities.push(parseEntity(blk.body, nm[1]))
    } else if (kind === 'port') {
      const port = parsePort(header, blk.body)
      if ('kind' in port && port.kind === 'Port') ports.push(port)
      else errors.push(port as ParseError)
    } else if (kind === 'flow') {
      const flow = parseFlow(header, blk.body)
      if ('kind' in flow && flow.kind === 'Flow') flows.push(flow)
      else errors.push(flow as ParseError)
    }
  }

  return { entities, enums, flows, ports, outputs }
}

function parseModule(header: string, body: string, errors: ParseError[]): ModuleAst | null {
  const nm = header.match(re(`^module\\s+(${ID})`, "i"))
  if (!nm) {
    errors.push({ message: `Invalid module header: ${header}` })
    return null
  }
  const name = nm[1]
  const titleM = header.match(/\btitle\s+("([^"]*)"|'([^']*)')/)
  const title = titleM ? (titleM[2] ?? titleM[3]) : name
  const codeM = header.match(/\bcode\s+("([^"]*)"|'([^']*)'|(\w+))/)
  const code = codeM ? (codeM[2] ?? codeM[3] ?? codeM[4]) : undefined
  const descM = body.match(/^\s*description\s+("([^"]*)"|'([^']*)')/m)
  const description = descM ? (descM[2] ?? descM[3]) : undefined

  const members = parseMembers(body, errors)
  return {
    kind: 'Module',
    name,
    code,
    title,
    description,
    outputs: members.outputs,
    entities: members.entities.map((e) => ({ ...e, module: name })),
    enums: members.enums.map((e) => ({ ...e, module: name })),
    ports: members.ports.map((p) => ({ ...p, module: name })),
    flows: members.flows.map((f) => ({ ...f, module: name })),
  }
}

export function parse(source: string): ParseResult {
  const errors: ParseError[] = []
  const cleaned = stripComments(source)
  const ast: DomainAst = {
    kind: 'Domain',
    name: 'Untitled',
    version: '0.0.0',
    imports: [],
    enums: [],
    entities: [],
    ports: [],
    flows: [],
    modules: [],
    pipelines: [],
  }

  const domM = cleaned.match(re(`domain\\s+(${ID})(?:\\s+version\\s+(\"([^\"]*)\"|\'([^\']*)\'))?`, 'i'))
  if (!domM) {
    errors.push({ message: 'Missing `domain Name version "x.y"` header' })
    return { ok: false, errors }
  }
  ast.name = domM[1]
  ast.version = normalizeVersion(domM[3] ?? domM[4] ?? '0.0.0')
  ast.imports = parseImports(cleaned)
  ast.pipelines = parsePipelines(cleaned, errors)

  const headEnd = cleaned.search(new RegExp(String.raw`\b(module|entity|enum|flow|port)\s+${ID}`, 'iu'))
  const head = headEnd >= 0 ? cleaned.slice(0, headEnd) : cleaned
  const titleM = head.match(/\btitle\s+("([^"]*)"|'([^']*)')/)
  if (titleM) ast.title = titleM[2] ?? titleM[3]
  const descM = head.match(/\bdescription\s+("([^"]*)"|'([^']*)')/)
  if (descM) ast.description = descM[2] ?? descM[3]

  const moduleRe = new RegExp(String.raw`\bmodule\s+${ID}`, "giu")
  const moduleHits: number[] = []
  let mm: RegExpExecArray | null
  while ((mm = moduleRe.exec(cleaned)) !== null) moduleHits.push(mm.index)

  const moduleRanges: { start: number; end: number }[] = []
  for (const index of moduleHits) {
    const fromHeader = cleaned.slice(index)
    const brace = fromHeader.indexOf('{')
    if (brace < 0) {
      errors.push({ message: 'module missing body' })
      continue
    }
    const abs = index + brace
    const blk = extractBlock(cleaned, abs)
    if (!blk) {
      errors.push({ message: 'Unclosed module body' })
      continue
    }
    const header = cleaned.slice(index, abs).trim()
    const mod = parseModule(header, blk.body, errors)
    if (mod) ast.modules.push(mod)
    moduleRanges.push({ start: index, end: blk.end })
  }

  let masked = cleaned
  for (const r of moduleRanges) {
    masked = masked.slice(0, r.start) + ' '.repeat(r.end - r.start) + masked.slice(r.end)
  }

  const top = parseMembers(masked, errors)
  ast.entities.push(...top.entities)
  ast.enums.push(...top.enums)
  ast.ports.push(...top.ports)
  ast.flows.push(...top.flows)

  // 能力域包可只有 port/entity（供 import），不强制 flow
  const totalFlows = ast.flows.length + ast.modules.reduce((n, m) => n + m.flows.length, 0)
  const totalPorts = ast.ports.length + ast.modules.reduce((n, m) => n + m.ports.length, 0)
  if (totalFlows === 0 && totalPorts === 0 && ast.entities.length === 0) {
    errors.push({ message: 'Domain is empty (no flow / port / entity)' })
  }

  return { ok: errors.length === 0, ast, errors }
}
