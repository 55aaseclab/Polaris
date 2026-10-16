import type {
  ChoicePredicate,
  DomainAst,
  DomainAccent,
  EntityAst,
  EnumAst,
  FieldAst,
  FlowAst,
  FlowBodyItem,
  FlowOutputAst,
  ImportAst,
  InputFieldAst,
  ModuleAst,
  ParseError,
  ParallelAst,
  ParallelBranchAst,
  ChoiceAst,
  ChoiceBranchAst,
  ForEachAst,
  WhileAst,
  SubflowAst,
  PipelineAst,
  PortAst,
  PortEffect,
  PortRef,
  StepAst,
  StepOutputAst,
} from './ast.js'
import {
  DEFAULT_DSL_LANGUAGE_VERSION,
  normalizeVersion,
  parsePortRef,
} from './ast.js'

export interface ParseResult {
  ok: boolean
  ast?: DomainAst
  errors: ParseError[]
}

/** Unicode-aware identifier (e.g. ReserveStock, 任务单, 分拣臂) */
const ID = String.raw`[\p{L}_][\p{L}\p{N}_-]*`
const PORT_ID = String.raw`${ID}(?:\.${ID})*`
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

function splitEntries(source: string): string[] {
  const entries: string[] = []
  let start = 0
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (char === quote && source[i - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ',' || char === '\n' || char === '\r') {
      const entry = source.slice(start, i).trim()
      if (entry) entries.push(entry)
      start = i + 1
    }
  }
  const last = source.slice(start).trim()
  if (last) entries.push(last)
  return entries
}

function parseFieldLine(line: string): FieldAst | null {
  const typeExpr = `${ID}(?:<${ID}(?:<${ID}>)?>)?`
  const m = line.match(re(`^(${ID})\\s*:\\s*(${typeExpr})(\\?)?(?:\\s*=\\s*(.+))?$`))
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
  const typeExpr = `${ID}(?:<${ID}(?:<${ID}>)?>)?`
  const m = line.match(re(`^(${ID})\\s*:\\s*(${typeExpr})(.*)$`))
  if (!m) return null
  const [, name, type, rest] = m
  const input: InputFieldAst = { name, type }
  if (/\brequired\b/.test(rest)) input.required = true
  const minM = rest.match(/\bmin\s+(-?\d+(?:\.\d+)?)/)
  if (minM) input.min = Number(minM[1])
  const controlM = rest.match(/\bcontrol\s+(text|textarea)\b/i)
  if (controlM) input.inputKind = controlM[1].toLowerCase() as 'text' | 'textarea'
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
  for (const raw of splitEntries(body)) {
    const f = parseFieldLine(raw)
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
  const bodyItems: FlowBodyItem[] = []
  const constructCounters = newConstructCounters()
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
      for (const raw of splitEntries(blk.body)) {
        const inp = parseInputLine(raw)
        if (inp) inputs.push(inp)
      }
    } else if (kind === 'output') {
      outputs.push(...parseFlowOutputs(blk.body))
    } else if (kind === 'needs') {
      needs.push(...parseUsesList(blk.body).map(parsePortRef))
    } else if (kind === 'require') {
      requireExpr = blk.body.trim().replace(/\s+/g, ' ')
    } else if (kind === 'steps') {
      const parsedBody = parseFlowBody(blk.body, constructCounters)
      if (typeof parsedBody === 'string') return { message: parsedBody }
      bodyItems.push(...parsedBody)
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

  // v1 linear view: the plain steps of body (v2 constructs are not listed)
  const steps = bodyItems
    .filter((item): item is { kind: 'Step'; step: StepAst } => item.kind === 'Step')
    .map((item) => item.step)

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
    body: bodyItems,
    transition,
    emit,
    ui,
  }
}

