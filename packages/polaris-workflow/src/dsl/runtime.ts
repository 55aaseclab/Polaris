/**
 * 通用运行时：文档型记录 + 步骤上下文（input → step uses/output → flow output）
 */

export interface DocRecord {
  entity: string
  id: string
  status: string
  data: Record<string, string | number | boolean | undefined>
  createdAt: string
  updatedAt: string
  history: HistoryEntry[]
}

export interface HistoryEntry {
  at: string
  flow: string
  mode: 'interpret' | 'compile'
  event?: string
  message: string
  steps: { id: string; label: string; ok: boolean }[]
}

export type CtxValue = string | number | boolean | undefined

export interface RunInput {
  [key: string]: CtxValue
}

/** 执行中的数据黑板：flow input + 各 step 产出 */
export type StepContext = Record<string, CtxValue>

export interface StepLog {
  id: string
  label: string
  ok: boolean
  detail?: string
  /** 本步实际读到的 uses */
  used?: Record<string, CtxValue>
  /** 本步写出的 output */
  produced?: Record<string, CtxValue>
  /** FFI：调用的 port */
  call?: string
  /** 是否走了 Host.invoke */
  ffi?: boolean
}

export interface RunResult {
  ok: boolean
  message: string
  mode: 'interpret' | 'compile'
  record?: DocRecord
  stepLog: StepLog[]
  /** flow 级 output 求值结果 */
  outputs?: Record<string, CtxValue>
  event?: string
}

export interface RuntimeEvent {
  at: string
  name: string
  entity: string
  recordId: string
  mode: 'interpret' | 'compile'
}

export class DocStore {
  records: DocRecord[] = []
  events: RuntimeEvent[] = []

  list(entity?: string): DocRecord[] {
    const list = entity ? this.records.filter((r) => r.entity === entity) : [...this.records]
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): DocRecord | undefined {
    return this.records.find((r) => r.id === id)
  }
}

export function nowIso() {
  return new Date().toISOString()
}

