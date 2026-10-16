/**
 * DSL v2 structured flow-body executor (PRD 3.13).
 * sequence / parallel (fork-join) / choice / forEach / while / subflow.
 * Orchestration lives in the DSL; computation stays in tools.
 */
import type { ChoicePredicate, FlowBodyItem, ForEachAst, ParallelAst, ChoiceAst, WhileAst, SubflowAst, StepAst } from './ast.js'
import {
  execStepWithIO,
  execStepWithIOAsync,
  resolveListSource,
  type AsyncStepExecOptions,
  type CtxValue,
  type RunInput,
  type RunResult,
  type StepContext,
  type StepGroupLog,
  type StepLog,
  type StepSpec,
} from './runtime.js'

/** Runtime backstop for unbounded while loops (PRD 3.13.3): termination
 * stop-loss belongs to the platform's step budget/timeout; this guard only
 * protects the pure runtime from a pathological .ord whose condition never
 * turns false. It is not a static termination check. */
export const WHILE_RUNTIME_MAX_ITERATIONS = 10_000

/** Runtime recursion cap for subflow expansion; the validator caps static depth. */
export const SUBFLOW_RUNTIME_MAX_DEPTH = 16

export interface FlowBodyEnv {
  ctx: StepContext
  record: AsyncStepExecOptions['record']
  host?: AsyncStepExecOptions['host']
  flowName: string
  mode: 'interpret' | 'compile'
  /** Subflow recursion depth (0-based; the host increments per level). */
  depth: number
  /** Step-log sink (receives construct grouping). */
  onLog: (log: StepLog) => void
  /** Subflow callback (sync path; interpreter and compiled execute recurse synchronously). */
  runSubflow: (item: SubflowAst, ctx: StepContext) => RunResult
  /** Async subflow callback (compiled executeAsync; falls back to runSubflow). */
  runSubflowAsync?: (item: SubflowAst, ctx: StepContext) => Promise<RunResult>
}

export interface BodyExecResult {
  ok: boolean
  message?: string
}

function stepSpec(step: StepAst): StepSpec {
  return {
    id: step.id,
    label: step.label,
    uses: step.uses,
    outputs: step.outputs.map((o) => ({ name: o.name, type: o.type })),
    call: step.call?.name,
    callVersion: step.call?.version,
    command: step.command,
    map: step.map
      ? {
          item: step.map.item,
          source: step.map.source,
          call: step.map.call.name,
          callVersion: step.map.call.version,
        }
      : undefined,
  }
}

function predicateText(pred: ChoicePredicate): string {
  const valueText = typeof pred.value === "string" ? `"${pred.value}"` : String(pred.value)
  switch (pred.op) {
    case 'truthy':
      return pred.field
    case 'in':
      return `${pred.field} in [${(pred.values ?? []).join(', ')}]`
    default:
      return `${pred.field} ${pred.op === 'eq' ? '==' : pred.op === 'ne' ? '!=' : pred.op} ${valueText}`
  }
}

function looseEq(a: CtxValue, b: string | number | boolean | undefined): boolean {
  return String(a) === String(b)
}

/** Predicate evaluation reads ctx only (flow input + completed step outputs, PRD 3.13.3). */
export function evalPredicate(pred: ChoicePredicate, ctx: StepContext): boolean {
  const v = ctx[pred.field]
  switch (pred.op) {
    case 'truthy':
      return v !== undefined && v !== null && v !== '' && v !== false
    case 'eq':
      return looseEq(v, pred.value)
    case 'ne':
      return !looseEq(v, pred.value)
    case 'gt':
      return Number(v) > Number(pred.value)
    case 'lt':
      return Number(v) < Number(pred.value)
    case 'ge':
      return Number(v) >= Number(pred.value)
    case 'le':
      return Number(v) <= Number(pred.value)
    case 'in':
      return (pred.values ?? []).map(String).includes(String(v))
  }
}

function iterationCtx(source: unknown, itemName: string, base: StepContext): StepContext {
  const ctx: StepContext = { ...base }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') ctx[key] = value
    }
  }
  ctx[itemName] = JSON.stringify(source)
  return ctx
}

/** Subflow input: explicit mapping wins; otherwise copy outer ctx entries by the target's input names. */
export function subflowRunInput(item: SubflowAst, outerCtx: StepContext, inputNames: string[]): RunInput {
  const input: RunInput = {}
  if (item.input) {
    for (const [param, ref] of Object.entries(item.input)) {
      const v = outerCtx[ref]
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') input[param] = v
    }
  } else {
    for (const name of inputNames) {
      const v = outerCtx[name]
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') input[name] = v
    }
  }
  if (outerCtx.recordId !== undefined) input.recordId = outerCtx.recordId
  return input
}

