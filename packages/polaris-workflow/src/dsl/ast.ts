/**
 * 通用业务 DSL — AST
 * 意义 · 计算 · FFI(port) 三世界；行业 = 域包；跨包 import + port 版本。
 */

export type FieldType = 'ID' | 'String' | 'Number' | 'Money' | 'Boolean' | string

export type PortEffect = 'pure' | 'read' | 'write' | 'ffi' | 'human' | 'time'
export type DomainAccent = 'green' | 'blue' | 'amber'
export type DslLanguageVersion = '0.3' | '0.4-trial' | string

export const DEFAULT_DSL_LANGUAGE_VERSION: DslLanguageVersion = '0.3'
export const TRIAL_DSL_LANGUAGE_VERSION = '0.4-trial'

/** 跨域包导入 */
export interface ImportAst {
  kind: 'Import'
  /** 被导入的 domain 名 */
  domain: string
  /** 版本约束：1.0.0 | 1.0 | ^1.2.0 */
  version: string
  /** 可选别名：符号变为 Alias.Name */
  as?: string
}

/** pipeline 糖：flow 主路径声明（元数据；不替代单 flow 事务语义） */
export interface PipelineAst {
  kind: 'Pipeline'
  name: string
  title?: string
  /** flow 名序列 */
  steps: string[]
}

export interface DomainAst {
  kind: 'Domain'
  name: string
  version: string
  /** Language surface version; domain.version remains the pack version. */
  languageVersion?: DslLanguageVersion
  title?: string
  description?: string
  category?: string
  accent?: DomainAccent
  imports: ImportAst[]
  enums: EnumAst[]
  entities: EntityAst[]
  ports: PortAst[]
  flows: FlowAst[]
  modules: ModuleAst[]
  pipelines: PipelineAst[]
  trials?: TrialAst[]
}

export interface ModuleAst {
  kind: 'Module'
  name: string
  code?: string
  title: string
  description?: string
  outputs: string[]
  entities: EntityAst[]
  enums: EnumAst[]
  ports: PortAst[]
  flows: FlowAst[]
}

export interface EntityAst {
  kind: 'Entity'
  name: string
  fields: FieldAst[]
  module?: string
  /** 来自 import 时的源域包 */
  originDomain?: string
}

export interface FieldAst {
  name: string
  type: FieldType
  optional?: boolean
  defaultValue?: string | number | boolean
}

export interface EnumAst {
  kind: 'Enum'
  name: string
  values: string[]
  module?: string
  originDomain?: string
}

/** FFI 端口：契约 + 版本；不写可执行路径 */
export interface PortAst {
  kind: 'Port'
  name: string
  /** semver，默认 1.0.0 */
  version: string
  inFields: FieldAst[]
  outFields: FieldAst[]
  effect: PortEffect
  /** Optional Polaris built-in binding, for example manual.review. */
  builtin?: string
  /** External tool binding resolved by the host tool inventory. */
  binding?: {
    tool: string
    command?: string
    aliases?: Record<string, string>
  }
  module?: string
  originDomain?: string
  originDomainVersion?: string
  /** 限定名（含 as 前缀），如 Inv.ReserveStock */
  qualifiedName?: string
}

export interface InputFieldAst {
  name: string
  type: FieldType
  required?: boolean
  min?: number
  inputKind?: 'text' | 'textarea'
  label?: string
  placeholder?: string
}

export interface StepOutputAst {
  name: string
  type: FieldType
  optional?: boolean
  label?: string
}

/** port 引用：Name | Name@1.2.0 | Alias.Name | Alias.Name@1.2 */
export interface PortRef {
  raw: string
  /** 未限定名或 Alias.Name */
  name: string
  version?: string
}

export interface StepAst {
  id: string
  label: string
  uses: string[]
  outputs: StepOutputAst[]
  /** 调用的 port（可带 @version） */
  call?: PortRef
  command?: string
}

export interface RequireAst {
  expr: string
}

export interface FlowOutputAst {
  name: string
  type: FieldType
  from?: string
  label?: string
}

