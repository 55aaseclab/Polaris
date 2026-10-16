import { flattenDomain, flowBodyItems, type DomainAst, type FlowAst, type InputFieldAst } from './ast.js'
import type { FfiHost } from './host.js'
import {
  applyFlowEffects,
  collectFlowOutputs,
  evalRequireExpr,
  type DocStore,
  type RunInput,
  type RunResult,
  type StepContext,
  type StepLog,
} from './runtime.js'
import { execFlowBodySync, subflowRunInput, type FlowBodyEnv } from './structure.js'

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

  interpret(flowName: string, rawInput: RunInput, depth = 0): RunResult {
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
    const env: FlowBodyEnv = {
      ctx,
      record,
      host: this.host,
      flowName,
      mode: 'interpret',
      depth,
      onLog: (log) => stepLog.push(log),
      runSubflow: (item, outerCtx) => {
        const target = this.findFlow(item.flow)
        if (!target) {
          return { ok: false, message: `解释器: AST 中无 flow ${item.flow}`, mode: 'interpret', stepLog: [] }
        }
        const subInput = subflowRunInput(item, outerCtx, target.inputs.map((i) => i.name))
        const result = this.interpret(item.flow, subInput, depth + 1)
        // subflow inner steps merge into the outer run timeline (PRD 3.13.5)
        for (const log of result.stepLog) stepLog.push(log)
        return result
      },
    }
    const outcome = execFlowBodySync(flowBodyItems(flow), env)
    if (!outcome.ok) {
      return {
        ok: false,
        message: outcome.message ?? 'flow 执行失败',
        mode: 'interpret',
        stepLog,
        record: record ?? undefined,
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
