import { flattenDomain, flowBodyItems, type DomainAst, type FlowAst, type InputFieldAst, type PortAst, type SubflowAst } from './ast.js'
import type { AsyncFfiHost, FfiHost } from './host.js'
import {
  applyFlowEffects,
  collectFlowOutputs,
  evalRequireExpr,
  type DocStore,
  type RunInput,
  type RunResult,
  type StepContext,
} from './runtime.js'
import {
  execFlowBodyAsync,
  execFlowBodySync,
  subflowRunInput,
  type FlowBodyEnv,
} from './structure.js'

export interface ProgramField {
  name: string
  type: string
  label: string
  required: boolean
  min?: number
  placeholder?: string
  inputKind: 'text' | 'number' | 'money' | 'select'
}

export interface ProgramStepMeta {
  id: string
  label: string
  index: number
  uses: string[]
  outputs: { name: string; type: string; label?: string }[]
  /** Name 或 Name@ver 或 Alias.Name@ver */
  call?: string
  map?: { item: string; source: string; call: string }
}

export interface ProgramFlowOutputMeta {
  name: string
  type: string
  from?: string
  label?: string
}

export interface ProgramPortMeta {
  name: string
  version: string
  qualifiedName?: string
  originDomain?: string
  effect: string
  builtin?: string
  binding?: {
    tool: string
    command?: string
    aliases?: Record<string, string>
  }
  inFields: string[]
  outFields: string[]
}

export interface ProgramFlowMeta {
  name: string
  title: string
  description?: string
  module?: string
  on?: string
  create?: boolean
  needs: string[]
  icon: string
  primaryAction: string
  fields: ProgramField[]
  outputs: ProgramFlowOutputMeta[]
  steps: ProgramStepMeta[]
  requireExpr?: string
  transitionTo?: string
  emit?: string
  pipeline: string[]
}

export interface CompiledFlowHandler {
  meta: ProgramFlowMeta
  execute: (input: RunInput, store: DocStore, host: FfiHost, depth?: number) => RunResult
  executeAsync: (input: RunInput, store: DocStore, host: FfiHost | AsyncFfiHost, depth?: number) => Promise<RunResult>
}

export interface ProgramModuleMeta {
  name: string
  code?: string
  title: string
  description?: string
  outputs: string[]
  flowNames: string[]
}

export interface ProgramPipelineMeta {
  name: string
  title?: string
  steps: string[]
}

export interface Program {
  name: string
  version: string
  languageVersion: string
  title: string
  description?: string
  fingerprint: string
  modules: ProgramModuleMeta[]
  entityNames: string[]
  /** 编译期 port 符号表（仍不内联 CLI） */
  ports: ProgramPortMeta[]
  pipelines: ProgramPipelineMeta[]
  flows: CompiledFlowHandler[]
  jsSource: string
  run: (flowName: string, input: RunInput, store: DocStore, host: FfiHost) => RunResult
  runAsync: (flowName: string, input: RunInput, store: DocStore, host: FfiHost | AsyncFfiHost) => Promise<RunResult>
}

function labelOf(inp: InputFieldAst): string {
  return inp.label ?? inp.name
}

function iconOf(flow: FlowAst): string {
  if (flow.ui.icon) return flow.ui.icon
  if (flow.create) return 'plus-circle'
  return 'workflow'
}