export interface FlowAst {
  kind: 'Flow'
  name: string
  title: string
  description?: string
  on?: string
  create?: boolean
  /** port 能力需求（可带 @version） */
  needs: PortRef[]
  inputs: InputFieldAst[]
  outputs: FlowOutputAst[]
  require?: RequireAst
  steps: StepAst[]
  transition?: { field: string; to: string }
  emit?: string
  ui: {
    layout: 'form' | 'wizard'
    primary: string
    icon?: string
  }
  module?: string
}

export type TrialRole = 'processor' | 'developer' | 'critic' | 'validator' | 'sink' | string
export type TrialExecutionClass = 'pure' | 'workspace' | 'ai'
export type TrialIsolation = 'disposable' | 'scoped' | 'none'
export type TrialNetworkPolicy = 'deny' | 'allow'

export interface TrialRetryAst {
  /** Maximum number of invocations of this node in one trial. */
  maxAttempts: number
  /** Delay before an automatic retry after a failed invocation. */
  backoffMs: number
}

export interface TrialNodeAst {
  kind: 'TrialNode'
  id: string
  label: string
  role?: TrialRole
  uses: string[]
  outputs: StepOutputAst[]
  call?: PortRef
  capabilities: string[]
  retry: TrialRetryAst
  timeoutMs?: number
  maxActions?: number
}

export interface TrialEdgeAst {
  kind: 'TrialEdge'
  from: string
  to: string
  /** Restricted boolean expression evaluated against trial context. */
  when?: string
  /** Output name that must be carried as feedback on this edge. */
  feedback?: string
  /** Context name used by the destination node for the feedback value. */
  feedbackAs?: string
  /** Reset the destination node's attempt counter before entering it. */
  resetAttempts?: boolean
}

export interface TrialBudgetAst {
  timeoutMs: number
  maxCost: number
  maxTransitions: number
}

export interface TrialExecutionAst {
  class: TrialExecutionClass
  isolation: TrialIsolation
  network: TrialNetworkPolicy
}

export interface TrialArtifactAst {
  name: string
  type: FieldType
  kind: 'data' | 'report' | 'log' | 'snapshot' | 'script'
  redacted: boolean
}

/** v0.4-trial durable control graph; ordinary flows remain v0.3-compatible. */
export interface TrialAst {
  kind: 'Trial'
  name: string
  title: string
  inputs: InputFieldAst[]
  nodes: TrialNodeAst[]
  edges: TrialEdgeAst[]
  start: string
  terminal: string[]
  budget: TrialBudgetAst
  execution: TrialExecutionAst
  artifacts: TrialArtifactAst[]
}

export interface ParseError {
  message: string
  line?: number
  column?: number
}

export interface ValidationIssue {
  level: 'error' | 'warning'
  code: string
  message: string
  path?: string
}

/** port 存储键 */
export function portKey(name: string, version: string): string {
  return `${name}@${normalizeVersion(version)}`
}

export function normalizeVersion(v: string): string {
  const bare = v.replace(/^\^/, '').trim()
  const parts = bare.split('.').map((x) => x.trim())
  const major = parts[0] && /^\d+$/.test(parts[0]) ? parts[0] : '1'
  const minor = parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : '0'
  const patch = parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : '0'
  return `${major}.${minor}.${patch}`
}

export function parsePortRef(raw: string): PortRef {
  const t = raw.trim()
  const at = t.lastIndexOf('@')
  if (at > 0) {
    return { raw: t, name: t.slice(0, at), version: normalizeVersion(t.slice(at + 1)) }
  }
  return { raw: t, name: t }
}

export function flattenDomain(ast: DomainAst): {
  entities: EntityAst[]
  flows: FlowAst[]
  enums: EnumAst[]
  ports: PortAst[]
} {
  const entities = [...ast.entities]
  const flows = [...ast.flows]
  const enums = [...ast.enums]
  const ports = [...ast.ports]
  for (const m of ast.modules) {
    for (const e of m.entities) entities.push({ ...e, module: m.name })
    for (const f of m.flows) flows.push({ ...f, module: m.name })
    for (const en of m.enums) enums.push({ ...en, module: m.name })
    for (const p of m.ports) ports.push({ ...p, module: m.name })
  }
  return { entities, flows, enums, ports }
}
