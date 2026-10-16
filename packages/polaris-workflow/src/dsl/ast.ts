/**
 * Polaris DSL — AST
 * 意义 · 计算 · FFI(port) 三世界；行业 = 域包；跨包 import + port 版本。
 */

export type FieldType = 'ID' | 'String' | 'Number' | 'Money' | 'Boolean' | string

export type PortEffect = 'pure' | 'read' | 'write' | 'ffi' | 'human' | 'time'
export type DomainAccent = 'green' | 'blue' | 'amber'
export type DslLanguageVersion = '0.3' | '0.4' | '0.5' | string

export const DEFAULT_DSL_LANGUAGE_VERSION: DslLanguageVersion = '0.3'
/** DSL v2 structured control flow (PRD 3.13). */
export const DSL_V2_LANGUAGE_VERSION: DslLanguageVersion = '0.5'

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

export interface MapAst {
  item: string
  source: string
  call: PortRef
}

export interface StepAst {
  id: string
  label: string
  uses: string[]
  outputs: StepOutputAst[]
  /** 调用的 port（可带 @version） */
  call?: PortRef
  command?: string
  map?: MapAst
  /** DSL v2 step-level policy (PRD 3.10): the platform host enforces it; the DSL only declares. */
  timeoutMs?: number
  budgetUsd?: number
}

/** DSL v2 predicate (PRD 3.13.2/3.13.3): a field reference plus a comparison operator. */
export interface ChoicePredicate {
  /** A flow input field or a completed step's output field. */
  field: string
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'in' | 'truthy'
  value?: string | number | boolean
  values?: string[]
}

export interface ParallelBranchAst {
  id: string
  label?: string
  body: FlowBodyItem[]
}

export interface ParallelAst {
  kind: 'Parallel'
  /** Construct instance id (numbered at parse time, e.g. parallel-1). */
  id: string
  branches: ParallelBranchAst[]
}

export interface ChoiceBranchAst {
  /** A branch without a when predicate is the else branch. */
  when?: ChoicePredicate
  body: FlowBodyItem[]
}

export interface ChoiceAst {
  kind: 'Choice'
  id: string
  branches: ChoiceBranchAst[]
}

export interface ForEachAst {
  kind: 'ForEach'
  id: string
  /** Iteration variable name. */
  item: string
  /** List artifact field (a JSON collection in ctx). */
  source: string
  /** Concurrency cap (defaults to 1, sequential). */
  maxInFlight?: number
  body: FlowBodyItem[]
}

export interface WhileAst {
  kind: 'While'
  id: string
  when: ChoicePredicate
  body: FlowBodyItem[]
}

export interface SubflowAst {
  kind: 'Subflow'
  id: string
  /** Target flow name (same domain pack). */
  flow: string
  /** Input mapping: the subflow's input name to an outer ctx field. */
  input?: Record<string, string>
}

export type FlowBodyItem =
  | { kind: 'Step'; step: StepAst }
  | ParallelAst
  | ChoiceAst
  | ForEachAst
  | WhileAst
  | SubflowAst

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
  /** v1 linear view: the plain steps of body (back-compat; v2 constructs are not listed). */
  steps: StepAst[]
  /** DSL v2 structured body (PRD 3.13); when absent, steps is the linear body. */
  body?: FlowBodyItem[]
  transition?: { field: string; to: string }
  emit?: string
  ui: {
    layout: 'form' | 'wizard'
    primary: string
    icon?: string
  }
  module?: string
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

/** The flow's structured body: v2 uses flow.body; v1 (hand-built ASTs without body) wraps steps as a linear body. */
export function flowBodyItems(flow: FlowAst): FlowBodyItem[] {
  if (flow.body) return flow.body
  return flow.steps.map((step) => ({ kind: 'Step', step }) as FlowBodyItem)
}

/** Whether a body item is a plain step (for the v1 linear view and graph projection). */
export function isStepItem(item: FlowBodyItem): item is { kind: 'Step'; step: StepAst } {
  return item.kind === 'Step'
}