export function toMeta(flow: FlowAst): ProgramFlowMeta {
  const needsRaw = (flow.needs ?? []).map((n) => n.raw)
  return {
    name: flow.name,
    title: flow.title,
    description: flow.description,
    module: flow.module,
    on: flow.on,
    create: flow.create,
    needs: needsRaw,
    icon: iconOf(flow),
    primaryAction: flow.ui.primary,
    fields: flow.inputs.map((inp) => ({
      name: inp.name,
      type: inp.type,
      label: labelOf(inp),
      required: Boolean(inp.required),
      min: inp.min,
      placeholder: inp.placeholder,
      inputKind: inp.type === 'Number' ? 'number' : inp.type === 'Money' ? 'money' : 'text',
    })),
    outputs: flow.outputs.map((o) => ({
      name: o.name,
      type: o.type,
      from: o.from,
      label: o.label,
    })),
    steps: flow.steps.map((s, index) => ({
      id: s.id,
      label: s.label,
      index,
      uses: [...s.uses],
      outputs: s.outputs.map((o) => ({ name: o.name, type: o.type, label: o.label })),
      call: s.call?.raw,
      command: s.command,
      map: s.map ? { item: s.map.item, source: s.map.source, call: s.map.call.raw } : undefined,
    })),
    requireExpr: flow.require?.expr,
    transitionTo: flow.transition?.to,
    emit: flow.emit,
    pipeline: [
      `实体: ${flow.on ?? '?'}`,
      flow.create ? '动作: create' : '动作: update',
      needsRaw.length ? `needs: ${needsRaw.join(', ')}` : 'needs: ∅',
      `input: ${flow.inputs.map((i) => i.name).join(', ') || '∅'}`,
      ...flow.steps.map((s, i) => {
        const u = s.uses.length ? `uses(${s.uses.join(',')})` : 'uses(-)'
        const c = s.call ? ` call ${s.call.raw}` : ''
        const o = s.outputs.length ? `→ out(${s.outputs.map((x) => x.name).join(',')})` : '→ out(-)'
        return `步骤${i + 1}: ${s.label} ${u}${c} ${o}`
      }),
      flow.outputs.length
        ? `output: ${flow.outputs.map((o) => `${o.name}${o.from ? '←' + o.from : ''}`).join(', ')}`
        : 'output: ∅',
      flow.transition ? `${flow.transition.field} → ${flow.transition.to}` : '状态: 不变',
      flow.emit ? `事件: ${flow.emit}` : '事件: 无',
    ],
  }
}

