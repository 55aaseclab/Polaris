import {
  flattenDomain,
  flowBodyItems,
  type ChoicePredicate,
  type DomainAst,
  type FlowAst,
  type FlowBodyItem,
  type PortAst,
  type PortRef,
  type StepAst,
  type ValidationIssue,
} from './ast.js'
import { resolvePort } from './resolve.js'

const BUILTIN_TYPES = new Set(['ID', 'String', 'Number', 'Money', 'Boolean', 'Status'])
/** Subflow expansion depth cap (validator static check). */
const SUBFLOW_MAX_DEPTH = 8

export interface ValidateResult {
  ok: boolean
  issues: ValidationIssue[]
}

export interface ToolResolver {
  resolve(toolId: string): { commands: readonly string[] } | null
}

function push(
  issues: ValidationIssue[],
  level: ValidationIssue['level'],
  code: string,
  message: string,
  path?: string,
) {
  issues.push({ level, code, message, path })
}

function checkRequireExpr(
  expr: string,
  statusValues: string[],
  issues: ValidationIssue[],
  flow: string,
) {
  const trimmed = expr.trim()
  if (!trimmed || trimmed === 'true') return

  const eq = trimmed.match(/^status\s*==\s*([A-Za-z_\u0080-\uffff]\w*)$/u)
  if (eq) {
    if (statusValues.length && !statusValues.includes(eq[1])) {
      push(issues, 'warning', 'W_STATUS_UNKNOWN', `Status "${eq[1]}" not in enums`, `flow.${flow}`)
    }
    return
  }

  const inn = trimmed.match(/^status\s+in\s*\[([^\]]+)\]$/)
  if (inn) {
    for (const p of inn[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (statusValues.length && !statusValues.includes(p)) {
        push(issues, 'warning', 'W_STATUS_UNKNOWN', `Status "${p}" not listed`, `flow.${flow}`)
      }
    }
    return
  }

  push(issues, 'error', 'E_REQUIRE_SYNTAX', `Unsupported require "${expr}"`, `flow.${flow}.require`)
}

function findPort(ports: PortAst[], ref: PortRef): PortAst | null {
  return resolvePort(ports, ref.name, ref.version)
}