export async function execFlowBodyAsync(
  items: FlowBodyItem[],
  env: FlowBodyEnv,
  group?: StepGroupLog,
): Promise<BodyExecResult> {
  for (const item of items) {
    if (item.kind === 'Step') {
      const log = await execStepWithIOAsync(stepSpec(item.step), {
        ctx: env.ctx,
        record: env.record,
        host: env.host,
        flowName: env.flowName,
        mode: env.mode,
      })
      if (group) log.group = group
      env.onLog(log)
      if (!log.ok) return { ok: false, message: log.detail ?? `步骤失败: ${item.step.label}` }
      continue
    }
    if (item.kind === 'Parallel') {
      const failed = await runParallelAsync(item, env)
      if (failed) return { ok: false, message: failed }
      continue
    }
    if (item.kind === 'Choice') {
      const failed = await runChoiceAsync(item, env)
      if (failed) return { ok: false, message: failed }
      continue
    }
    if (item.kind === 'ForEach') {
      const failed = await runForEachAsync(item, env)
      if (failed) return { ok: false, message: failed }
      continue
    }
    if (item.kind === 'While') {
      const failed = await runWhileAsync(item, env)
      if (failed) return { ok: false, message: failed }
      continue
    }
    const failed = await runSubflowAsync(item, env)
    if (failed) return { ok: false, message: failed }
  }
  return { ok: true }
}

export function execFlowBodySync(
  items: FlowBodyItem[],
  env: FlowBodyEnv,
  group?: StepGroupLog,
): BodyExecResult {
  for (const item of items) {
    if (item.kind === 'Step') {
      const log = execStepWithIO(stepSpec(item.step), {
        ctx: env.ctx,
        record: env.record,
        host: env.host,
        flowName: env.flowName,
        mode: env.mode,
      })
      if (group) log.group = group
      env.onLog(log)
      if (!log.ok) return { ok: false, message: log.detail ?? `步骤失败: ${item.step.label}` }
      continue
    }
    if (item.kind === 'Parallel') {
      // Sync execution: branches run sequentially in declared order; join semantics unchanged (all branches arrive first).
      for (const branch of item.branches) {
        const result = execFlowBodySync(branch.body, env, { kind: 'parallel', id: item.id, branch: branch.id })
        if (!result.ok) return result
      }
      continue
    }
    if (item.kind === 'Choice') {
      const failed = runChoiceSync(item, env)
      if (failed) return { ok: false, message: failed }
      continue
    }
    if (item.kind === 'ForEach') {
      const failed = runForEachSync(item, env)
      if (failed) return { ok: false, message: failed }
      continue
    }
    if (item.kind === 'While') {
      const failed = runWhileSync(item, env)
      if (failed) return { ok: false, message: failed }
      continue
    }
    const failed = runSubflowSync(item, env)
    if (failed) return { ok: false, message: failed }
  }
  return { ok: true }
}

async function runParallelAsync(item: ParallelAst, env: FlowBodyEnv): Promise<string | undefined> {
  const outcomes = await Promise.all(
    item.branches.map(async (branch) =>
      execFlowBodyAsync(branch.body, env, { kind: 'parallel', id: item.id, branch: branch.id }),
    ),
  )
  const failed = outcomes.find((outcome) => !outcome.ok)
  return failed?.message
}

/** Choice decision: first branch whose predicate holds; otherwise else; none when both are absent. */
function decideChoice(item: ChoiceAst, env: FlowBodyEnv): {
  index: number
  branchName: string
  whenText: string
  branch?: ChoiceAst['branches'][number]
} {
  const taken = item.branches.findIndex((branch) => branch.when !== undefined && evalPredicate(branch.when, env.ctx))
  const elseIndex = item.branches.findIndex((branch) => branch.when === undefined)
  const index = taken >= 0 ? taken : elseIndex
  const branchName = taken >= 0 ? `when-${taken + 1}` : index >= 0 ? 'else' : 'none'
  const branch = index >= 0 ? item.branches[index] : undefined
  const whenText = branch
    ? (taken >= 0 && branch.when ? predicateText(branch.when) : 'else')
    : item.id
  env.onLog({
    id: item.id,
    label: whenText,
    ok: true,
    detail: `choice ${branchName}`,
    group: { kind: 'choice', id: item.id, branch: branchName, when: whenText },
  })
  return { index, branchName, whenText, branch }
}

function runChoiceSync(item: ChoiceAst, env: FlowBodyEnv): string | undefined {
  const { branchName, whenText, branch } = decideChoice(item, env)
  if (!branch) return undefined
  const result = execFlowBodySync(
    branch.body,
    env,
    { kind: 'choice', id: item.id, branch: branchName, when: whenText },
  )
  return result.ok ? undefined : result.message
}

async function runChoiceAsync(item: ChoiceAst, env: FlowBodyEnv): Promise<string | undefined> {
  const { branchName, whenText, branch } = decideChoice(item, env)
  if (!branch) return undefined
  const result = await execFlowBodyAsync(
    branch.body,
    env,
    { kind: 'choice', id: item.id, branch: branchName, when: whenText },
  )
  return result.ok ? undefined : result.message
}