function compileFlow(flow: FlowAst, byName: Map<string, CompiledFlowHandler>): CompiledFlowHandler {
  const meta = toMeta(flow)

  const flowName = flow.name
  const title = flow.title
  const entity = flow.on ?? 'Document'
  const create = Boolean(flow.create)
  const requireExpr = flow.require?.expr
  const transitionTo = flow.transition?.to
  const emit = flow.emit
  const needs = [...(flow.needs ?? [])]
  const steps = flow.steps.map((s) => ({
    id: s.id,
    label: s.label,
    uses: [...s.uses],
    outputs: s.outputs.map((o) => ({ name: o.name, type: o.type })),
    call: s.call?.name,
    callVersion: s.call?.version,
    command: s.command,
    map: s.map ? {
      item: s.map.item,
      source: s.map.source,
      call: s.map.call.name,
      callVersion: s.map.call.version,
    } : undefined,
  }))
  const inputs = flow.inputs.map((i) => ({ ...i, label: labelOf(i) }))
  const flowOutSpecs = flow.outputs.map((o) => ({ name: o.name, from: o.from }))

  const execute = (rawInput: RunInput, store: DocStore, host: FfiHost, depth = 0): RunResult => {
    for (const port of needs) {
      if (!host.has(port.name, port.version)) {
        return { ok: false, message: `缺少能力 port: ${port.raw}`, mode: 'compile', stepLog: [] }
      }
    }

    const input: RunInput = { ...rawInput }
    for (const f of inputs) {
      if ((f.type === 'Number' || f.type === 'Money') && input[f.name] !== undefined && input[f.name] !== '') {
        input[f.name] = Number(input[f.name])
      }
    }
    for (const f of inputs) {
      const v = input[f.name]
      if (f.required && (v === undefined || v === '')) {
        return { ok: false, message: `${f.label} 为必填`, mode: 'compile', stepLog: [] }
      }
      if (f.min !== undefined && typeof v === 'number' && v < f.min) {
        return { ok: false, message: `${f.label} 不能小于 ${f.min}`, mode: 'compile', stepLog: [] }
      }
    }

    const recordId = String(input.recordId ?? input.id ?? '')
    let record = recordId ? (store.get(recordId) ?? null) : null

    if (!create) {
      if (!recordId) return { ok: false, message: '请选择业务单据', mode: 'compile', stepLog: [] }
      if (!record) return { ok: false, message: `单据不存在: ${recordId}`, mode: 'compile', stepLog: [] }
    }

    const guard = evalRequireExpr(requireExpr, record)
    if (!guard.ok) {
      return { ok: false, message: `编译守卫: ${guard.reason}`, mode: 'compile', stepLog: [] }
    }

    const ctx: StepContext = { ...input }
    if (record) {
      ctx.recordId = record.id
      for (const [k, v] of Object.entries(record.data)) {
        if (ctx[k] === undefined) ctx[k] = v
      }
    }

    const stepLog: RunResult['stepLog'] = []
    const outcome = execFlowBodySync(flowBodyItems(flow), {
      ctx,
      record,
      host,
      flowName,
      mode: 'compile',
      depth,
      onLog: (log) => stepLog.push(log),
      runSubflow: (item, outerCtx) => {
        const target = byName.get(item.flow)
        if (!target) {
          return { ok: false, message: `Program 无 flow ${item.flow}`, mode: 'compile', stepLog: [] }
        }
        const subInput = subflowRunInput(item, outerCtx, target.meta.fields.map((f) => f.name))
        return target.execute(subInput, store, host, depth + 1)
      },
    })
    if (!outcome.ok) {
      return {
        ok: false,
        message: outcome.message ?? 'flow 执行失败',
        mode: 'compile',
        stepLog,
        record: record ?? undefined,
      }
    }

    const applied = applyFlowEffects({
      flowName,
      title,
      entity,
      create,
      input,
      record,
      transitionTo,
      emit,
      stepLog,
      mode: 'compile',
      store,
      ctx,
    })

    const outputs = collectFlowOutputs(flowOutSpecs, ctx, applied.record)

    return {
      ok: true,
      message: `[编译] ${title} 完成`,
      mode: 'compile',
      record: applied.record,
      stepLog,
      outputs,
      event: applied.event,
    }
  }

  const executeAsync = async (
    rawInput: RunInput,
    store: DocStore,
    host: FfiHost | AsyncFfiHost,
    depth = 0,
  ): Promise<RunResult> => {
    for (const port of needs) {
      if (!host.has(port.name, port.version)) {
        return { ok: false, message: `缺少能力 port: ${port.raw}`, mode: 'compile', stepLog: [] }
      }
    }

    const input: RunInput = { ...rawInput }
    for (const f of inputs) {
      if ((f.type === 'Number' || f.type === 'Money') && input[f.name] !== undefined && input[f.name] !== '') {
        input[f.name] = Number(input[f.name])
      }
    }
    for (const f of inputs) {
      const v = input[f.name]
      if (f.required && (v === undefined || v === '')) {
        return { ok: false, message: `${f.label} 为必填`, mode: 'compile', stepLog: [] }
      }
      if (f.min !== undefined && typeof v === 'number' && v < f.min) {
        return { ok: false, message: `${f.label} 不能小于 ${f.min}`, mode: 'compile', stepLog: [] }
      }
    }

    const recordId = String(input.recordId ?? input.id ?? '')
    let record = recordId ? (store.get(recordId) ?? null) : null

    if (!create) {
      if (!recordId) return { ok: false, message: '请选择业务单据', mode: 'compile', stepLog: [] }
      if (!record) return { ok: false, message: `单据不存在: ${recordId}`, mode: 'compile', stepLog: [] }
    }

    const guard = evalRequireExpr(requireExpr, record)
    if (!guard.ok) {
      return { ok: false, message: `编译守卫: ${guard.reason}`, mode: 'compile', stepLog: [] }
    }

    const ctx: StepContext = { ...input }
    if (record) {
      ctx.recordId = record.id
      for (const [k, v] of Object.entries(record.data)) {
        if (ctx[k] === undefined) ctx[k] = v
      }
    }

    const stepLog: RunResult['stepLog'] = []
    const outcome = await execFlowBodyAsync(flowBodyItems(flow), {
      ctx,
      record,
      host,
      flowName,
      mode: 'compile',
      depth,
      onLog: (log) => stepLog.push(log),
      runSubflow: (item: SubflowAst, outerCtx) => {
        const target = byName.get(item.flow)
        if (!target) {
          return { ok: false, message: `Program 无 flow ${item.flow}`, mode: 'compile', stepLog: [] }
        }
        const subInput = subflowRunInput(item, outerCtx, target.meta.fields.map((f) => f.name))
        const result = target.execute(subInput, store, host, depth + 1)
        // subflow inner steps merge into the outer run timeline (PRD 3.13.5)
        for (const log of result.stepLog) stepLog.push(log)
        return result
      },
      runSubflowAsync: async (item, outerCtx) => {
        const target = byName.get(item.flow)
        if (!target) {
          return { ok: false, message: `Program 无 flow ${item.flow}`, mode: 'compile', stepLog: [] }
        }
        const subInput = subflowRunInput(item, outerCtx, target.meta.fields.map((f) => f.name))
        const result = await target.executeAsync(subInput, store, host, depth + 1)
        // subflow inner steps merge into the outer run timeline (PRD 3.13.5)
        for (const log of result.stepLog) stepLog.push(log)
        return result
      },
    })
    if (!outcome.ok) {
      return {
        ok: false,
        message: outcome.message ?? 'flow 执行失败',
        mode: 'compile',
        stepLog,
        record: record ?? undefined,
      }
    }

    const applied = applyFlowEffects({
      flowName,
      title,
      entity,
      create,
      input,
      record,
      transitionTo,
      emit,
      stepLog,
      mode: 'compile',
      store,
      ctx,
    })

    const outputs = collectFlowOutputs(flowOutSpecs, ctx, applied.record)

    return {
      ok: true,
      message: `[编译] ${title} 完成`,
      mode: 'compile',
      record: applied.record,
      stepLog,
      outputs,
      event: applied.event,
    }
  }

  return { meta, execute, executeAsync }
}