export function validate(ast: DomainAst, toolResolver?: ToolResolver): ValidateResult {
  const issues: ValidationIssue[] = []
  if (!ast.name) push(issues, 'error', 'E_DOMAIN_NAME', 'Domain name is required')
  const languageVersion = ast.languageVersion ?? '0.3'
  if (languageVersion !== '0.3' && languageVersion !== '0.4' && languageVersion !== '0.5') {
    push(issues, 'error', 'E_DSL_VERSION', `Unsupported DSL language version ${languageVersion}`)
  }

  const flat = flattenDomain(ast)
  const entityNames = new Set(flat.entities.map((e) => e.name))
  const enumByName = new Map(flat.enums.map((e) => [e.name, e]))
  const allStatusValues = flat.enums.flatMap((e) =>
    e.name.toLowerCase().includes('status') || e.name === 'Status' ? e.values : [],
  )

  // ports：允许同名多版本；键 = qualifiedName|name + version
  const seenExact = new Set<string>()
  for (const p of flat.ports) {
    const q = p.qualifiedName ?? p.name
    const key = `${q}@${p.version}`
    if (seenExact.has(key)) {
      push(issues, 'error', 'E_DUP_PORT', `Duplicate port ${key}`)
    }
    seenExact.add(key)
    if (p.outFields.length === 0) {
      push(issues, 'warning', 'W_PORT_NO_OUT', `port ${q}@${p.version} has empty out`, `port.${q}`)
    }
  }

  const seenEntity = new Set<string>()
  for (const ent of flat.entities) {
    if (seenEntity.has(ent.name)) push(issues, 'error', 'E_DUP_ENTITY', `Duplicate entity ${ent.name}`)
    seenEntity.add(ent.name)
    const fields = new Set<string>()
    for (const f of ent.fields) {
      if (fields.has(f.name)) {
        push(issues, 'error', 'E_DUP_FIELD', `Duplicate field ${f.name}`, `entity.${ent.name}`)
      }
      fields.add(f.name)
      if (!BUILTIN_TYPES.has(f.type) && !enumByName.has(f.type) && !entityNames.has(f.type)) {
        push(issues, 'warning', 'W_TYPE', `Unregistered type ${f.type}`, `entity.${ent.name}.${f.name}`)
      }
    }
  }

  const flowNames = new Set<string>()
  for (const flow of flat.flows) {
    if (flowNames.has(flow.name)) push(issues, 'error', 'E_DUP_FLOW', `Duplicate flow ${flow.name}`)
    flowNames.add(flow.name)
  }
  const flowsByName = new Map(flat.flows.map((flow) => [flow.name, flow]))

  for (const pipe of ast.pipelines ?? []) {
    if (pipe.steps.length < 1) {
      push(issues, 'warning', 'W_PIPELINE_EMPTY', `pipeline ${pipe.name} has no steps`)
    }
    for (const step of pipe.steps) {
      if (!flowNames.has(step)) {
        push(
          issues,
          'error',
          'E_PIPELINE_FLOW',
          `pipeline ${pipe.name} 引用未知 flow ${step}`,
          `pipeline.${pipe.name}`,
        )
      }
    }
  }

  for (const flow of flat.flows) {

    if (flow.on && !entityNames.has(flow.on)) {
      push(issues, 'error', 'E_FLOW_ON', `flow ${flow.name} on unknown entity ${flow.on}`)
    }
    if (flow.require) checkRequireExpr(flow.require.expr, allStatusValues, issues, flow.name)

    for (const n of flow.needs ?? []) {
      if (!findPort(flat.ports, n)) {
        push(
          issues,
          'error',
          'E_NEEDS_PORT',
          `flow ${flow.name} needs unknown port ${n.raw}`,
          `flow.${flow.name}`,
        )
      }
    }

    const inputNames = new Set(flow.inputs.map((i) => i.name))
    inputNames.add('recordId')
    inputNames.add('id')
    const available = new Set<string>(inputNames)
    const guarded = new Set<string>()
    const called: PortRef[] = []

    validateBodyItems(flowBodyItems(flow), {
      flow,
      available,
      guarded,
      called,
      ports: flat.ports,
      flowNames,
      flowsForSubflow: flowsByName,
      issues,
      toolResolver,
    })

    for (const c of called) {
      if (flow.needs?.length) {
        const covered = flow.needs.some((n) => {
          if (n.name !== c.name && n.name !== c.name.split('.').pop()) return false
          if (c.version && n.version && c.version !== n.version) return false
          return true
        })
        // also allow needs bare name covering call Alias.Name if names equal end
        const covered2 = flow.needs.some((n) => n.name === c.name || c.name.endsWith('.' + n.name) || n.name.endsWith('.' + c.name))
        if (!covered && !covered2) {
          push(
            issues,
            'warning',
            'W_CALL_NOT_IN_NEEDS',
            `step call ${c.raw} 未列入 flow.needs`,
            `flow.${flow.name}`,
          )
        }
      }
    }

    if (flow.outputs.length === 0) {
      push(issues, 'warning', 'W_FLOW_NO_OUT', `flow ${flow.name} 未声明 output`, `flow.${flow.name}`)
    }
    for (const o of flow.outputs) {
      const src = o.from ?? o.name
      if (src === 'record.id' || src === 'record.status') continue
      if (guarded.has(src) || guarded.has(o.name)) {
        push(
          issues,
          'error',
          'E_CHOICE_NOT_EXHAUSTIVE',
          `flow output "${o.name}" from "${src}" 在 choice 分支中并非全路径产出`,
          `flow.${flow.name}.output`,
        )
        continue
      }
      if (!available.has(src) && !available.has(o.name)) {
        push(
          issues,
          'error',
          'E_FLOW_OUT',
          `flow output "${o.name}" from "${src}" 无法解析`,
          `flow.${flow.name}.output`,
        )
      }
    }
  }

  checkSubflowGraph(flat.flows, issues)

  return { ok: !issues.some((i) => i.level === 'error'), issues }
}