export function genId(prefix = 'DOC') {
  const t = Date.now().toString(36).toUpperCase()
  const r = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}-${t}-${r}`
}

export function evalRequireExpr(
  expr: string | undefined,
  record: DocRecord | null,
): { ok: boolean; reason?: string } {
  if (!expr || expr.trim() === 'true') return { ok: true }
  const status = record?.status

  const eq = expr.match(/^status\s*==\s*([A-Za-z_]\w*)$/)
  if (eq) {
    if (!record) return { ok: false, reason: '需要已有业务单据' }
    if (status !== eq[1]) return { ok: false, reason: `需要状态 ${eq[1]}，当前为 ${status}` }
    return { ok: true }
  }

  const inn = expr.match(/^status\s+in\s*\[([^\]]+)\]$/)
  if (inn) {
    if (!record) return { ok: false, reason: '需要已有业务单据' }
    const allowed = inn[1].split(',').map((s) => s.trim())
    if (!allowed.includes(status ?? '')) {
      return { ok: false, reason: `需要状态 ∈ [${allowed.join(', ')}]，当前为 ${status}` }
    }
    return { ok: true }
  }

  return { ok: false, reason: `无法求值守卫: ${expr}` }
}

export interface StepSpec {
  id: string
  label: string
  uses: string[]
  outputs: { name: string; type: string }[]
  /** FFI port 名（可 Alias.Name） */
  call?: string
  /** port 版本钉扎 */
  callVersion?: string
}

export interface StepExecOptions {
  ctx: StepContext
  record: DocRecord | null
  host?: {
    invoke: (req: {
      port: string
      version?: string
      input: StepContext
      meta?: { stepId?: string; flowName?: string; mode?: 'interpret' | 'compile' }
    }) => {
      ok: boolean
      output: StepContext
      detail?: string
      error?: string
      resolvedVersion?: string
    }
    has?: (port: string, version?: string) => boolean
  }
  flowName?: string
  mode?: 'interpret' | 'compile'
}

export interface AsyncStepExecOptions {
  ctx: StepContext
  record: DocRecord | null
  host?: StepExecOptions['host'] & {
    invokeAsync?: (req: Parameters<NonNullable<StepExecOptions['host']>['invoke']>[0]) => Promise<ReturnType<NonNullable<StepExecOptions['host']>['invoke']>>
  }
  flowName?: string
  mode?: 'interpret' | 'compile'
}

function collectStepUses(
  step: StepSpec,
  ctx: StepContext,
  record: DocRecord | null,
): { ok: true; used: Record<string, CtxValue> } | { ok: false; log: StepLog } {
  const used: Record<string, CtxValue> = {}
  for (const name of step.uses) {
    if (!(name in ctx) || ctx[name] === undefined || ctx[name] === '') {
      if (name === 'recordId' && record) {
        used[name] = record.id
        ctx[name] = record.id
        continue
      }
      return {
        ok: false,
        log: {
          id: step.id,
          label: step.label,
          ok: false,
          detail: `缺少 uses 依赖: ${name}`,
          used,
          call: step.call,
        },
      }
    }
    used[name] = ctx[name]
  }
  return { ok: true, used }
}

function ffiMissingHostLog(
  step: StepSpec,
  used: Record<string, CtxValue>,
): StepLog {
  const callLabel = step.callVersion ? `${step.call}@${step.callVersion}` : step.call
  return {
    id: step.id,
    label: step.label,
    ok: false,
    detail: `step call ${callLabel} 但未注入 FfiHost`,
    used,
    call: callLabel,
    ffi: true,
  }
}

function ffiFailureLog(
  step: StepSpec,
  used: Record<string, CtxValue>,
  error: string | undefined,
): StepLog {
  const callLabel = step.callVersion ? `${step.call}@${step.callVersion}` : step.call
  return {
    id: step.id,
    label: step.label,
    ok: false,
    detail: error ?? `FFI ${callLabel} 失败`,
    used,
    call: callLabel,
    ffi: true,
  }
}

function ffiSuccessLog(
  step: StepSpec,
  ctx: StepContext,
  used: Record<string, CtxValue>,
  res: {
    output: StepContext
    detail?: string
    resolvedVersion?: string
  },
): StepLog {
  const produced: Record<string, CtxValue> = {}
  for (const out of step.outputs) {
    const v = res.output[out.name] ?? res.output[Object.keys(res.output)[0]!]
    produced[out.name] = v
    ctx[out.name] = v
  }
  if (step.outputs.length === 0) {
    for (const [k, v] of Object.entries(res.output)) {
      produced[k] = v
      ctx[k] = v
    }
  }
  const usedSummary = step.uses.map((u) => `${u}=${fmt(used[u])}`).join(', ') || '(no uses)'
  const outSummary =
    Object.entries(produced)
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(', ') || '(no output)'
  const resolved = res.resolvedVersion ? `@${res.resolvedVersion}` : ''
  return {
    id: step.id,
    label: step.label,
    ok: true,
    detail: `call ${step.call}${resolved} · uses{ ${usedSummary} } → out{ ${outSummary} } · ${res.detail ?? 'ffi'}`,
    used,
    produced,
    call: `${step.call}${resolved}`,
    ffi: true,
  }
}

/**
 * 执行一步：
 * 1. 从 ctx 取 uses
 * 2. 若 call port → Host.invoke（FFI）；否则纯计算 produce
 * 3. 写 outputs 回 ctx
 */
export function execStepWithIO(step: StepSpec, opts: StepExecOptions): StepLog {
  const { ctx, record, host, flowName, mode } = opts
  const collected = collectStepUses(step, ctx, record)
  if (!collected.ok) return collected.log
  const { used } = collected

  const produced: Record<string, CtxValue> = {}

  // ── FFI 路径 ──
  if (step.call) {
    if (!host) return ffiMissingHostLog(step, used)
    const res = host.invoke({
      port: step.call,
      version: step.callVersion,
      input: { ...used },
      meta: { stepId: step.id, flowName, mode },
    })
    if (!res.ok) return ffiFailureLog(step, used, res.error)
    return ffiSuccessLog(step, ctx, used, res)
  }

  // ── 纯计算路径 ──
  for (const out of step.outputs) {
    const v = produceOutput(step.id, out.name, out.type, used, ctx, record)
    produced[out.name] = v
    ctx[out.name] = v
  }
  if (step.outputs.length === 0) {
    const mark = `${step.id}_ok`
    produced[mark] = true
    ctx[mark] = true
  }

  const usedSummary = step.uses.length
    ? step.uses.map((u) => `${u}=${fmt(used[u])}`).join(', ')
    : '(no uses)'
  const outSummary = Object.keys(produced).length
    ? Object.entries(produced)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(', ')
    : '(no output)'

  return {
    id: step.id,
    label: step.label,
    ok: true,
    detail: `uses{ ${usedSummary} } → out{ ${outSummary} }`,
    used,
    produced,
  }
}

export async function execStepWithIOAsync(
  step: StepSpec,
  opts: AsyncStepExecOptions,
): Promise<StepLog> {
  const { ctx, record, host, flowName, mode } = opts
  const collected = collectStepUses(step, ctx, record)
  if (!collected.ok) return collected.log
  const { used } = collected

  if (!step.call) {
    return execStepWithIO(step, opts)
  }

  if (!host) return ffiMissingHostLog(step, used)
  const invoke = host.invokeAsync
    ? (req: Parameters<NonNullable<AsyncStepExecOptions['host']>['invoke']>[0]) => host.invokeAsync!(req)
    : (req: Parameters<NonNullable<AsyncStepExecOptions['host']>['invoke']>[0]) => Promise.resolve(host.invoke(req))
  const res = await invoke({
    port: step.call,
    version: step.callVersion,
    input: { ...used },
    meta: { stepId: step.id, flowName, mode },
  })
  if (!res.ok) return ffiFailureLog(step, used, res.error)
  return ffiSuccessLog(step, ctx, used, res)
}

function fmt(v: CtxValue): string {
  if (v === undefined) return '∅'
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

/** 通用产出规则（非业务绑定）：用 uses 拼出可观察的 output */
function produceOutput(
  stepId: string,
  outName: string,
  outType: string,
  used: Record<string, CtxValue>,
  ctx: StepContext,
  record: DocRecord | null,
): CtxValue {
  // 常见命名约定
  if (outName === 'orderId' || outName === 'recordId' || outName.endsWith('Id')) {
    if (record?.id) return record.id
    if (typeof used.recordId === 'string') return used.recordId
    return genId(outName.replace(/Id$/, '').slice(0, 3).toUpperCase() || 'ID')
  }
  if (outType === 'Boolean' || outName.endsWith('Ok') || outName.startsWith('valid')) {
    return true
  }
  if (outType === 'Number' || outType === 'Money') {
    const n = Number(used.qty ?? used.amount ?? used[outName] ?? 0)
    return Number.isFinite(n) ? n : 0
  }
  // 字符串：拼接关键 uses，便于 UI 看见「用了 input」
  const parts = Object.entries(used)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}:${v}`)
  if (parts.length) return `[${stepId}] ${parts.join(' · ')}`
  if (ctx[outName] !== undefined) return ctx[outName]
  return `[${stepId}].${outName}`
}