async function runForEachAsync(item: ForEachAst, env: FlowBodyEnv): Promise<string | undefined> {
  const source = resolveListSource(env.host, env.ctx[item.source])
  if (!source) return `forEach source ${item.source} 不是列表产物`
  const maxInFlight = Math.max(1, item.maxInFlight ?? 1)
  const collected = new Map<string, CtxValue[]>()
  const runItem = async (index: number): Promise<string | undefined> => {
    const logs: StepLog[] = []
    const iterCtx = iterationCtx(source[index], item.item, env.ctx)
    const result = await execFlowBodyAsync(
      item.body,
      { ...env, ctx: iterCtx, onLog: (log) => { logs.push(log); env.onLog(log) } },
      { kind: 'forEach', id: item.id, iteration: index + 1 },
    )
    if (!result.ok) return result.message
    for (const log of logs) {
      if (!log.produced) continue
      for (const [key, value] of Object.entries(log.produced)) {
        const list = collected.get(key) ?? []
        list.push(value)
        collected.set(key, list)
      }
    }
    return undefined
  }
  for (let start = 0; start < source.length; start += maxInFlight) {
    const chunk = source.slice(start, start + maxInFlight)
    const messages = await Promise.all(chunk.map((_, offset) => runItem(start + offset)))
    const failed = messages.find((message) => message !== undefined)
    if (failed !== undefined) return failed
  }
  for (const [key, values] of collected) {
    env.ctx[key] = JSON.stringify(values)
  }
  return undefined
}

function runForEachSync(item: ForEachAst, env: FlowBodyEnv): string | undefined {
  const source = resolveListSource(env.host, env.ctx[item.source])
  if (!source) return `forEach source ${item.source} 不是列表产物`
  const collected = new Map<string, CtxValue[]>()
  for (const [index, entry] of source.entries()) {
    const logs: StepLog[] = []
    const iterCtx = iterationCtx(entry, item.item, env.ctx)
    const result = execFlowBodySync(
      item.body,
      { ...env, ctx: iterCtx, onLog: (log) => { logs.push(log); env.onLog(log) } },
      { kind: 'forEach', id: item.id, iteration: index + 1 },
    )
    if (!result.ok) return result.message
    for (const log of logs) {
      if (!log.produced) continue
      for (const [key, value] of Object.entries(log.produced)) {
        const list = collected.get(key) ?? []
        list.push(value)
        collected.set(key, list)
      }
    }
  }
  for (const [key, values] of collected) {
    env.ctx[key] = JSON.stringify(values)
  }
  return undefined
}

async function runWhileAsync(item: WhileAst, env: FlowBodyEnv): Promise<string | undefined> {
  let iteration = 0
  while (evalPredicate(item.when, env.ctx)) {
    iteration += 1
    if (iteration > WHILE_RUNTIME_MAX_ITERATIONS) {
      return `while 迭代超过运行时上限 ${WHILE_RUNTIME_MAX_ITERATIONS}`
    }
    const result = await execFlowBodyAsync(item.body, env, { kind: 'while', id: item.id, iteration })
    if (!result.ok) return result.message
  }
  return undefined
}

function runWhileSync(item: WhileAst, env: FlowBodyEnv): string | undefined {
  let iteration = 0
  while (evalPredicate(item.when, env.ctx)) {
    iteration += 1
    if (iteration > WHILE_RUNTIME_MAX_ITERATIONS) {
      return `while 迭代超过运行时上限 ${WHILE_RUNTIME_MAX_ITERATIONS}`
    }
    const result = execFlowBodySync(item.body, env, { kind: 'while', id: item.id, iteration })
    if (!result.ok) return result.message
  }
  return undefined
}

async function runSubflowAsync(item: SubflowAst, env: FlowBodyEnv): Promise<string | undefined> {
  if (env.depth >= SUBFLOW_RUNTIME_MAX_DEPTH) {
    return `subflow 展开超过运行时深度上限 ${SUBFLOW_RUNTIME_MAX_DEPTH}`
  }
  const result = env.runSubflowAsync
    ? await env.runSubflowAsync(item, env.ctx)
    : env.runSubflow(item, env.ctx)
  env.onLog({
    id: item.id,
    label: item.flow,
    ok: result.ok,
    detail: result.ok ? `subflow ${item.flow} 完成` : result.message ?? `subflow ${item.flow} 失败`,
    group: { kind: 'subflow', id: item.id },
  })
  if (!result.ok) return result.message ?? `subflow ${item.flow} 失败`
  for (const [key, value] of Object.entries(result.outputs ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') env.ctx[key] = value
  }
  return undefined
}

function runSubflowSync(item: SubflowAst, env: FlowBodyEnv): string | undefined {
  if (env.depth >= SUBFLOW_RUNTIME_MAX_DEPTH) {
    return `subflow 展开超过运行时深度上限 ${SUBFLOW_RUNTIME_MAX_DEPTH}`
  }
  const result = env.runSubflow(item, env.ctx)
  env.onLog({
    id: item.id,
    label: item.flow,
    ok: result.ok,
    detail: result.ok ? `subflow ${item.flow} 完成` : result.message ?? `subflow ${item.flow} 失败`,
    group: { kind: 'subflow', id: item.id },
  })
  if (!result.ok) return result.message ?? `subflow ${item.flow} 失败`
  for (const [key, value] of Object.entries(result.outputs ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') env.ctx[key] = value
  }
  return undefined
}