interface BodyWalkState {
  flow: FlowAst
  available: Set<string>
  /** Fields not produced on every choice path; a downstream use is an error. */
  guarded: Set<string>
  called: PortRef[]
  ports: PortAst[]
  flowNames: Set<string>
  flowsForSubflow: Map<string, FlowAst>
  issues: ValidationIssue[]
  toolResolver?: ToolResolver
}

/** DSL v2 structured body validation (PRD 3.13.5): sequence/parallel/choice/forEach/while/subflow. */
function validateBodyItems(items: FlowBodyItem[], state: BodyWalkState): void {
  const { flow, available, guarded, issues } = state
  const flowPath = `flow.${flow.name}`
  for (const item of items) {
    if (item.kind === 'Step') {
      validateStepFields(item.step, state)
      continue
    }
    if (item.kind === 'Parallel') {
      const path = `${flowPath}.${item.id}`
      if (item.branches.length < 2) {
        push(issues, 'error', 'E_PARALLEL_BRANCHES', `parallel ${item.id} 至少需要 2 个分支`, path)
      }
      const seen = new Set<string>()
      for (const branch of item.branches) {
        if (seen.has(branch.id)) {
          push(issues, 'error', 'E_PARALLEL_BRANCH_DUP', `parallel ${item.id} 分支 id 重复: ${branch.id}`, path)
        }
        seen.add(branch.id)
      }
      // Join completeness: the join point collects every branch's outputs; downstream may use any of them.
      for (const branch of item.branches) {
        const branchAvailable = new Set(available)
        validateBodyItems(branch.body, { ...state, available: branchAvailable })
        for (const name of branchAvailable) available.add(name)
      }
      continue
    }
    if (item.kind === 'Choice') {
      const path = `${flowPath}.${item.id}`
      const elseCount = item.branches.filter((branch) => branch.when === undefined).length
      if (elseCount > 1) {
        push(issues, 'error', 'E_CHOICE_ELSE', `choice ${item.id} 最多一个 else 分支`, path)
      }
      const branchOutputs: Set<string>[] = []
      let hasElse = false
      for (const [index, branch] of item.branches.entries()) {
        const branchPath = `${path}.when-${index + 1}`
        if (branch.when === undefined) {
          hasElse = true
          const elseAvailable = new Set(available)
          validateBodyItems(branch.body, { ...state, available: elseAvailable })
          branchOutputs.push(elseAvailable)
          continue
        }
        checkPredicate(branch.when, available, issues, branchPath, 'choice')
        const branchAvailable = new Set(available)
        validateBodyItems(branch.body, { ...state, available: branchAvailable })
        branchOutputs.push(branchAvailable)
      }
      // Join completeness (choice side): only fields produced on every branch (else included) are safe downstream.
      const before = new Set(available)
      const union = new Set<string>()
      for (const outputs of branchOutputs) {
        for (const name of outputs) union.add(name)
      }
      let safe = new Set<string>()
      if (hasElse && branchOutputs.length > 0) {
        safe = branchOutputs.reduce((acc, outputs) => new Set([...acc].filter((name) => outputs.has(name))))
      }
      for (const name of union) {
        available.add(name)
        if (!safe.has(name) && !before.has(name)) guarded.add(name)
      }
      continue
    }
    if (item.kind === 'ForEach') {
      const path = `${flowPath}.${item.id}`
      if (!available.has(item.source)) {
        push(issues, 'error', 'E_FOREACH_SOURCE', `forEach ${item.id} 源字段 ${item.source} 不在 input/上游 out`, path)
      }
      if (item.maxInFlight !== undefined && (!Number.isInteger(item.maxInFlight) || item.maxInFlight < 1)) {
        push(issues, 'error', 'E_FOREACH_MAX_IN_FLIGHT', `forEach ${item.id} maxInFlight 必须是正整数`, path)
      }
      const bodyAvailable = new Set(available)
      bodyAvailable.add(item.item)
      validateBodyItems(item.body, { ...state, available: bodyAvailable })
      for (const name of bodyAvailable) available.add(name)
      continue
    }
    if (item.kind === 'While') {
      const path = `${flowPath}.${item.id}`
      // The while condition reads inputs and completed step outputs only; no termination check (PRD 3.13.3).
      checkPredicate(item.when, available, issues, path, 'while')
      const bodyAvailable = new Set(available)
      validateBodyItems(item.body, { ...state, available: bodyAvailable })
      for (const name of bodyAvailable) available.add(name)
      continue
    }
    // Subflow: the target flow's outputs are available downstream.
    const path = `${flowPath}.${item.id}`
    const target = state.flowNames.has(item.flow) ? findFlowByName(state, item.flow) : undefined
    if (!target) {
      push(issues, 'error', 'E_SUBFLOW_UNKNOWN', `subflow ${item.id} 引用未知 flow ${item.flow}`, path)
      continue
    }
    if (item.input) {
      for (const [param, ref] of Object.entries(item.input)) {
        if (!target.inputs.some((input) => input.name === param)) {
          push(issues, 'error', 'E_SUBFLOW_INPUT_UNKNOWN', `subflow ${item.id} 传入未知输入 ${param}（flow ${item.flow}）`, path)
        }
        if (!available.has(ref)) {
          push(issues, 'error', 'E_SUBFLOW_INPUT_SOURCE', `subflow ${item.id} 输入 ${param} 引用的源字段 ${ref} 不在 input/上游 out`, path)
        }
      }
    }
    for (const output of target.outputs) {
      available.add(output.name)
    }
  }
}