/** 按 flow.output 契约从 ctx 收集对外输出 */
export function collectFlowOutputs(
  specs: { name: string; from?: string }[],
  ctx: StepContext,
  record: DocRecord | null,
): Record<string, CtxValue> {
  const out: Record<string, CtxValue> = {}
  for (const s of specs) {
    const src = s.from ?? s.name
    // from 可以是 "stepOut" 或 字面 name
    if (src === 'record.id' && record) {
      out[s.name] = record.id
      continue
    }
    if (src === 'record.status' && record) {
      out[s.name] = record.status
      continue
    }
    out[s.name] = ctx[src] ?? ctx[s.name]
  }
  // 默认带上 record 身份
  if (record) {
    if (out.recordId === undefined) out.recordId = record.id
    if (out.status === undefined) out.status = record.status
  }
  return out
}

export function applyFlowEffects(opts: {
  flowName: string
  title: string
  entity: string
  create: boolean
  input: RunInput
  record: DocRecord | null
  transitionTo?: string
  emit?: string
  stepLog: StepLog[]
  mode: 'interpret' | 'compile'
  store: DocStore
  /** 步骤产出合并进单据 data */
  ctx?: StepContext
}): { record: DocRecord; event?: string } {
  const { flowName, title, entity, create, input, transitionTo, emit, stepLog, mode, store, ctx } = opts
  let record = opts.record
  const ts = nowIso()

  const dataPatch: DocRecord['data'] = {}
  for (const [k, v] of Object.entries(input)) {
    if (k === 'recordId' || k === 'id') continue
    dataPatch[k] = v
  }
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (k in dataPatch) continue
      if (k === 'recordId' || k === 'id') continue
      // 不把巨大中间串全写进 data：只写简单值
      if (typeof v === 'string' && v.startsWith('[')) continue
      dataPatch[k] = v
    }
  }

  if (create || !record) {
    const prefix = entity.slice(0, 3).toUpperCase()
    // 若 step 已产出 orderId/recordId，复用，保证 flow.output 与单据一致
    const presetId =
      (typeof ctx?.orderId === 'string' && ctx.orderId) ||
      (typeof ctx?.recordId === 'string' && ctx.recordId && !store.get(String(ctx.recordId))
        ? String(ctx.recordId)
        : null)
    record = {
      entity,
      id: presetId || genId(prefix),
      status: transitionTo ?? 'Draft',
      data: { ...dataPatch },
      createdAt: ts,
      updatedAt: ts,
      history: [],
    }
    store.records.unshift(record)
  } else {
    record.data = { ...record.data, ...dataPatch }
    if (transitionTo) record.status = transitionTo
    record.updatedAt = ts
  }

  // 创建后把 id 回写 ctx，供 flow.output from record.id
  if (ctx) {
    ctx.recordId = record.id
    ctx.id = record.id
    ctx.status = record.status
  }

  record.history.unshift({
    at: ts,
    flow: flowName,
    mode,
    event: emit,
    message: `${title} 成功`,
    steps: stepLog.map((s) => ({ id: s.id, label: s.label, ok: s.ok })),
  })

  if (emit) {
    store.events.unshift({
      at: ts,
      name: emit,
      entity: record.entity,
      recordId: record.id,
      mode,
    })
  }

  return { record, event: emit }
}
