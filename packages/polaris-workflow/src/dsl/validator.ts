import {
  flattenDomain,
  type DomainAst,
  type PortAst,
  type PortRef,
  type ValidationIssue,
} from './ast.js'
import { resolvePort } from './resolve.js'

const BUILTIN_TYPES = new Set(['ID', 'String', 'Number', 'Money', 'Boolean', 'Status'])

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
  if (languageVersion !== '0.3' && languageVersion !== '0.4') {
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
    const called: PortRef[] = []

    for (const step of flow.steps) {
      if (step.map) {
        if (!available.has(step.map.source)) {
          push(issues, 'error', 'E_MAP_SOURCE', `map ${step.id} uses unknown collection ${step.map.source}`, `flow.${flow.name}.${step.id}`)
        }
        const port = findPort(flat.ports, step.map.call)
        if (!port) {
          push(issues, 'error', 'E_MAP_PORT', `map ${step.id} references unknown port ${step.map.call.raw}`, `flow.${flow.name}.${step.id}`)
        }
        if (step.call) {
          push(issues, 'error', 'E_MAP_CALL', `map ${step.id} must not also declare call`, `flow.${flow.name}.${step.id}`)
        }
        called.push(step.map.call)
      }
      if (step.uses.length === 0 && !step.call) {
        push(issues, 'warning', 'W_STEP_NO_USES', `step ${step.id} 未声明 uses`, `flow.${flow.name}.${step.id}`)
      }
      for (const u of step.uses) {
        if (!available.has(u)) {
          if (!flow.create) {
            push(
              issues,
              'warning',
              'W_STEP_USES_RECORD',
              `step ${step.id} uses "${u}" 将尝试从单据状态读取`,
              `flow.${flow.name}.${step.id}`,
            )
            available.add(u)
          } else {
            push(
              issues,
              'error',
              'E_STEP_USES',
              `step ${step.id} uses "${u}" 不在 input/上游 out`,
              `flow.${flow.name}.${step.id}`,
            )
          }
        }
      }

      if (step.call) {
        called.push(step.call)
        const port = findPort(flat.ports, step.call)
        if (!port) {
          push(
            issues,
            'error',
            'E_CALL_PORT',
            `step ${step.id} call 未知 port ${step.call.raw}`,
            `flow.${flow.name}.${step.id}`,
          )
        } else {
          if (port.effect === 'ffi') {
            if (!port.binding?.tool) {
              push(
                issues,
                'error',
                'E_FFI_BINDING',
                `call ${step.call.raw} has no external tool binding`,
                `flow.${flow.name}.${step.id}`,
              )
            } else if (toolResolver) {
              const tool = toolResolver.resolve(port.binding.tool)
              if (!tool) {
                push(
                  issues,
                  'error',
                  'E_FFI_TOOL',
                  `call ${step.call.raw} references unavailable tool ${port.binding.tool}`,
                  `flow.${flow.name}.${step.id}`,
                )
              } else {
                const command = step.command ?? port.binding.command
                if (!command) {
                  push(
                    issues,
                    'error',
                    'E_FFI_COMMAND',
                    `call ${step.call.raw} has no external tool command`,
                    `flow.${flow.name}.${step.id}`,
                  )
                } else if (!tool.commands.includes(command)) {
                push(
                  issues,
                  'error',
                  'E_FFI_COMMAND',
                  `call ${step.call.raw} references unavailable command ${command}`,
                  `flow.${flow.name}.${step.id}`,
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
                `flow.${flow.name}.${step.id}`,
              )
            }
          }
          if (step.outputs.length === 0 && port.outFields.length > 0) {
            push(
              issues,
              'warning',
              'W_CALL_OUT',
              `call ${step.call.raw} 有 out，但 step 未声明 output`,
              `flow.${flow.name}.${step.id}`,
            )
          }
        }
      }

      if (step.outputs.length === 0 && !step.call) {
        push(issues, 'warning', 'W_STEP_NO_OUT', `step ${step.id} 未声明 output`, `flow.${flow.name}.${step.id}`)
      }
      for (const o of step.outputs) {
        available.add(o.name)
      }
    }

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

  return { ok: !issues.some((i) => i.level === 'error'), issues }
}