function parsePort(header: string, body: string): PortAst | ParseError {
  const nm = header.match(re(`^port\\s+(${PORT_ID})`, 'i'))
  if (!nm) return { message: `Invalid port header: ${header}` }
  const name = nm[1]
  const verM = header.match(/\bversion\s+("([^"]*)"|'([^']*)'|([\d.^]+))/i)
  const version = normalizeVersion(verM ? (verM[2] ?? verM[3] ?? verM[4] ?? '1.0.0') : '1.0.0')
  let inFields: FieldAst[] = []
  let outFields: FieldAst[] = []
  let effect: PortEffect = 'ffi'
  let builtin: string | undefined
  let binding: PortAst['binding']

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

    const builtinM = slice.match(new RegExp(`^builtin\\s+(${ID}(?:\\.${ID})?)\\b`, 'iu'))
    if (builtinM) {
      builtin = builtinM[1]
      i += builtinM[0].length
      continue
    }

    const bindingM = slice.match(/^binding\s*\{([\s\S]*?)\}/i)
    if (bindingM) {
      const bindingBody = bindingM[1] ?? ''
      const toolM = bindingBody.match(
        /\btool\s+("([^"]*)"|'([^']*)'|([^\s}]+))/i,
      )
      const commandM = bindingBody.match(
        /\bcommand\s+("([^"]*)"|'([^']*)'|([^\s}]+))/i,
      )
      const tool = toolM?.[2] ?? toolM?.[3] ?? toolM?.[4] ?? ''
      const command = commandM?.[2] ?? commandM?.[3] ?? commandM?.[4] ?? ''
      const aliases: Record<string, string> = {}
      const aliasRe = /alias\s+([A-Za-z_][\w]*)\s+as\s+([A-Za-z_][\w]*)/g
      let alias: RegExpExecArray | null
      while ((alias = aliasRe.exec(bindingBody)) !== null) {
        aliases[alias[1]] = alias[2]
      }
      if (tool) {
        binding = {
          tool,
          ...(command ? { command } : {}),
          ...(Object.keys(aliases).length ? { aliases } : {}),
        }
      }
      i += bindingM[0].length
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
    for (const raw of splitEntries(blk.body)) {
      const f = parseFieldLine(raw)
      if (f) fields.push(f)
    }
    if (km[1].toLowerCase() === 'in') inFields = fields
    else outFields = fields
    i = blk.end
  }

  return {
    kind: 'Port',
    name,
    version,
    inFields,
    outFields,
    effect,
    ...(builtin ? { builtin } : {}),
    ...(binding ? { binding } : {}),
  }
}

/** call Foo | call Foo@1.2.0 | call Inv.Foo@2 */
function parseCallRef(text: string): PortRef | null {
  const m = text.match(re(`^call\\s+(${PORT_ID})(?:@([\\d.]+))?`, 'i'))
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
  for (const line of splitEntries(body)) {
    const m = line.match(
      re(`^(${ID})\\s*:\\s*(${ID}(?:<${ID}(?:<${ID}>)?>)?)(?:\\s+from\\s+(${ID}(?:\\.${ID})?))?(?:\\s+label\\s+("([^"]*)"|'([^']*)'))?`),
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
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/,$/, ''))
}

function parseStepOutputs(body: string): StepOutputAst[] {
  const list: StepOutputAst[] = []
  for (const line of splitEntries(body)) {
    const m = line.match(
      re(`^(${ID})\\s*:\\s*(${ID}(?:<${ID}(?:<${ID}>)?>)?)(\\?)?(?:\\s+label\\s+("([^"]*)"|'([^']*)'))?`),
    )
    if (!m) continue
    list.push({ name: m[1], type: m[2], optional: Boolean(m[3]), label: m[5] ?? m[6] })
  }
  return list
}

/**
 * steps {
 *   id "label" { uses { a, b }  output { x: Type } }
 *   id "label"                           // 兼容旧写法
 *   id "label" uses a, b -> x: Type      // 单行紧凑
 *   parallel { branch a { ... } }        // DSL v2 construct (PRD 3.13)
 *   choice { when x == "y" { ... } else { ... } }
 *   forEach item in listRef maxInFlight 2 { ... }
 *   while x == false { ... }
 *   subflow Helper { input { q = question } }
 * }
 */