function findFlowByName(state: BodyWalkState, name: string): FlowAst | undefined {
  return state.flowsForSubflow.get(name)
}

/** Single-step checks (v1 semantics kept): map/uses/call/outputs plus choice-guarded fields. */
function validateStepFields(step: StepAst, state: BodyWalkState): void {
  const { flow, available, guarded, called, ports, issues, toolResolver } = state
  const stepPath = `flow.${flow.name}.${step.id}`
  if (step.map) {
    if (!available.has(step.map.source)) {
      push(issues, 'error', 'E_MAP_SOURCE', `map ${step.id} uses unknown collection ${step.map.source}`, stepPath)
    }
    const port = findPort(ports, step.map.call)
    if (!port) {
      push(issues, 'error', 'E_MAP_PORT', `map ${step.id} references unknown port ${step.map.call.raw}`, stepPath)
    }
    if (step.call) {
      push(issues, 'error', 'E_MAP_CALL', `map ${step.id} must not also declare call`, stepPath)
    }
    called.push(step.map.call)
  }
  if (step.uses.length === 0 && !step.call) {
    push(issues, 'warning', 'W_STEP_NO_USES', `step ${step.id} 未声明 uses`, stepPath)
  }
  for (const u of step.uses) {
    if (guarded.has(u)) {
      push(
        issues,
        'error',
        'E_CHOICE_NOT_EXHAUSTIVE',
        `step ${step.id} uses "${u}" 在 choice 分支中并非全路径产出`,
        stepPath,
      )
      continue
    }
    if (!available.has(u)) {
      if (!flow.create) {
        push(
          issues,
          'warning',
          'W_STEP_USES_RECORD',
          `step ${step.id} uses "${u}" 将尝试从单据状态读取`,
          stepPath,
        )
        available.add(u)
      } else {
        push(
          issues,
          'error',
          'E_STEP_USES',
          `step ${step.id} uses "${u}" 不在 input/上游 out`,
          stepPath,
        )
      }
    }
  }

  if (step.call) {
    called.push(step.call)
    const port = findPort(ports, step.call)
    if (!port) {
      push(
        issues,
        'error',
        'E_CALL_PORT',
        `step ${step.id} call 未知 port ${step.call.raw}`,
        stepPath,
      )
    } else {
      if (port.effect === 'ffi') {
        if (!port.binding?.tool) {
          push(
            issues,
            'error',
            'E_FFI_BINDING',
            `call ${step.call.raw} has no external tool binding`,
            stepPath,
          )
        } else if (toolResolver) {
          const tool = toolResolver.resolve(port.binding.tool)
          if (!tool) {
            push(
              issues,
              'error',
              'E_FFI_TOOL',
              `call ${step.call.raw} references unavailable tool ${port.binding.tool}`,
              stepPath,
            )
          } else {
            const command = step.command ?? port.binding.command
            if (!command) {
              push(
                issues,
                'error',
                'E_FFI_COMMAND',
                `call ${step.call.raw} has no external tool command`,
                stepPath,
              )
            } else if (!tool.commands.includes(command)) {
              push(
                issues,
                'error',
                'E_FFI_COMMAND',
                `call ${step.call.raw} references unavailable command ${command}`,
                stepPath,
              )
            }
          }
        }
      }
      for (const f of port.inFields) {
        if (!f.optional && !step.uses.includes(f.name) && !available.has(f.name)) {
          push(
            issues,
            'warning',
            'W_CALL_IN',
            `call ${step.call.raw} 期望 in.${f.name}，step uses 未列出`,
            stepPath,
          )
        }
      }
      if (step.outputs.length === 0 && port.outFields.length > 0) {
        push(
          issues,
          'warning',
          'W_CALL_OUT',
          `call ${step.call.raw} 有 out，但 step 未声明 output`,
          stepPath,
        )
      }
    }
  }

  if (step.outputs.length === 0 && !step.call) {
    push(issues, 'warning', 'W_STEP_NO_OUT', `step ${step.id} 未声明 output`, stepPath)
  }
  for (const o of step.outputs) {
    available.add(o.name)
  }
}

