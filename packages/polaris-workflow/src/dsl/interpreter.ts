import { flattenDomain, type DomainAst, type FlowAst, type InputFieldAst } from './ast.js'
import type { FfiHost } from './host.js'
import {
  applyFlowEffects,
  collectFlowOutputs,
  evalRequireExpr,
  execStepWithIO,
  type DocStore,
  type RunInput,
  type RunResult,
  type StepContext,
  type StepLog,
} from './runtime.js'

/**
 * Interpreter — 动态 walk AST；call port → host.invoke
 */
export class DslInterpreter {
  constructor(
    public ast: DomainAst,
    public store: DocStore,
    public host: FfiHost,
  ) {}

  load(ast: DomainAst) {
    this.ast = ast
  }

  allFlows(): FlowAst[] {
    return flattenDomain(this.ast).flows
  }

  findFlow(name: string): FlowAst | undefined {
    return this.allFlows().find((f) => f.name === name)
  }

  interpret(flowName: string, rawInput: RunInput): RunResult {
    const flow = this.findFlow(flowName)
    if (!flow) {
      return { ok: false, message: `解释器: AST 中无 flow ${flowName}`, mode: 'interpret', stepLog: [] }
    }

    // needs：能力检查（含版本）
    for (const port of flow.needs) {
      if (!this.host.has(port.name, port.version)) {
        return {
          ok: false,
          message: `缺少能力 port: ${port.raw}（flow.needs）`,
          mode: 'interpret',
          stepLog: [],
        }
      }
    }

    const entity = flow.on ?? 'Document'
    const input = coerce(flow.inputs, rawInput)
    const inputErr = validateInputs(flow.inputs, input)
    if (inputErr) return { ok: false, message: inputErr, mode: 'interpret', stepLog: [] }

    const recordId = String(input.recordId ?? input.id ?? '')
    let record = recordId ? (this.store.get(recordId) ?? null) : null

    if (!flow.create) {
      if (!recordId) return { ok: false, message: '请选择业务单据', mode: 'interpret', stepLog: [] }
      if (!record) return { ok: false, message: `单据不存在: ${recordId}`, mode: 'interpret', stepLog: [] }
      if (record.entity !== entity) {
        return {
          ok: false,
          message: `单据类型不匹配: 需要 ${entity}，实际 ${record.entity}`,
          mode: 'interpret',
          stepLog: [],
        }
      }
    }

    const guard = evalRequireExpr(flow.require?.expr, record)
    if (!guard.ok) {
      return { ok: false, message: `解释守卫: ${guard.reason}`, mode: 'interpret', stepLog: [] }
    }

    const ctx: StepContext = { ...input }
    if (record) {
      ctx.recordId = record.id
      for (const [k, v] of Object.entries(record.data)) {
        if (ctx[k] === undefined) ctx[k] = v
      }
    }

    const stepLog: StepLog[] = []
    for (const step of flow.steps) {
      const log = execStepWithIO(
        {
          id: step.id,
          label: step.label,
          uses: step.uses,
          outputs: step.outputs.map((o) => ({ name: o.name, type: o.type })),
          call: step.call?.name,
          callVersion: step.call?.version,
          map: step.map ? {
            item: step.map.item,
            source: step.map.source,
            call: step.map.call.name,
            callVersion: step.map.call.version,
          } : undefined,
        },
        {
          ctx,
          record,
          host: this.host,
          flowName,
          mode: 'interpret',
        },
      )
      stepLog.push(log)
      if (!log.ok) {
        return {
          ok: false,
          message: log.detail ?? `步骤失败: ${step.label}`,
          mode: 'interpret',
          stepLog,
          record: record ?? undefined,
        }
      }
    }

    const applied = applyFlowEffects({
      flowName,
      title: flow.title,
      entity,
      create: Boolean(flow.create),
      input,
      record,
      transitionTo: flow.transition?.to,
      emit: flow.emit,
      stepLog,
      mode: 'interpret',
      store: this.store,
      ctx,
    })

    const outputs = collectFlowOutputs(
      flow.outputs.map((o) => ({ name: o.name, from: o.from })),
      ctx,
      applied.record,
    )

    return {
      ok: true,
      message: `[解释] ${flow.title} 完成`,
      mode: 'interpret',
      record: applied.record,
      stepLog,
      outputs,
      event: applied.event,
    }
  }
}

function coerce(inputs: InputFieldAst[], raw: RunInput): RunInput {
  const input: RunInput = { ...raw }
  for (const f of inputs) {
    if ((f.type === 'Number' || f.type === 'Money') && input[f.name] !== undefined && input[f.name] !== '') {
      input[f.name] = Number(input[f.name])
    }
  }
  return input
}

function validateInputs(inputs: InputFieldAst[], input: RunInput): string | null {
  for (const f of inputs) {
    const v = input[f.name]
    const label = f.label ?? f.name
    if (f.required && (v === undefined || v === '')) return `${label} 为必填`
    if (f.min !== undefined && typeof v === 'number' && v < f.min) return `${label} 不能小于 ${f.min}`
  }
  return null
}