function parseFlowBody(body: string, counters: ConstructCounters): FlowBodyItem[] | string {
  const items: FlowBodyItem[] = []
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break

    const head = body.slice(i).match(re(`^(${ID})`))
    if (!head) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    const keyword = head[1].toLowerCase()
    let next = i + head[0].length
    while (next < body.length && /[ \t]/.test(body[next])) next++
    const after = body.slice(next)

    if (keyword === 'parallel' && after.startsWith('{')) {
      const parsed = parseParallel(body.slice(next), counters)
      if (typeof parsed === 'string') return parsed
      items.push(parsed)
      i = next + parsed.end
      continue
    }
    if (keyword === 'choice' && after.startsWith('{')) {
      const parsed = parseChoice(body.slice(next), counters)
      if (typeof parsed === 'string') return parsed
      items.push(parsed)
      i = next + parsed.end
      continue
    }
    if (keyword === 'foreach') {
      const parsed = parseForEach(after, counters)
      if (typeof parsed === 'string') return parsed
      items.push(parsed)
      i = next + parsed.end
      continue
    }
    if (keyword === 'while') {
      const parsed = parseWhile(after, counters)
      if (typeof parsed === 'string') return parsed
      items.push(parsed)
      i = next + parsed.end
      continue
    }
    if (keyword === 'subflow') {
      const parsed = parseSubflow(after, counters)
      if (typeof parsed === 'string') return parsed
      items.push(parsed)
      i = next + parsed.end
      continue
    }

    const parsed = parsePlainStep(body, i)
    if (typeof parsed === 'string') return parsed
    items.push({ kind: 'Step', step: parsed.step })
    i = parsed.next
  }
  return items
}

interface ConstructCounters {
  parallel: number
  choice: number
  forEach: number
  while: number
  subflow: number
}

function newConstructCounters(): ConstructCounters {
  return { parallel: 0, choice: 0, forEach: 0, while: 0, subflow: 0 }
}

/** Predicate: field | field == v | field != v | field > n | field < n | field >= n | field <= n | field in [a, b] */
function parsePredicate(text: string): ChoicePredicate | null {
  const t = text.trim()
  const inM = t.match(re(`^(${ID})\\s+in\\s*\\[([^\\]]*)\\]$`, 'u'))
  if (inM) {
    return { field: inM[1], op: 'in', values: inM[2].split(/[\s,]+/).map(unquote).filter(Boolean) }
  }
  const cmpM = t.match(re(`^(${ID})\\s*(==|!=|>=|<=|>|<)\\s*(.+)$`, 'u'))
  if (cmpM) {
    const opRaw = cmpM[2]
    const op =
      opRaw === '==' ? 'eq'
      : opRaw === '!=' ? 'ne'
      : opRaw === '>' ? 'gt'
      : opRaw === '<' ? 'lt'
      : opRaw === '>=' ? 'ge'
      : 'le'
    const value = parsePredicateValue(cmpM[3])
    if (value === null) return null
    return { field: cmpM[1], op, value }
  }
  const truthyM = t.match(re(`^(${ID})$`, 'u'))
  if (truthyM) return { field: truthyM[1], op: 'truthy' }
  return null
}

function parsePredicateValue(raw: string): string | number | boolean | null {
  const t = raw.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true') return true
  if (t === 'false') return false
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return unquote(t)
  if (re(`^${ID}$`, 'u').test(t)) return t
  return null
}