function fingerprint(ast: DomainAst): string {
  const flat = flattenDomain(ast)
  const raw = JSON.stringify({
    n: ast.name,
    v: ast.version,
    p: flat.ports.map((p) => p.name),
    f: flat.flows.map((x) => x.name),
    e: flat.entities.map((e) => e.name),
  })
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0
  return `g_${Math.abs(h).toString(16)}`
}

function portMeta(p: PortAst): ProgramPortMeta {
  return {
    name: p.name,
    version: p.version || '1.0.0',
    qualifiedName: p.qualifiedName,
    originDomain: p.originDomain,
    effect: p.effect,
    ...(p.builtin ? { builtin: p.builtin } : {}),
    ...(p.binding ? { binding: p.binding } : {}),
    inFields: p.inFields.map((f) => `${f.name}:${f.type}`),
    outFields: p.outFields.map((f) => `${f.name}:${f.type}`),
  }
}

function emitJsSource(ast: DomainAst, flows: CompiledFlowHandler[], ports: ProgramPortMeta[]): string {
  const lines: string[] = [
    `// Auto-generated by Polaris DSL Compiler`,
    `// domain ${ast.name} v${ast.version}`,
    `// ports 仅保留符号；Host.invoke 在运行时绑定（不内联 CLI）`,
    ``,
    `export const ports = ${JSON.stringify(ports, null, 2)};`,
    ``,
    `export const program = {`,
    `  flows: {`,
  ]
  for (const f of flows) {
    const m = f.meta
    lines.push(`    ${m.name}: function execute(input, store, host) {`)
    lines.push(`      const ctx = { ...input };`)
    for (const s of m.steps) {
      if (s.call) {
        lines.push(
          `      Object.assign(ctx, host.invoke({ port: ${JSON.stringify(s.call)}, input: pick(ctx, ${JSON.stringify(s.uses)}) }).output); // ${s.label}`,
        )
      } else {
        lines.push(`      /* pure */ step_${s.id}(pick(ctx, ${JSON.stringify(s.uses)})); // ${s.label}`)
      }
    }
    lines.push(`      return { ok: true, output: ctx };`)
    lines.push(`    },`)
  }
  lines.push(`  },`)
  lines.push(`};`)
  return lines.join('\n')
}

export function compile(ast: DomainAst): Program {
  const flat = flattenDomain(ast)
  const byName = new Map<string, CompiledFlowHandler>()
  const handlers = flat.flows.map((flow) => compileFlow(flow, byName))
  for (const handler of handlers) byName.set(handler.meta.name, handler)
  const ports = flat.ports.map(portMeta)

  return {
    name: ast.name,
    version: ast.version,
    languageVersion: ast.languageVersion ?? '0.3',
    title: ast.title ?? ast.name,
    description: ast.description,
    fingerprint: fingerprint(ast),
    modules: ast.modules.map((m) => ({
      name: m.name,
      code: m.code,
      title: m.title,
      description: m.description,
      outputs: m.outputs,
      flowNames: m.flows.map((f) => f.name),
    })),
    entityNames: flat.entities.map((e) => e.name),
    ports,
    pipelines: (ast.pipelines ?? []).map((p) => ({
      name: p.name,
      title: p.title,
      steps: [...p.steps],
    })),
    flows: handlers,
    jsSource: emitJsSource(ast, handlers, ports),
    run(flowName, input, store, host) {
      const h = byName.get(flowName)
      if (!h) return { ok: false, message: `Program 无 flow ${flowName}`, mode: 'compile', stepLog: [] }
      return h.execute(input, store, host)
    },
    async runAsync(flowName, input, store, host) {
      const h = byName.get(flowName)
      if (!h) return { ok: false, message: `Program 无 flow ${flowName}`, mode: 'compile', stepLog: [] }
      return h.executeAsync(input, store, host)
    },
  }
}