function checkPredicate(
  pred: ChoicePredicate,
  available: Set<string>,
  issues: ValidationIssue[],
  path: string,
  kind: 'choice' | 'while',
): void {
  const code = kind === 'choice' ? 'E_CHOICE_FIELD' : 'E_WHILE_FIELD'
  const label = kind === 'choice' ? 'choice' : 'while'
  if (!available.has(pred.field)) {
    push(issues, 'error', code, `${label} 条件字段 ${pred.field} 不在 input/上游 out`, path)
  }
  if (pred.op === 'in' && (pred.values ?? []).length === 0) {
    push(issues, 'error', 'E_CHOICE_PREDICATE', `${label} 谓词 in 列表为空`, path)
  }
  if (pred.op !== 'in' && pred.op !== 'truthy' && pred.value === undefined) {
    push(issues, 'error', 'E_CHOICE_PREDICATE', `${label} 谓词缺少比较值`, path)
  }
}

/** subflow reference graph: cycle detection + expansion depth cap (PRD 3.13.2) */
function checkSubflowGraph(flows: FlowAst[], issues: ValidationIssue[]): void {
  const deps = new Map<string, string[]>()
  const targetsIn = (items: FlowBodyItem[]): string[] => {
    const found: string[] = []
    for (const item of items) {
      if (item.kind === 'Step') continue
      if (item.kind === 'Subflow') found.push(item.flow)
      else if (item.kind === 'Parallel') for (const b of item.branches) found.push(...targetsIn(b.body))
      else if (item.kind === 'Choice') for (const b of item.branches) found.push(...targetsIn(b.body))
      else found.push(...targetsIn(item.body))
    }
    return found
  }
  for (const flow of flows) {
    deps.set(flow.name, [...new Set(targetsIn(flowBodyItems(flow)))])
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const depth = new Map<string, number>()
  const reported = new Set<string>()
  const visit = (name: string, path: string[]): number => {
    const mark = state.get(name)
    if (mark === 'visiting') {
      const chain = [...path.slice(path.indexOf(name)), name].join(' → ')
      if (!reported.has(chain)) {
        reported.add(chain)
        push(issues, 'error', 'E_SUBFLOW_CYCLE', `subflow 循环调用: ${chain}`, `flow.${name}`)
      }
      return 0
    }
    if (mark === 'done') return depth.get(name) ?? 0
    state.set(name, 'visiting')
    let maxChild = 0
    for (const target of deps.get(name) ?? []) {
      if (!deps.has(target)) continue
      maxChild = Math.max(maxChild, visit(target, [...path, name]))
    }
    state.set(name, 'done')
    const own = maxChild + 1
    depth.set(name, own)
    if (own > SUBFLOW_MAX_DEPTH) {
      push(issues, 'error', 'E_SUBFLOW_DEPTH', `subflow 展开深度超过上限 ${SUBFLOW_MAX_DEPTH}`, `flow.${name}`)
    }
    return own
  }
  for (const flow of flows) visit(flow.name, [])
}