/** parallel { branch a ["label"] { <flow-body> } ... } — input starts at '{' */
function parseParallel(
  text: string,
  counters: ConstructCounters,
): (ParallelAst & { end: number }) | string {
  const blk = extractBlock(text, 0)
  if (!blk) return 'Unclosed parallel block'
  counters.parallel += 1
  const id = `parallel-${counters.parallel}`
  const branches: ParallelBranchAst[] = []
  const seen = new Set<string>()
  const body = blk.body
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break
    const headM = body.slice(i).match(re(`^branch\\s+(${ID})(?:\\s+("([^"]*)"|'([^']*)'))?`, 'i'))
    if (!headM) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    const branchId = headM[1]
    if (seen.has(branchId)) return `Duplicate parallel branch: ${branchId}`
    seen.add(branchId)
    i += headM[0].length
    while (i < body.length && /[ \t]/.test(body[i])) i++
    if (body[i] !== '{') return `Expected '{' after branch ${branchId}`
    const branchBlk = extractBlock(body, i)
    if (!branchBlk) return `Unclosed branch ${branchId} in parallel ${id}`
    const parsedBody = parseFlowBody(branchBlk.body, counters)
    if (typeof parsedBody === 'string') return parsedBody
    branches.push({
      id: branchId,
      ...(headM[2] ? { label: headM[3] ?? headM[4] } : {}),
      body: parsedBody,
    })
    i = branchBlk.end
  }
  return { kind: 'Parallel', id, branches, end: blk.end }
}

/** choice { when <pred> { body } ... [else { body }] } — input starts at '{' */
function parseChoice(
  text: string,
  counters: ConstructCounters,
): (ChoiceAst & { end: number }) | string {
  const blk = extractBlock(text, 0)
  if (!blk) return 'Unclosed choice block'
  counters.choice += 1
  const id = `choice-${counters.choice}`
  const branches: ChoiceBranchAst[] = []
  const body = blk.body
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break
    const whenM = body.slice(i).match(/^when\b/i)
    const elseM = body.slice(i).match(/^else\b/i)
    if (!whenM && !elseM) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    i += (whenM ?? elseM)![0].length
    while (i < body.length && /[ \t]/.test(body[i])) i++
    let predicate: ChoicePredicate | undefined
    if (whenM) {
      const brace = body.indexOf('{', i)
      if (brace < 0) return 'Unclosed when branch in choice'
      const parsedPredicate = parsePredicate(body.slice(i, brace))
      if (!parsedPredicate) return `Invalid when predicate in choice ${id}`
      predicate = parsedPredicate
      i = brace
    }
    if (body[i] !== '{') return `Expected '{' after ${whenM ? 'when' : 'else'} in choice ${id}`
    const branchBlk = extractBlock(body, i)
    if (!branchBlk) return `Unclosed ${whenM ? 'when' : 'else'} branch in choice ${id}`
    const parsedBody = parseFlowBody(branchBlk.body, counters)
    if (typeof parsedBody === 'string') return parsedBody
    branches.push({ ...(predicate ? { when: predicate } : {}), body: parsedBody })
    i = branchBlk.end
  }
  return { kind: 'Choice', id, branches, end: blk.end }
}

/** forEach <item> in <source> [maxInFlight <n>] { <flow-body> } */
function parseForEach(
  text: string,
  counters: ConstructCounters,
): (ForEachAst & { end: number }) | string {
  const headM = text.match(re(`^(${ID})\\s+in\\s+(${ID})(.*)$`, 'is'))
  if (!headM) return `Invalid forEach header: forEach ${text.split('{')[0]?.trim() ?? ''}`
  const item = headM[1]
  const source = headM[2]
  let rest = headM[3]
  let maxInFlight: number | undefined
  const flightM = rest.match(/\bmaxInFlight\s+(\d+)/i)
  if (flightM) maxInFlight = Number(flightM[1])
  const brace = rest.indexOf('{')
  if (brace < 0) return 'forEach is missing a body block'
  const blk = extractBlock(rest, brace)
  if (!blk) return 'Unclosed forEach block'
  const parsedBody = parseFlowBody(blk.body, counters)
  if (typeof parsedBody === 'string') return parsedBody
  counters.forEach += 1
  const id = `forEach-${counters.forEach}`
  return {
    kind: 'ForEach',
    id,
    item,
    source,
    ...(maxInFlight !== undefined ? { maxInFlight } : {}),
    body: parsedBody,
    end: brace + blk.end,
  }
}

/** while <pred> { <flow-body> } — no static iteration cap (PRD 3.13.3) */
function parseWhile(
  text: string,
  counters: ConstructCounters,
): (WhileAst & { end: number }) | string {
  const brace = text.indexOf('{')
  if (brace < 0) return 'while is missing a body block'
  const predicate = parsePredicate(text.slice(0, brace))
  if (!predicate) return `Invalid while predicate: ${text.slice(0, brace).trim()}`
  const blk = extractBlock(text, brace)
  if (!blk) return 'Unclosed while block'
  const parsedBody = parseFlowBody(blk.body, counters)
  if (typeof parsedBody === 'string') return parsedBody
  counters.while += 1
  const id = `while-${counters.while}`
  return { kind: 'While', id, when: predicate, body: parsedBody, end: brace + blk.end }
}

/** subflow <FlowName> [input { param = ref, ... }] — the braced body form is also supported */
function parseSubflow(
  text: string,
  counters: ConstructCounters,
): (SubflowAst & { end: number }) | string {
  const headM = text.match(re(`^(${ID})`, 'u'))
  if (!headM) return 'Invalid subflow header'
  const rest = text.slice(headM[0].length)
  const lead = rest.length - rest.replace(/^\s+/, '').length
  const trimmed = rest.slice(lead)
  const input: Record<string, string> = {}
  let end = headM[0].length
  const parseInputBlock = (body: string): void => {
    for (const raw of splitEntries(body)) {
      const m = raw.match(re(`^(${ID})\\s*[=:]\\s*(${ID})$`))
      if (m) input[m[1]] = m[2]
    }
  }
  const directM = trimmed.match(/^input\s*\{([\s\S]*?)\}/)
  if (directM) {
    parseInputBlock(directM[1] ?? '')
    end = headM[0].length + lead + directM[0].length
  } else if (trimmed[0] === '{') {
    const blk = extractBlock(trimmed, 0)
    if (!blk) return 'Unclosed subflow body'
    end = headM[0].length + lead + blk.end
    const inputM = blk.body.match(/\binput\s*\{([\s\S]*?)\}/)
    if (inputM) parseInputBlock(inputM[1] ?? '')
  }
  counters.subflow += 1
  const id = `subflow-${counters.subflow}`
  return { kind: 'Subflow', id, flow: headM[1], ...(Object.keys(input).length ? { input } : {}), end }
}

/** Parse one plain step (v1 syntax) starting at index i. */
function parsePlainStep(body: string, i: number): { step: StepAst; next: number } | string {
  const head = body.slice(i).match(re(`^(${ID})(?:\\s+(\"([^\"]*)\"|'([^']*)'))?`))
  if (!head) return `Invalid step at offset ${i}`
  const id = head[1]
  const label = head[3] ?? head[4] ?? id
  i += head[0].length
  while (i < body.length && /[ \t]/.test(body[i])) i++

  let uses: string[] = []
  let outputs: StepOutputAst[] = []
  let call: PortRef | undefined
  let command: string | undefined
  let map: StepAst['map'] | undefined
  let timeoutMs: number | undefined
  let budgetUsd: number | undefined

  // block form
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

      const commandM = part.match(/^command\s+("([^"]*)"|'([^']*)'|([^\s}]+))/i)
      if (commandM) {
        command = commandM[2] ?? commandM[3] ?? commandM[4]
        j += commandM[0].length
        continue
      }

      const mapM = part.match(re(`^map\\s+(${ID})\\s+in\\s+(${ID})\\s+call\\s+(${PORT_ID})(?:@([\\d.]+))?`, 'i'))
      if (mapM) {
        const raw = mapM[4] ? `${mapM[3]}@${mapM[4]}` : mapM[3]
        map = { item: mapM[1], source: mapM[2], call: parsePortRef(raw) }
        j += mapM[0].length
        continue
      }

      const policyM = part.match(/^(timeoutMs|budgetUsd)\s+([^\s}]+)/i)
      if (policyM) {
        const parsed = Number(policyM[2])
        if (Number.isFinite(parsed)) {
          if (policyM[1].toLowerCase() === 'timeoutms') timeoutMs = Math.round(parsed)
          else budgetUsd = parsed
        }
        j += policyM[0].length
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

  const step: StepAst = {
    id,
    label,
    uses,
    outputs,
    ...(call ? { call } : {}),
    ...(command ? { command } : {}),
    ...(map ? { map } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  }
  return { step, next: i }
}

function parseDurationMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (!match) return null
  const value = Number(match[1])
  const unit = (match[2] ?? 'ms').toLowerCase()
  const multiplier = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1
  const result = value * multiplier
  return Number.isFinite(result) ? Math.round(result) : null
}

function parseListBlock(body: string): string[] {
  return parseUsesList(body)
}

/* Removed trial parser implementation retained only in history. */
/*
function parseTrialRetry(body: string): TrialRetryAst {
  const maxM = body.match(/\bmax(?:Attempts)?\s+([^\s}]+)/i)
  const backoffToken = body.match(/\bbackoff\s+([^\s}]+)/i)
  const backoffMs = backoffToken ? parseDurationMs(backoffToken[1]) : 0
  return {
    maxAttempts: maxM ? Number(maxM[1]) : 1,
    backoffMs: backoffToken ? (backoffMs ?? Number.NaN) : 0,
  }
}

function parseTrialNodeBody(body: string): Omit<TrialNodeAst, 'kind' | 'id' | 'label'> | string {
  let i = 0
  let role: TrialNodeAst['role']
  let uses: string[] = []
  let outputs: StepOutputAst[] = []
  let call: PortRef | undefined
  let capabilities: string[] = []
  let retry: TrialRetryAst = { maxAttempts: 1, backoffMs: 0 }
  let timeoutMs: number | undefined
  let maxActions: number | undefined

  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break
    const slice = body.slice(i)

    const callRef = parseCallRef(slice)
    if (callRef) {
      call = callRef
      const eaten = slice.match(re(`^call\\s+(${ID}(?:\\.${ID})?)(?:@[\\d.]+)?`, 'i'))
      i += eaten?.[0].length ?? callRef.raw.length + 5
      continue
    }

    const roleM = slice.match(new RegExp(`^role\\s+(${ID})`, 'iu'))
    if (roleM) {
      role = roleM[1]
      i += roleM[0].length
      continue
    }

    const scalarM = slice.match(/^(timeout|maxActions)\s+([^\s}]+)/i)
    if (scalarM) {
      if (scalarM[1].toLowerCase() === 'timeout') {
        const parsed = parseDurationMs(scalarM[2])
        timeoutMs = parsed ?? Number.NaN
      } else {
        const parsed = Number(scalarM[2])
        maxActions = parsed
      }
      i += scalarM[0].length
      continue
    }

    const blockM = slice.match(/^(uses|output|out|capabilities|retry)\b/i)
    if (!blockM) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    const key = blockM[1].toLowerCase()
    i += blockM[0].length
    while (i < body.length && /\s/.test(body[i])) i++
    if (body[i] !== '{') return `Expected '{' after ${key} in trial node`
    const block = extractBlock(body, i)
    if (!block) return `Unclosed ${key} in trial node`
    if (key === 'uses') uses = parseListBlock(block.body)
    else if (key === 'output' || key === 'out') outputs = parseStepOutputs(block.body)
    else if (key === 'capabilities') capabilities = parseListBlock(block.body)
    else retry = parseTrialRetry(block.body)
    i = block.end
  }

  return { role, uses, outputs, call, capabilities, retry, timeoutMs, maxActions }
}

function parseTrialNodes(body: string): TrialNodeAst[] | string {
  const nodes: TrialNodeAst[] = []
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break
    const head = body.slice(i).match(re(`^(${ID})(?:\\s+("([^"]*)"|'([^']*)'))?`))
    if (!head) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    const id = head[1]
    const label = head[3] ?? head[4] ?? id
    i += head[0].length
    while (i < body.length && /\s/.test(body[i])) i++
    if (body[i] !== '{') return `Expected '{' after trial node ${id}`
    const block = extractBlock(body, i)
    if (!block) return `Unclosed trial node ${id}`
    const parsed = parseTrialNodeBody(block.body)
    if (typeof parsed === 'string') return parsed
    nodes.push({ kind: 'TrialNode', id, label, ...parsed })
    i = block.end
  }
  return nodes
}

function parseTrialEdges(body: string): TrialEdgeAst[] {
  const edges: TrialEdgeAst[] = []
  for (const raw of splitEntries(body)) {
    const line = raw.trim()
    if (!line) continue
    const head = line.match(re(`^edge\\s+(${ID})\\s*->\\s*(${ID})(.*)$`, 'i'))
    if (!head) continue
    const rest = head[3] ?? ''
    let when: string | undefined
    const whenIndex = rest.search(/\bwhen\b/i)
    if (whenIndex >= 0) {
      const tail = rest.slice(whenIndex + 4).trim()
      if (tail.startsWith('"') || tail.startsWith("'")) {
        const quote = tail[0]
        const end = tail.indexOf(quote, 1)
        if (end >= 0) when = tail.slice(1, end)
      } else {
        const end = tail.search(/\s+(?:feedback|reset)\b/i)
        when = (end >= 0 ? tail.slice(0, end) : tail).trim()
      }
    }
    const feedbackM = rest.match(new RegExp('\\bfeedback\\s+(' + ID + ')(?:\\s+as\\s+(' + ID + '))?', 'iu'))
    edges.push({
      kind: 'TrialEdge',
      from: head[1],
      to: head[2],
      ...(when ? { when } : {}),
      ...(feedbackM ? { feedback: feedbackM[1] } : {}),
      ...(feedbackM?.[2] ? { feedbackAs: feedbackM[2] } : {}),
      ...(new RegExp('\\breset(?:\\s+attempts)?\\b', 'i').test(rest)
        ? { resetAttempts: true }
        : {}),
    })
  }
  return edges
}

function parseTrialArtifacts(body: string): TrialArtifactAst[] {
  const artifacts: TrialArtifactAst[] = []
  for (const line of splitEntries(body)) {
    const match = line.match(
      re(`^(${ID})\\s*:\\s*(${ID})(?:\\s+kind\\s+(data|report|log|snapshot|script))?(?:\\s+(redacted))?$`, 'i'),
    )
    if (!match) continue
    artifacts.push({
      name: match[1],
      type: match[2],
      kind: (match[3]?.toLowerCase() as TrialArtifactAst['kind'] | undefined) ?? 'data',
      redacted: Boolean(match[4]),
    })
  }
  return artifacts
}

function parseTrialExecution(body: string): TrialExecutionAst {
  const classM = body.match(/\bclass\s+(pure|workspace|ai)\b/i)
  const isolationM = body.match(/\bisolation\s+(disposable|scoped|none)\b/i)
  const networkM = body.match(/\bnetwork\s+(deny|allow)\b/i)
  return {
    class: (classM?.[1].toLowerCase() as TrialExecutionAst['class'] | undefined) ?? 'ai',
    isolation: (isolationM?.[1].toLowerCase() as TrialExecutionAst['isolation'] | undefined) ?? 'disposable',
    network: (networkM?.[1].toLowerCase() as TrialExecutionAst['network'] | undefined) ?? 'deny',
  }
}

function parseTrialBudget(body: string): TrialAst['budget'] {
  const timeoutM = body.match(/\btimeout\s+([^\s}]+)/i)
  const costM = body.match(/\b(?:cost|maxCost)\s+([^\s}]+)/i)
  const transitionM = body.match(/\bmaxTransitions\s+([^\s}]+)/i)
  return {
    timeoutMs: timeoutM ? (parseDurationMs(timeoutM[1]) ?? Number.NaN) : Number.POSITIVE_INFINITY,
    maxCost: costM ? Number(costM[1]) : Number.POSITIVE_INFINITY,
    maxTransitions: transitionM ? Number(transitionM[1]) : Number.POSITIVE_INFINITY,
  }
}

function parseTrial(header: string, body: string): TrialAst | ParseError {
  const nameM = header.match(re(`^trial\\s+(${ID})`, 'i'))
  if (!nameM) return { message: `Invalid trial header: ${header}` }
  const titleM = header.match(/\btitle\s+("([^"]*)"|'([^']*)')/)
  const trial: TrialAst = {
    kind: 'Trial',
    name: nameM[1],
    title: titleM ? (titleM[2] ?? titleM[3]) : nameM[1],
    inputs: [],
    nodes: [],
    edges: [],
    start: '',
    terminal: [],
    budget: { timeoutMs: 2_700_000, maxCost: 5, maxTransitions: 128 },
    execution: { class: 'ai', isolation: 'disposable', network: 'deny' },
    artifacts: [],
  }
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break
    const slice = body.slice(i)
    const startM = slice.match(new RegExp(`^start\\s+(${ID})`, 'iu'))
    if (startM) {
      trial.start = startM[1]
      i += startM[0].length
      continue
    }

    const blockM = slice.match(/^(input|budget|execution|artifacts|nodes|edges|terminal)\b/i)
    if (!blockM) {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl + 1
      continue
    }
    const key = blockM[1].toLowerCase()
    i += blockM[0].length
    while (i < body.length && /\s/.test(body[i])) i++
    if (body[i] !== '{') return { message: `Expected '{' after ${key} in trial ${trial.name}` }
    const block = extractBlock(body, i)
    if (!block) return { message: `Unclosed ${key} in trial ${trial.name}` }
    if (key === 'input') {
      for (const raw of splitEntries(block.body)) {
        const input = parseInputLine(raw)
        if (input) trial.inputs.push(input)
      }
    } else if (key === 'budget') trial.budget = parseTrialBudget(block.body)
    else if (key === 'execution') trial.execution = parseTrialExecution(block.body)
    else if (key === 'artifacts') trial.artifacts = parseTrialArtifacts(block.body)
    else if (key === 'nodes') {
      const nodes = parseTrialNodes(block.body)
      if (typeof nodes === 'string') return { message: nodes }
      trial.nodes = nodes
    } else if (key === 'edges') trial.edges = parseTrialEdges(block.body)
    else trial.terminal = parseListBlock(block.body)
    i = block.end
  }
  return trial
}
*/

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
    languageVersion: DEFAULT_DSL_LANGUAGE_VERSION,
    imports: [],
    enums: [],
    entities: [],
    ports: [],
    flows: [],
    modules: [],
    pipelines: [],
  }

  const languageM = cleaned.match(/^\s*dsl\s+version\s+(?:"([^"]*)"|'([^']*)')/im)
  if (languageM) {
    const requested = (languageM[1] ?? languageM[2] ?? '').trim().replace(/^v(?=\d)/i, '')
    if (requested === '0.3' || requested === '0.4' || requested === '0.5') {
      ast.languageVersion = requested
    } else {
      errors.push({ message: `Unsupported DSL language version: ${requested}` })
    }
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
  if (new RegExp(String.raw`\btrial\s+${ID}`, 'iu').test(cleaned)) {
    errors.push({ message: 'The trial DSL surface has been removed; use flow instead' })
  }
  const headEnd = cleaned.search(new RegExp(String.raw`\b(module|entity|enum|flow|port)\s+${ID}`, 'iu'))
  const head = headEnd >= 0 ? cleaned.slice(0, headEnd) : cleaned
  const titleM = head.match(/\btitle\s+("([^"]*)"|'([^']*)')/)
  if (titleM) ast.title = titleM[2] ?? titleM[3]
  const descM = head.match(/\bdescription\s+("([^"]*)"|'([^']*)')/)
  if (descM) ast.description = descM[2] ?? descM[3]
  const categoryM = head.match(/\bcategory\s+("([^"]*)"|'([^']*)')/)
  if (categoryM) ast.category = categoryM[2] ?? categoryM[3]
  const accentM = head.match(/\baccent\s+("([^"]*)"|'([^']*)')/)
  const accent = accentM?.[2] ?? accentM?.[3]
  if (accent === 'green' || accent === 'blue' || accent === 'amber') {
    ast.accent = accent as DomainAccent
  } else if (accent) {
    errors.push({ message: `Unsupported domain accent: ${accent}` })
  }

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
