import { createHash } from 'node:crypto'
import {
  type FieldAst,
  type PortAst,
  type TrialArtifactAst,
  type TrialAst,
  type TrialEdgeAst,
  type TrialNodeAst,
  type ValidationIssue,
} from './ast.js'
import { resolvePort } from './resolve.js'
import type { AsyncFfiHost, FfiHost, FfiInvokeResult } from './host.js'
import { genId, type CtxValue, type StepContext } from './runtime.js'

export type TrialRunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'

export type TrialInvocationStatus = 'completed' | 'waiting' | 'failed' | 'denied'

export interface TrialInvocationRequest {
  requestId: string
  runId: string
  workflow: string
  definitionDigest: string
  nodeId: string
  attempt: number
  port: string
  version?: string
  effect: PortAst['effect']
  input: StepContext
  feedback?: { name: string; value: CtxValue }
  idempotencyKey: string
  timeoutMs: number
  deadlineAt: string
  /** Execution intent and current accounting are part of the Host envelope. */
  execution: TrialAst['execution']
  transition: number
  budget: TrialAst['budget']
  costUsd: number
  elapsedMs: number
  signal?: AbortSignal
}

export interface TrialArtifactRecord {
  id: string
  name: string
  kind: TrialArtifactAst['kind']
  nodeId: string
  size: number
  redacted: boolean
  type?: string
  ref?: string
  digest?: string
  content?: string
}

export interface TrialInvocationResult {
  ok: boolean
  status?: TrialInvocationStatus
  output: StepContext
  error?: { code: string; message: string }
  costUsd?: number
  elapsedMs?: number
  actions?: number
  retryable?: boolean
  artifacts?: TrialArtifactRecord[]
}

export interface TrialHost {
  has(port: string, version?: string): boolean
  hasCapability?(capability: string): boolean
  invoke(request: TrialInvocationRequest): Promise<TrialInvocationResult> | TrialInvocationResult
}

export interface TrialReceipt {
  id: string
  requestId: string
  nodeId: string
  attempt: number
  status: TrialInvocationStatus
  startedAt: string
  completedAt: string
  costUsd: number
  elapsedMs: number
  outputDigest: string
}

export interface TrialEvent {
  sequence: number
  at: string
  kind:
    | 'run-started'
    | 'node-started'
    | 'node-completed'
    | 'node-failed'
    | 'node-retry'
    | 'edge-selected'
    | 'receipt-replayed'
    | 'resumed'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
  nodeId?: string
  attempt?: number
  detail: string
}

export interface TrialCallRecord {
  requestId: string
  result: TrialInvocationResult
  receipt: TrialReceipt
}

export type TrialNodeRunStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'

export interface TrialNodeRunState {
  status: TrialNodeRunStatus
  attempts: number
  lastRequestId?: string
  lastError?: { code: string; message: string }
}

export interface TrialRunState {
  version: '0.4-trial'
  id: string
  workflow: string
  /** Digest of the exact trial graph and port contracts used by this run. */
  definitionDigest?: string
  status: TrialRunStatus
  currentNode: string | null
  context: StepContext
  nodeStates: Record<string, TrialNodeRunState>
  pendingFeedback?: { name: string; value: CtxValue }
  /** Durable request checkpoint written before entering the external Host. */
  inflight?: {
    nodeId: string
    attempt: number
    requestId: string
    timeoutMs?: number
    deadlineAt?: string
  }
  /** Durable response checkpoint written before routing the next edge. */
  pending?: {
    nodeId: string
    attempt: number
    result: TrialInvocationResult
  }
  waiting?: {
    nodeId: string
    attempt: number
    requestId?: string
    result: TrialInvocationResult
  }
  attempts: Record<string, number>
  transitions: number
  costUsd: number
  elapsedMs: number
  startedAt: string
  updatedAt: string
  events: TrialEvent[]
  receipts: TrialReceipt[]
  artifacts: TrialArtifactRecord[]
  calls: Record<string, TrialCallRecord>
  error?: { code: string; message: string }
}

export interface TrialStateStore {
  load(runId: string): TrialRunState | undefined
  /** Implementations should atomically replace the complete run snapshot. */
  save(state: TrialRunState): void
}

export class InMemoryTrialStateStore implements TrialStateStore {
  private readonly states = new Map<string, TrialRunState>()

  load(runId: string): TrialRunState | undefined {
    const state = this.states.get(runId)
    return state ? clone(state) : undefined
  }

  save(state: TrialRunState): void {
    this.states.set(state.id, clone(state))
  }
}

export function serializeTrialRun(state: TrialRunState): string {
  return JSON.stringify(state)
}

export function deserializeTrialRun(serialized: string): TrialRunState {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`Invalid trial state JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed) || parsed.version !== '0.4-trial') {
    throw new Error('Invalid trial state version')
  }
  const state = parsed as unknown as TrialRunState
  const statuses = new Set<TrialRunStatus>(['running', 'waiting', 'succeeded', 'failed', 'cancelled'])
  if (
    typeof state.id !== 'string'
    || typeof state.workflow !== 'string'
    || !statuses.has(state.status)
    || (!isRecord(state.context) || !isRecord(state.nodeStates))
    || !isRecord(state.attempts)
    || !isRecord(state.calls)
    || !Array.isArray(state.events)
    || !Array.isArray(state.receipts)
    || !Array.isArray(state.artifacts)
    || !Number.isInteger(state.transitions)
    || state.transitions < 0
    || !Number.isFinite(state.costUsd)
    || state.costUsd < 0
    || !Number.isFinite(state.elapsedMs)
    || state.elapsedMs < 0
  ) {
    throw new Error('Invalid trial state shape')
  }
  return clone(state)
}

export interface TrialClock {
  nowMs(): number
  sleep(ms: number): Promise<void>
}

const REAL_CLOCK: TrialClock = {
  nowMs: () => Date.now(),
  sleep: async (ms) => {
    if (ms <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  },
}

export interface TrialRuntimeOptions {
  clock?: TrialClock
  allowNetwork?: boolean
  maxArtifactBytes?: number
  maxContextBytes?: number
}

export interface TrialProgram {
  readonly ast: TrialAst
  readonly ports: readonly PortAst[]
  run(
    input: StepContext,
    host: TrialHost,
    options?: { runId?: string; store?: TrialStateStore } & TrialRuntimeOptions,
  ): Promise<TrialRunState>
  resume(
    runId: string,
    host: TrialHost,
    options?: TrialRuntimeOptions & { store?: TrialStateStore; output?: StepContext },
  ): Promise<TrialRunState>
  cancel(runId: string, store: TrialStateStore): TrialRunState
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function outputDigest(output: StepContext): string {
  let serialized: string
  try {
    serialized = JSON.stringify(output)
  } catch {
    serialized = '[unserializable-output]'
  }
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`
}

function definitionDigest(trial: TrialAst, ports: readonly PortAst[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ trial, ports }), 'utf8')
    .digest('hex')}`
}

function fieldMap(fields: readonly FieldAst[]): Map<string, FieldAst> {
  return new Map(fields.map((field) => [field.name, field]))
}

function inputValue(input: StepContext, name: string): CtxValue {
  return input[name]
}

function coerceTrialInput(inputs: TrialAst['inputs'], raw: StepContext): StepContext {
  const result: StepContext = {}
  for (const field of inputs) {
    if (raw[field.name] === undefined) continue
    result[field.name] = raw[field.name]
    if ((field.type === 'Number' || field.type === 'Money') && result[field.name] !== undefined && result[field.name] !== '') {
      const value = Number(result[field.name])
      if (Number.isFinite(value)) result[field.name] = value
    }
  }
  return result
}

function validateTrialInput(inputs: TrialAst['inputs'], input: StepContext): string | null {
  for (const field of inputs) {
    const value = inputValue(input, field.name)
    if (field.required && (value === undefined || value === '')) {
      return `${field.label ?? field.name} is required`
    }
    if (value !== undefined && !matchesFieldType(value, field.type)) {
      return `${field.label ?? field.name} has an invalid ${field.type} value`
    }
    if (field.min !== undefined && typeof value === 'number' && value < field.min) {
      return `${field.label ?? field.name} must be at least ${field.min}`
    }
  }
  return null
}

export interface TrialConditionComparison {
  left: string
  operator: '==' | '!=' | '<' | '<=' | '>' | '>='
  right: CtxValue
}

type ConditionToken =
  | { kind: 'identifier' | 'number' | 'string' | 'boolean'; value: string }
  | { kind: 'operator' | 'lparen' | 'rparen'; value: '&&' | '||' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '(' | ')' }

type TrialConditionExpression =
  | { kind: 'literal'; value: boolean }
  | { kind: 'comparison'; value: TrialConditionComparison }
  | { kind: 'and' | 'or'; left: TrialConditionExpression; right: TrialConditionExpression }

function tokenizeTrialCondition(expr: string): ConditionToken[] | null {
  const tokens: ConditionToken[] = []
  let index = 0
  while (index < expr.length) {
    const char = expr[index]
    if (/\s/u.test(char)) {
      index += 1
      continue
    }

    const pair = expr.slice(index, index + 2)
    if (pair === '&&' || pair === '||' || pair === '==' || pair === '!=' || pair === '<=' || pair === '>=') {
      tokens.push({ kind: 'operator', value: pair })
      index += 2
      continue
    }
    if (char === '<' || char === '>') {
      tokens.push({ kind: 'operator', value: char })
      index += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: char === '(' ? 'lparen' : 'rparen', value: char })
      index += 1
      continue
    }

    if (char === '"' || char === "'") {
      const quote = char
      let value = ''
      let closed = false
      index += 1
      while (index < expr.length) {
        const current = expr[index]
        if (current === '\\') {
          const escaped = expr[index + 1]
          if (escaped === undefined) return null
          value += escaped
          index += 2
          continue
        }
        if (current === quote) {
          closed = true
          index += 1
          break
        }
        value += current
        index += 1
      }
      if (!closed) return null
      tokens.push({ kind: 'string', value })
      continue
    }

    const number = expr.slice(index).match(/^-?\d+(?:\.\d+)?/u)
    if (number) {
      tokens.push({ kind: 'number', value: number[0] })
      index += number[0].length
      continue
    }

    const identifier = expr.slice(index).match(/^[\p{L}_][\p{L}\p{N}_]*/u)
    if (identifier) {
      const value = identifier[0]
      tokens.push({
        kind: value === 'true' || value === 'false' ? 'boolean' : 'identifier',
        value,
      })
      index += value.length
      continue
    }
    return null
  }
  return tokens
}

class TrialConditionParser {
  private index = 0

  constructor(private readonly tokens: readonly ConditionToken[]) {}

  parse(): TrialConditionExpression | null {
    const expression = this.parseOr()
    return expression && this.index === this.tokens.length ? expression : null
  }

  private parseOr(): TrialConditionExpression | null {
    let expression = this.parseAnd()
    while (this.consumeOperator('||')) {
      const right = this.parseAnd()
      if (!expression || !right) return null
      expression = { kind: 'or', left: expression, right }
    }
    return expression
  }

  private parseAnd(): TrialConditionExpression | null {
    let expression = this.parsePrimary()
    while (this.consumeOperator('&&')) {
      const right = this.parsePrimary()
      if (!expression || !right) return null
      expression = { kind: 'and', left: expression, right }
    }
    return expression
  }

  private parsePrimary(): TrialConditionExpression | null {
    const token = this.tokens[this.index]
    if (!token) return null
    if (token.kind === 'lparen') {
      this.index += 1
      const expression = this.parseOr()
      if (!expression || this.tokens[this.index]?.kind !== 'rparen') return null
      this.index += 1
      return expression
    }
    if (token.kind === 'boolean') {
      this.index += 1
      return { kind: 'literal', value: token.value === 'true' }
    }
    if (token.kind !== 'identifier') return null

    const left = token.value
    this.index += 1
    const operator = this.tokens[this.index]
    if (
      !operator
      || operator.kind !== 'operator'
      || !['==', '!=', '<', '<=', '>', '>='].includes(operator.value)
    ) return null
    this.index += 1
    const rightToken = this.tokens[this.index]
    if (!rightToken || !['boolean', 'number', 'string', 'identifier'].includes(rightToken.kind)) return null
    this.index += 1
    const right: CtxValue = rightToken.kind === 'boolean'
      ? rightToken.value === 'true'
      : rightToken.kind === 'number'
        ? Number(rightToken.value)
        : rightToken.value
    return {
      kind: 'comparison',
      value: {
        left,
        operator: operator.value as TrialConditionComparison['operator'],
        right,
      },
    }
  }

  private consumeOperator(operator: '&&' | '||'): boolean {
    const token = this.tokens[this.index]
    if (token?.kind !== 'operator' || token.value !== operator) return false
    this.index += 1
    return true
  }
}

function parseTrialCondition(expr: string): TrialConditionExpression | null {
  const text = expr.trim()
  if (!text) return null
  const tokens = tokenizeTrialCondition(text)
  return tokens ? new TrialConditionParser(tokens).parse() : null
}

export function isTrialConditionSyntax(expr: string): boolean {
  return !expr.trim() || parseTrialCondition(expr) !== null
}

function collectTrialConditionComparisons(
  expression: TrialConditionExpression,
  comparisons: TrialConditionComparison[],
): void {
  if (expression.kind === 'comparison') {
    comparisons.push(expression.value)
    return
  }
  if (expression.kind === 'and' || expression.kind === 'or') {
    collectTrialConditionComparisons(expression.left, comparisons)
    collectTrialConditionComparisons(expression.right, comparisons)
  }
}

export function trialConditionComparisons(expr: string): TrialConditionComparison[] {
  const parsed = parseTrialCondition(expr)
  if (!parsed) return []
  const comparisons: TrialConditionComparison[] = []
  collectTrialConditionComparisons(parsed, comparisons)
  return comparisons
}

export function trialConditionIdentifiers(expr: string): string[] {
  return trialConditionComparisons(expr).map((comparison) => comparison.left)
}

export function evaluateTrialCondition(expr: string | undefined, context: StepContext): boolean {
  if (!expr || expr.trim() === '') return true
  const parsed = parseTrialCondition(expr)
  if (!parsed) return false
  const evaluate = (expression: TrialConditionExpression): boolean => {
    if (expression.kind === 'literal') return expression.value
    if (expression.kind === 'and') return evaluate(expression.left) && evaluate(expression.right)
    if (expression.kind === 'or') return evaluate(expression.left) || evaluate(expression.right)
    if (expression.kind !== 'comparison') return false
    const actual = context[expression.value.left]
    // Missing values never satisfy a route, including `!=`; this keeps an
    // optional or stale output from becoming an implicit success branch.
    if (actual === undefined) return false
    if (expression.value.operator === '==' || expression.value.operator === '!=') {
      return expression.value.operator === '=='
        ? actual === expression.value.right
        : actual !== expression.value.right
    }
    if (typeof actual !== 'number' || typeof expression.value.right !== 'number') return false
    if (expression.value.operator === '<') return actual < expression.value.right
    if (expression.value.operator === '<=') return actual <= expression.value.right
    if (expression.value.operator === '>') return actual > expression.value.right
    return actual >= expression.value.right
  }
  return evaluate(parsed)
}

function issue(
  issues: ValidationIssue[],
  level: ValidationIssue['level'],
  code: string,
  message: string,
  path?: string,
): void {
  issues.push({ level, code, message, path })
}

function outputTypesFor(nodes: readonly TrialNodeAst[]): Map<string, string> {
  const types = new Map<string, string>()
  for (const node of nodes) {
    for (const output of node.outputs) types.set(output.name, output.type)
  }
  return types
}

function outputTypeForNode(node: TrialNodeAst | undefined, name: string): string | undefined {
  return node?.outputs.find((output) => output.name === name)?.type
}

function conditionValueType(value: CtxValue): 'string' | 'number' | 'boolean' {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'string'
}

function conditionTypeMatches(
  type: string,
  value: CtxValue,
  operator: TrialConditionComparison['operator'],
): boolean {
  const rightType = conditionValueType(value)
  if (operator !== '==' && operator !== '!=' && type !== 'Number' && type !== 'Money') return false
  if (operator !== '==' && operator !== '!=' && rightType !== 'number') return false
  if (type === 'Number' || type === 'Money') return rightType === 'number'
  if (type === 'Boolean') return rightType === 'boolean'
  // IDs, enums, Status, and user-defined scalar types are represented by
  // strings in StepContext.
  return rightType === 'string'
}

export function validateTrial(trial: TrialAst, ports: readonly PortAst[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!trial.name) issue(issues, 'error', 'E_TRIAL_NAME', 'Trial name is required')
  if (!trial.start) issue(issues, 'error', 'E_TRIAL_START', `trial ${trial.name} must declare start <node>`)
  if (trial.nodes.length === 0) issue(issues, 'error', 'E_TRIAL_NODES', `Trial ${trial.name} must declare at least one node`)
  if (!['pure', 'workspace', 'ai'].includes(trial.execution.class)) issue(issues, 'error', 'E_TRIAL_EXECUTION_CLASS', `Trial ${trial.name} has an invalid execution class`)
  if (!['disposable', 'scoped', 'none'].includes(trial.execution.isolation)) issue(issues, 'error', 'E_TRIAL_ISOLATION', `Trial ${trial.name} has an invalid isolation mode`)
  if (!['deny', 'allow'].includes(trial.execution.network)) issue(issues, 'error', 'E_TRIAL_NETWORK', `Trial ${trial.name} has an invalid network policy`)
  if (trial.budget.timeoutMs <= 0 || !Number.isFinite(trial.budget.timeoutMs)) issue(issues, 'error', 'E_TRIAL_TIMEOUT', `trial ${trial.name} has an invalid timeout`)
  if (trial.budget.maxCost < 0 || !Number.isFinite(trial.budget.maxCost)) issue(issues, 'error', 'E_TRIAL_COST', `trial ${trial.name} has an invalid cost budget`)
  if (!Number.isInteger(trial.budget.maxTransitions) || trial.budget.maxTransitions < 1) issue(issues, 'error', 'E_TRIAL_TRANSITIONS', `trial ${trial.name} has an invalid transition budget`)

  const nodes = new Map<string, TrialNodeAst>()
  const allOutputs = outputTypesFor(trial.nodes)
  const inputNames = new Set(trial.inputs.map((input) => input.name))
  const inputTypes = new Map(trial.inputs.map((input) => [input.name, input.type] as const))
  const allValues = new Map<string, string>([
    ...trial.inputs.map((input) => [input.name, input.type] as const),
    ...allOutputs.entries(),
  ])
  const metadataTypes = new Map<string, string>([
    ['attempt', 'Number'],
    ['nodeAttempt', 'Number'],
    ['transitionCount', 'Number'],
    ['lastNode', 'String'],
    ['lastStatus', 'String'],
    ['lastError', 'String'],
  ])
  // Feedback aliases are legal values in node `uses`, even though they are
  // produced by an edge rather than by a node output declaration.
  for (const edge of trial.edges) {
    const sourceType = outputTypeForNode(
      trial.nodes.find((node) => node.id === edge.from),
      edge.feedback ?? '',
    )
    if (edge.feedbackAs) allOutputs.set(edge.feedbackAs, sourceType ?? 'String')
  }
  for (const [name, type] of allOutputs) allValues.set(name, type)
  const seenInputs = new Set<string>()
  for (const input of trial.inputs) {
    if (seenInputs.has(input.name)) issue(issues, 'error', 'E_TRIAL_DUP_INPUT', `Duplicate trial input ${input.name}`, `trial.${trial.name}`)
    seenInputs.add(input.name)
  }
  for (const node of trial.nodes) {
    if (nodes.has(node.id)) issue(issues, 'error', 'E_TRIAL_DUP_NODE', `Duplicate trial node ${node.id}`, `trial.${trial.name}`)
    nodes.set(node.id, node)
    if (!Number.isInteger(node.retry.maxAttempts) || node.retry.maxAttempts < 1) issue(issues, 'error', 'E_TRIAL_RETRY', `Node ${node.id} must have maxAttempts >= 1`, `trial.${trial.name}.${node.id}`)
    if (node.retry.backoffMs < 0 || !Number.isFinite(node.retry.backoffMs)) issue(issues, 'error', 'E_TRIAL_BACKOFF', `Node ${node.id} has an invalid backoff`, `trial.${trial.name}.${node.id}`)
    if (node.timeoutMs !== undefined && (node.timeoutMs <= 0 || !Number.isFinite(node.timeoutMs))) issue(issues, 'error', 'E_TRIAL_NODE_TIMEOUT', `Node ${node.id} has an invalid timeout`, `trial.${trial.name}.${node.id}`)
    if (node.maxActions !== undefined && (!Number.isInteger(node.maxActions) || node.maxActions < 1)) issue(issues, 'error', 'E_TRIAL_ACTIONS', `Node ${node.id} has an invalid maxActions`, `trial.${trial.name}.${node.id}`)
    const seenUses = new Set<string>()
    for (const name of node.uses) {
      if (seenUses.has(name)) issue(issues, 'error', 'E_TRIAL_DUP_USES', `Node ${node.id} lists ${name} more than once`, `trial.${trial.name}.${node.id}`)
      seenUses.add(name)
    }
    for (const name of node.uses) {
      if (!inputNames.has(name) && !allOutputs.has(name)) issue(issues, 'error', 'E_TRIAL_USES', `Node ${node.id} uses unknown value ${name}`, `trial.${trial.name}.${node.id}`)
    }

    const seenOutputs = new Set<string>()
    for (const output of node.outputs) {
      if (seenOutputs.has(output.name)) issue(issues, 'error', 'E_TRIAL_DUP_OUTPUT', `Node ${node.id} declares ${output.name} more than once`, `trial.${trial.name}.${node.id}`)
      seenOutputs.add(output.name)
    }

    if (!node.call) {
      issue(issues, 'warning', 'W_TRIAL_NO_CALL', `Node ${node.id} has no FFI call`, `trial.${trial.name}.${node.id}`)
      continue
    }
    const port = resolvePort([...ports], node.call.name, node.call.version)
    if (!port) {
      issue(issues, 'error', 'E_TRIAL_CALL_PORT', `Node ${node.id} calls unknown port ${node.call.raw}`, `trial.${trial.name}.${node.id}`)
      continue
    }
    const portInputs = fieldMap(port.inFields)
    for (const name of node.uses) {
      if (!portInputs.has(name)) {
        issue(issues, 'error', 'E_TRIAL_CALL_INPUT_UNKNOWN', `Node ${node.id} passes undeclared input ${name} to ${node.call.raw}`, `trial.${trial.name}.${node.id}`)
      }
    }
    for (const field of port.inFields) {
      if (!field.optional && !node.uses.includes(field.name)) {
        issue(issues, 'error', 'E_TRIAL_CALL_INPUT', `Node ${node.id} does not expose required ${field.name} to ${node.call.raw}`, `trial.${trial.name}.${node.id}`)
      }
      const actualType = allValues.get(field.name)
      if (actualType && actualType !== field.type) issue(issues, 'error', 'E_TRIAL_INPUT_TYPE', `Node ${node.id} passes ${field.name} as ${actualType}, expected ${field.type}`, `trial.${trial.name}.${node.id}`)
    }
    const portOutputs = fieldMap(port.outFields)
    for (const field of port.outFields) {
      const declared = node.outputs.find((output) => output.name === field.name)
      if (!field.optional && (!declared || declared.optional)) {
        issue(issues, 'error', 'E_TRIAL_OUTPUT_DECL', `Node ${node.id} does not declare required output ${field.name} from ${node.call.raw}`, `trial.${trial.name}.${node.id}`)
      }
    }
    for (const output of node.outputs) {
      if (port.outFields.length > 0 && !portOutputs.has(output.name)) {
        issue(issues, 'error', 'E_TRIAL_CALL_OUTPUT', `Node ${node.id} declares unknown output ${output.name} for ${node.call.raw}`, `trial.${trial.name}.${node.id}`)
      } else if (portOutputs.get(output.name) && portOutputs.get(output.name)?.type !== output.type) {
        issue(issues, 'error', 'E_TRIAL_OUTPUT_TYPE', `Node ${node.id} output ${output.name} has type ${output.type}, expected ${portOutputs.get(output.name)?.type}`, `trial.${trial.name}.${node.id}`)
      }
    }
    if (node.outputs.length === 0 && port.outFields.length > 0) issue(issues, 'warning', 'W_TRIAL_NO_OUTPUT', `Node ${node.id} does not declare outputs from ${node.call.raw}`, `trial.${trial.name}.${node.id}`)
  }

  if (trial.start && !nodes.has(trial.start)) issue(issues, 'error', 'E_TRIAL_START_NODE', `Trial ${trial.name} starts at unknown node ${trial.start}`)
  const terminal = new Set<string>()
  for (const node of trial.terminal) {
    if (!nodes.has(node)) issue(issues, 'error', 'E_TRIAL_TERMINAL', `Trial ${trial.name} terminates at unknown node ${node}`)
    if (terminal.has(node)) issue(issues, 'error', 'E_TRIAL_DUP_TERMINAL', `Trial ${trial.name} lists terminal node ${node} twice`)
    terminal.add(node)
  }

  const outgoing = new Map<string, TrialEdgeAst[]>()
  for (const edge of trial.edges) {
    if (!nodes.has(edge.from)) issue(issues, 'error', 'E_TRIAL_EDGE_FROM', `Trial edge starts at unknown node ${edge.from}`, `trial.${trial.name}`)
    if (!nodes.has(edge.to)) issue(issues, 'error', 'E_TRIAL_EDGE_TO', `Trial edge points to unknown node ${edge.to}`, `trial.${trial.name}`)
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
    if (edge.when && !isTrialConditionSyntax(edge.when)) issue(issues, 'error', 'E_TRIAL_CONDITION', `Unsupported trial condition "${edge.when}"`, `trial.${trial.name}.${edge.from}`)
    if (edge.when) {
      const known = new Set([
        ...inputNames,
        ...allOutputs.keys(),
        'attempt',
        'nodeAttempt',
        'transitionCount',
        'lastNode',
        'lastStatus',
        'lastError',
      ])
      const source = nodes.get(edge.from)
      for (const name of trialConditionIdentifiers(edge.when)) {
        if (!known.has(name)) issue(issues, 'error', 'E_TRIAL_CONDITION_VALUE', `Trial condition references unknown value ${name}`, `trial.${trial.name}.${edge.from}`)
        const metadata = metadataTypes.has(name)
        if (!inputNames.has(name) && !metadata && !source?.outputs.some((output) => output.name === name)) {
          issue(issues, 'error', 'E_TRIAL_CONDITION_SCOPE', `Trial condition value ${name} is not produced by ${edge.from}`, `trial.${trial.name}.${edge.from}`)
        }
      }
      for (const comparison of trialConditionComparisons(edge.when)) {
        const actualType = metadataTypes.get(comparison.left)
          ?? inputTypes.get(comparison.left)
          ?? outputTypeForNode(source, comparison.left)
        if (actualType && !conditionTypeMatches(actualType, comparison.right, comparison.operator)) {
          issue(
            issues,
            'error',
            'E_TRIAL_CONDITION_TYPE',
            `Trial condition compares ${comparison.left} (${actualType}) with an incompatible literal`,
            `trial.${trial.name}.${edge.from}`,
          )
        }
      }
    }
    if (edge.feedback) {
      const source = nodes.get(edge.from)
      if (!source?.outputs.some((output) => output.name === edge.feedback)) issue(issues, 'error', 'E_TRIAL_FEEDBACK', `Trial edge feedback ${edge.feedback} is not produced by ${edge.from}`, `trial.${trial.name}`)
      const feedbackName = edge.feedbackAs ?? edge.feedback
      const target = nodes.get(edge.to)
      if (!target?.uses.includes(feedbackName)) {
        issue(issues, 'error', 'E_TRIAL_FEEDBACK_SCOPE', `Trial edge feedback ${feedbackName} is not consumed by ${edge.to}`, `trial.${trial.name}`)
      }
      if (edge.feedbackAs && !edge.feedbackAs.trim()) issue(issues, 'error', 'E_TRIAL_FEEDBACK_AS', `Trial edge feedback destination must not be empty`, `trial.${trial.name}`)
      const targetPort = target?.call ? resolvePort([...ports], target.call.name, target.call.version) : null
      const targetField = targetPort?.inFields.find((field) => field.name === feedbackName)
      const sourceType = outputTypeForNode(source, edge.feedback)
      if (targetField && sourceType && targetField.type !== sourceType) {
        issue(issues, 'error', 'E_TRIAL_FEEDBACK_TYPE', `Trial edge feedback ${edge.feedback} is ${sourceType}, but ${edge.to}.${feedbackName} expects ${targetField.type}`, `trial.${trial.name}`)
      }
    } else if (edge.feedbackAs) {
      issue(issues, 'error', 'E_TRIAL_FEEDBACK_AS', `Trial edge feedbackAs requires feedback`, `trial.${trial.name}`)
    }
  }

  const visited = new Set<string>()
  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    for (const edge of outgoing.get(nodeId) ?? []) visit(edge.to)
  }
  if (trial.start && nodes.has(trial.start)) visit(trial.start)
  for (const node of trial.nodes) if (!visited.has(node.id)) issue(issues, 'warning', 'W_TRIAL_UNREACHABLE', `Trial node ${node.id} is unreachable`, `trial.${trial.name}.${node.id}`)
  if (trial.terminal.length === 0) issue(issues, 'error', 'E_TRIAL_NO_TERMINAL', `Trial ${trial.name} has no explicit terminal node`)
  for (const node of trial.terminal) {
    if (nodes.has(node) && !visited.has(node)) issue(issues, 'error', 'E_TRIAL_TERMINAL_UNREACHABLE', `Trial terminal node ${node} is unreachable`, `trial.${trial.name}.${node}`)
  }
  if (trial.execution.class === 'ai' && trial.execution.isolation !== 'disposable') issue(issues, 'error', 'E_TRIAL_ISOLATION', `AI trial ${trial.name} requires disposable isolation`, `trial.${trial.name}`)

  for (const node of trial.nodes) {
    const edges = outgoing.get(node.id) ?? []
    if (!terminal.has(node.id) && edges.length === 0) issue(issues, 'error', 'E_TRIAL_NO_ROUTE', `Non-terminal node ${node.id} has no outgoing edge`, `trial.${trial.name}.${node.id}`)
    if (terminal.has(node.id) && edges.length > 0) issue(issues, 'warning', 'W_TRIAL_TERMINAL_EDGE', `Terminal node ${node.id} has outgoing edges that will not run`, `trial.${trial.name}.${node.id}`)
    const defaults = edges.filter((edge) => !edge.when)
    if (defaults.length > 1) issue(issues, 'error', 'E_TRIAL_DEFAULT_EDGE', `Node ${node.id} has more than one unconditional edge`, `trial.${trial.name}.${node.id}`)
    if (defaults.length === 1 && edges[edges.length - 1] !== defaults[0]) issue(issues, 'warning', 'W_TRIAL_DEFAULT_EDGE_ORDER', `Unconditional edge from ${node.id} shadows later conditional edges`, `trial.${trial.name}.${node.id}`)
  }

  const artifactNames = new Set<string>()
  for (const artifact of trial.artifacts) {
    if (artifactNames.has(artifact.name)) issue(issues, 'error', 'E_TRIAL_DUP_ARTIFACT', `Artifact ${artifact.name} is declared more than once`, `trial.${trial.name}`)
    artifactNames.add(artifact.name)
    if (!inputNames.has(artifact.name) && !allOutputs.has(artifact.name)) {
      issue(issues, 'error', 'E_TRIAL_ARTIFACT', `Artifact ${artifact.name} is not an input or node output`, `trial.${trial.name}`)
    }
    const sourceType = allValues.get(artifact.name)
    if (sourceType && sourceType !== artifact.type) {
      issue(issues, 'error', 'E_TRIAL_ARTIFACT_TYPE', `Artifact ${artifact.name} is ${sourceType}, expected ${artifact.type}`, `trial.${trial.name}`)
    }
  }

  return issues
}

function portForNode(ports: readonly PortAst[], node: TrialNodeAst): PortAst | null {
  return node.call ? resolvePort([...ports], node.call.name, node.call.version) : null
}

function pickContext(context: StepContext, names: readonly string[]): StepContext {
  const picked: StepContext = {}
  for (const name of names) {
    if (context[name] !== undefined) picked[name] = context[name]
  }
  return picked
}

function normalizeResult(result: TrialInvocationResult): TrialInvocationResult {
  const output = result.output && typeof result.output === 'object' ? result.output : {}
  return {
    ok: result.ok,
    status: result.status ?? (result.ok ? 'completed' : 'failed'),
    output: { ...output },
    ...(result.error
      ? {
          error: {
            code: boundedMessage(String(result.error.code)),
            message: boundedMessage(String(result.error.message)),
          },
        }
      : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
    ...(result.actions !== undefined ? { actions: result.actions } : {}),
    ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts.map((artifact) => ({ ...artifact })) } : {}),
  }
}

function resultError(result: TrialInvocationResult): { code: string; message: string } {
  return result.error ?? { code: 'trial-node-failed', message: 'Trial node failed' }
}

function invokeStatus(result: TrialInvocationResult): TrialInvocationStatus {
  return result.status ?? (result.ok ? 'completed' : 'failed')
}

function isRetryable(result: TrialInvocationResult): boolean {
  return invokeStatus(result) === 'failed' && result.retryable !== false
}

function valueTypeForTrial(trial: TrialAst, name: string): string | undefined {
  const input = trial.inputs.find((candidate) => candidate.name === name)
  if (input) return input.type
  for (const node of trial.nodes) {
    const output = node.outputs.find((candidate) => candidate.name === name)
    if (output) return output.type
  }
  for (const edge of trial.edges) {
    if (edge.feedbackAs !== name) continue
    return valueTypeForTrialNode(trial, edge.from, edge.feedback)
  }
  return undefined
}

function valueTypeForTrialNode(trial: TrialAst, nodeId: string, name: string | undefined): string | undefined {
  if (!name) return undefined
  const node = trial.nodes.find((candidate) => candidate.id === nodeId)
  return node?.outputs.find((output) => output.name === name)?.type
}

function inputError(
  trial: TrialAst,
  node: TrialNodeAst,
  port: PortAst | null,
  input: StepContext,
): { code: string; message: string } | null {
  const portFields = fieldMap(port?.inFields ?? [])
  for (const name of node.uses) {
    const field = portFields.get(name)
    const value = input[name]
    if (value === undefined && field?.optional) continue
    if (value === undefined || (value === '' && field && !field.optional)) {
      return { code: 'trial-input-missing', message: `Node ${node.id} is missing input ${name}` }
    }
    const expectedType = field?.type ?? valueTypeForTrial(trial, name)
    if (expectedType && !matchesFieldType(value, expectedType)) {
      return {
        code: 'trial-input-type',
        message: `Node ${node.id} received an invalid ${expectedType} value for ${name}`,
      }
    }
  }
  for (const field of port?.inFields ?? []) {
    if (!field.optional && !node.uses.includes(field.name)) {
      return {
        code: 'trial-input-declaration',
        message: `Node ${node.id} does not declare required input ${field.name}`,
      }
    }
  }
  return null
}

function outputError(
  node: TrialNodeAst,
  port: PortAst | null,
  output: StepContext,
  requireValues = true,
): { code: string; message: string } | null {
  const portFields = fieldMap(port?.outFields ?? [])
  for (const field of port?.outFields ?? []) {
    if (!field.optional && !node.outputs.some((candidate) => candidate.name === field.name)) {
      return {
        code: 'trial-output-declaration',
        message: `Node ${node.id} does not declare required output ${field.name}`,
      }
    }
  }
  const declaredOutputs = new Set(node.outputs.map((field) => field.name))
  for (const name of Object.keys(output)) {
    if (!declaredOutputs.has(name)) {
      return {
        code: 'trial-output-undeclared',
        message: `Node ${node.id} produced undeclared output ${name}`,
      }
    }
  }
  for (const field of node.outputs) {
    const portField = portFields.get(field.name)
    const requiredByNode = !field.optional
    const requiredByPort = Boolean(portField && !portField.optional)
    const required = requiredByNode || requiredByPort
    if (requireValues && output[field.name] === undefined && required) {
      return {
        code: 'trial-output-missing',
        message: `Node ${node.id} did not produce output ${field.name}`,
      }
    }
    const value = output[field.name]
    if (value !== undefined && (!matchesFieldType(value, field.type) || (portField && !matchesFieldType(value, portField.type)))) {
      return {
        code: 'trial-output-type',
        message: `Node ${node.id} produced an invalid ${field.type} value for ${field.name}`,
      }
    }
  }
  return null
}

function outputSize(output: StepContext): number {
  try {
    return Buffer.byteLength(JSON.stringify(output), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function matchesFieldType(value: CtxValue, type: string): boolean {
  if (value === undefined) return true
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return false
  if (typeof value === 'number' && !Number.isFinite(value)) return false
  if (type === 'ID' || type === 'String' || type === 'Status') return typeof value === 'string'
  if (type === 'Number' || type === 'Money') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'Boolean') return typeof value === 'boolean'
  return true
}

function validateArtifact(
  artifact: TrialArtifactRecord,
  nodeId: string,
  maxBytes: number,
  declaration: TrialArtifactAst,
): TrialArtifactRecord {
  const content = typeof artifact.content === 'string' ? artifact.content : undefined
  const declaredSize = Number(artifact.size)
  const size = content === undefined
    ? Number.isFinite(declaredSize) ? Math.max(0, Math.round(declaredSize)) : 0
    : Buffer.byteLength(content, 'utf8')
  const digest = artifact.digest ?? (content === undefined
    ? undefined
    : `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`)
  const redacted = Boolean(artifact.redacted || declaration.redacted)
  if (!redacted && size <= maxBytes) {
    return {
      ...artifact,
      name: declaration.name,
      kind: declaration.kind,
      nodeId,
      type: declaration.type,
      size,
      redacted,
      ...(digest ? { digest } : {}),
    }
  }
  return {
    ...artifact,
    name: declaration.name,
    kind: declaration.kind,
    nodeId,
    type: declaration.type,
    size,
    content: undefined,
    redacted: true,
    ...(digest ? { digest } : {}),
  }
}

function appendUniqueArtifacts(state: TrialRunState, artifacts: readonly TrialArtifactRecord[]): void {
  const known = new Set(state.artifacts.map((artifact) => artifact.id))
  for (const artifact of artifacts) {
    if (known.has(artifact.id)) continue
    known.add(artifact.id)
    state.artifacts.push(artifact)
  }
}

function artifactError(
  artifact: TrialArtifactRecord,
  declaration: TrialArtifactAst,
): string | null {
  if (typeof artifact.name !== 'string' || !artifact.name) return 'Artifact name is required'
  if (artifact.kind !== declaration.kind) {
    return `Artifact ${artifact.name} has kind ${artifact.kind}, expected ${declaration.kind}`
  }
  if (artifact.type !== undefined && artifact.type !== declaration.type) {
    return `Artifact ${artifact.name} has type ${artifact.type}, expected ${declaration.type}`
  }
  if (artifact.content !== undefined && typeof artifact.content !== 'string') {
    return `Artifact ${artifact.name} content must be a string projection`
  }
  if (artifact.ref !== undefined && typeof artifact.ref !== 'string') {
    return `Artifact ${artifact.name} ref must be a string`
  }
  if (typeof artifact.size !== 'number' || !Number.isFinite(artifact.size) || artifact.size < 0) {
    return `Artifact ${artifact.name} size must be a non-negative number`
  }
  if (typeof artifact.redacted !== 'boolean') {
    return `Artifact ${artifact.name} redaction marker must be boolean`
  }
  if (artifact.digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)) {
    return `Artifact ${artifact.name} has an invalid sha256 digest`
  }
  if (typeof artifact.content === 'string' && artifact.digest) {
    const digest = `sha256:${createHash('sha256').update(artifact.content, 'utf8').digest('hex')}`
    if (artifact.digest !== digest) return `Artifact ${artifact.name} digest does not match its content`
  }
  return null
}

function boundedMessage(message: string): string {
  return message.length <= 2_000 ? message : `${message.slice(0, 1_997)}...`
}

function invocationFailure(
  result: TrialInvocationResult,
  error: { code: string; message: string },
): TrialInvocationResult {
  return {
    ...result,
    ok: false,
    status: 'failed',
    output: {},
    retryable: false,
    error: { code: error.code, message: boundedMessage(error.message) },
  }
}

function prepareInvocationResult(
  node: TrialNodeAst,
  port: PortAst | null,
  result: TrialInvocationResult,
  maxContextBytes: number,
  maxArtifactBytes: number,
  artifacts: readonly TrialArtifactAst[],
): TrialInvocationResult {
  let prepared = normalizeResult(result)
  const status = invokeStatus(prepared)
  if (!prepared.ok && status !== 'failed' && status !== 'denied') {
    return invocationFailure(prepared, {
      code: 'trial-result-invalid',
      message: `Node ${node.id} returned ok=false with status ${status}`,
    })
  }
  if (status === 'waiting' && !prepared.ok) {
    return invocationFailure(prepared, {
      code: 'trial-result-invalid',
      message: `Node ${node.id} returned a failed waiting result`,
    })
  }
  if (outputSize(prepared.output) > maxContextBytes) {
    return invocationFailure(prepared, {
      code: 'trial-output-too-large',
      message: `Node ${node.id} output exceeds ${maxContextBytes} bytes`,
    })
  }
  if (status !== 'failed' && status !== 'denied') {
    const outputIssue = outputError(node, port, prepared.output, status !== 'waiting')
    if (outputIssue) return invocationFailure(prepared, outputIssue)
  }

  if (prepared.artifacts) {
    const boundedArtifacts: TrialArtifactRecord[] = []
    for (const artifact of prepared.artifacts) {
      const declaration = artifacts.find((candidate) => candidate.name === artifact.name)
      if (!declaration) {
        return invocationFailure(prepared, {
          code: 'trial-artifact-undeclared',
          message: `Node ${node.id} returned undeclared artifact ${artifact.name}`,
        })
      }
      const artifactIssue = artifactError(artifact, declaration)
      if (artifactIssue) return invocationFailure(prepared, { code: 'trial-artifact-invalid', message: artifactIssue })
      boundedArtifacts.push(validateArtifact(artifact, node.id, maxArtifactBytes, declaration))
    }
    prepared = { ...prepared, artifacts: boundedArtifacts }
  }
  return prepared
}

interface FinalizedInvocation {
  result: TrialInvocationResult
  elapsedMs: number
  costUsd: number
  receipt: TrialReceipt
}

function finalizeInvocation(
  node: TrialNodeAst,
  port: PortAst | null,
  requestId: string,
  attempt: number,
  rawResult: TrialInvocationResult,
  startedAtMs: number,
  timeoutMs: number,
  clock: TrialClock,
  maxContextBytes: number,
  maxArtifactBytes: number,
  artifacts: readonly TrialArtifactAst[],
): FinalizedInvocation {
  let result = normalizeResult(rawResult)
  const reportedElapsedMs = result.elapsedMs !== undefined
  const rawElapsedMs = Number(reportedElapsedMs ? result.elapsedMs : clock.nowMs() - startedAtMs)
  const elapsedInvalid = !Number.isFinite(rawElapsedMs) || rawElapsedMs < 0
  const elapsedMs = elapsedInvalid ? 0 : Math.round(rawElapsedMs)
  const reportedCostUsd = result.costUsd !== undefined
  const rawCostUsd = Number(reportedCostUsd ? result.costUsd : 0)
  const costInvalid = !Number.isFinite(rawCostUsd) || rawCostUsd < 0
  const costUsd = costInvalid ? 0 : rawCostUsd
  result.elapsedMs = elapsedMs
  result.costUsd = costUsd
  if (elapsedInvalid || costInvalid) {
    result = invocationFailure(result, {
      code: elapsedInvalid ? 'trial-elapsed-invalid' : 'trial-cost-invalid',
      message: `Node ${node.id} returned invalid execution accounting`,
    })
  }
  if (elapsedMs > timeoutMs) {
    result = invocationFailure(result, {
      code: 'trial-node-timeout',
      message: `Node ${node.id} exceeded ${timeoutMs}ms`,
    })
  }
  const actions = Number(result.actions ?? 0)
  if (!Number.isInteger(actions) || actions < 0) {
    result = invocationFailure(result, {
      code: 'trial-action-count-invalid',
      message: `Node ${node.id} returned an invalid action count`,
    })
  } else if (node.maxActions !== undefined && actions > node.maxActions) {
    result = invocationFailure(result, {
      code: 'trial-action-budget',
      message: `Node ${node.id} exceeded ${node.maxActions} actions`,
    })
  }
  result = prepareInvocationResult(
    node,
    port,
    result,
    maxContextBytes,
    maxArtifactBytes,
    artifacts,
  )
  const completedAt = clock.nowMs()
  const receipt: TrialReceipt = {
    id: `receipt-${requestId}`,
    requestId,
    nodeId: node.id,
    attempt,
    status: invokeStatus(result),
    startedAt: iso(Math.max(startedAtMs, completedAt - elapsedMs)),
    completedAt: iso(completedAt),
    costUsd,
    elapsedMs,
    outputDigest: outputDigest(result.output),
  }
  return { result, elapsedMs, costUsd, receipt }
}

class TrialRuntime {
  constructor(
    private readonly program: TrialProgram,
    private readonly host: TrialHost,
    private readonly store: TrialStateStore,
    private readonly options: TrialRuntimeOptions,
  ) {}

  async start(input: StepContext, runId = genId('TRIAL')): Promise<TrialRunState> {
    const existing = this.store.load(runId)
    if (existing) {
      this.assertCompatibleState(existing)
      if (existing.status === 'cancelled' || existing.status === 'failed' || existing.status === 'succeeded') return existing
      if (this.networkNotAdmitted()) return this.fail(existing, 'network-not-admitted', 'Trial network access is not admitted by the Host')
      return this.execute(existing)
    }
    const context = coerceTrialInput(this.program.ast.inputs, input)
    const inputError = validateTrialInput(this.program.ast.inputs, context)
    if (inputError) {
      const state = this.newState(runId, context)
      this.event(state, 'run-started', `Started trial ${this.program.ast.name}`)
      return this.fail(state, 'trial-input-invalid', inputError)
    }
    const maxContextBytes = this.options.maxContextBytes ?? 64 * 1024
    if (outputSize(context) > maxContextBytes) {
      const state = this.newState(runId, context)
      this.event(state, 'run-started', `Started trial ${this.program.ast.name}`)
      return this.fail(state, 'trial-input-too-large', `Trial input exceeds ${maxContextBytes} bytes`)
    }
    if (this.program.ast.execution.network === 'allow' && !this.options.allowNetwork) {
      const state = this.newState(runId, context)
      this.event(state, 'run-started', `Started trial ${this.program.ast.name}`)
      return this.fail(state, 'network-not-admitted', 'Trial network access is not admitted by the Host')
    }
    const state = this.newState(runId, context)
    this.event(state, 'run-started', `Started trial ${this.program.ast.name}`)
    this.store.save(state)
    return this.execute(state)
  }

  async resume(runId: string, output: StepContext = {}): Promise<TrialRunState> {
    const state = this.store.load(runId)
    if (!state) throw new Error(`Unknown trial run ${runId}`)
    this.assertCompatibleState(state)
    if (state.status === 'cancelled' || state.status === 'failed' || state.status === 'succeeded') return state
    if (this.networkNotAdmitted()) return this.fail(state, 'network-not-admitted', 'Trial network access is not admitted by the Host')
    if (state.status === 'waiting') {
      const waiting = state.waiting
      const node = waiting
        ? this.program.ast.nodes.find((candidate) => candidate.id === waiting.nodeId)
        : undefined
      if (!waiting || !node) return this.fail(state, 'trial-waiting-state-invalid', 'Waiting trial state is incomplete')
      const waitingNodeState = state.nodeStates[node.id]
      if (
        waiting.requestId
        && waitingNodeState?.lastRequestId
        && waiting.requestId !== waitingNodeState.lastRequestId
      ) {
        return this.fail(state, 'trial-waiting-state-invalid', 'Waiting trial request does not match the node checkpoint')
      }
      const port = portForNode(this.program.ports, node)
      const mergedOutput = { ...waiting.result.output, ...output }
      const missingOutput = outputError(node, port, mergedOutput)
      if (missingOutput) return this.fail(state, missingOutput.code, missingOutput.message)
      const maxContextBytes = this.options.maxContextBytes ?? 64 * 1024
      if (outputSize(mergedOutput) > maxContextBytes) return this.fail(state, 'trial-output-too-large', `Node ${node.id} output exceeds ${maxContextBytes} bytes`)
      const continuedResult = normalizeResult({
        ...waiting.result,
        ok: true,
        status: 'completed',
        output: mergedOutput,
      })
      state.waiting = undefined
      state.status = 'running'
      // Persist the externally supplied continuation as a response
      // checkpoint before routing. A crash after resume therefore replays
      // this result instead of invoking the node a second time.
      state.pending = { nodeId: node.id, attempt: waiting.attempt, result: continuedResult }
      this.event(state, 'resumed', `Resumed trial at ${node.id}`)
      this.store.save(state)
      return this.execute(state)
    }
    state.status = 'running'
    this.event(state, 'run-started', 'Resumed trial from durable checkpoint')
    this.store.save(state)
    return this.execute(state)
  }

  cancel(runId: string): TrialRunState {
    const state = this.store.load(runId)
    if (!state) throw new Error(`Unknown trial run ${runId}`)
    this.assertCompatibleState(state)
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') return state
    if (state.currentNode && state.nodeStates[state.currentNode]) state.nodeStates[state.currentNode]!.status = 'cancelled'
    state.status = 'cancelled'
    state.currentNode = null
    state.waiting = undefined
    state.pending = undefined
    this.event(state, 'cancelled', 'Trial cancelled before the next node')
    this.store.save(state)
    return state
  }

  private assertCompatibleState(state: TrialRunState): void {
    if (
      state.version !== '0.4-trial'
      || state.workflow !== this.program.ast.name
      || (state.definitionDigest !== undefined && state.definitionDigest !== this.programDefinitionDigest)
    ) {
      throw new Error(`Trial state ${state.id} does not belong to ${this.program.ast.name}`)
    }
    if (state.definitionDigest === undefined) {
      state.definitionDigest = this.programDefinitionDigest
      this.store.save(state)
    }
  }

  private networkNotAdmitted(): boolean {
    return this.program.ast.execution.network === 'allow' && !this.options.allowNetwork
  }

  private get programDefinitionDigest(): string {
    return definitionDigest(this.program.ast, this.program.ports)
  }

  private newState(runId: string, context: StepContext): TrialRunState {
    const now = this.options.clock?.nowMs() ?? REAL_CLOCK.nowMs()
    return {
      version: '0.4-trial',
      id: runId,
      workflow: this.program.ast.name,
      definitionDigest: this.programDefinitionDigest,
      status: 'running',
      currentNode: this.program.ast.start || this.program.ast.nodes[0]?.id || null,
      context: { ...context },
      nodeStates: Object.fromEntries(
        this.program.ast.nodes.map((node) => [node.id, { status: 'pending' as const, attempts: 0 }]),
      ),
      attempts: {},
      transitions: 0,
      costUsd: 0,
      elapsedMs: 0,
      startedAt: iso(now),
      updatedAt: iso(now),
      events: [],
      receipts: [],
      artifacts: [],
      calls: {},
    }
  }

  private clock(): TrialClock {
    return this.options.clock ?? REAL_CLOCK
  }

  private refreshElapsed(state: TrialRunState): void {
    const started = Date.parse(state.startedAt)
    const now = this.clock().nowMs()
    if (!Number.isFinite(started) || !Number.isFinite(now)) return
    state.elapsedMs = Math.max(state.elapsedMs, Math.max(0, now - started))
  }

  private event(state: TrialRunState, kind: TrialEvent['kind'], detail: string, nodeId?: string, attempt?: number): void {
    state.events.push({ sequence: state.events.length + 1, at: iso(this.clock().nowMs()), kind, detail, ...(nodeId ? { nodeId } : {}), ...(attempt !== undefined ? { attempt } : {}) })
    state.updatedAt = iso(this.clock().nowMs())
  }

  private async execute(state: TrialRunState): Promise<TrialRunState> {
    if (state.status !== 'running') return state
    const nodes = new Map(this.program.ast.nodes.map((node) => [node.id, node]))
    const maxArtifactBytes = this.options.maxArtifactBytes ?? 64 * 1024

    while (state.currentNode && state.status === 'running') {
      this.refreshElapsed(state)
      const hasDurableCheckpoint = Boolean(state.pending || state.inflight)
      if (!hasDurableCheckpoint && state.elapsedMs >= this.program.ast.budget.timeoutMs) return this.fail(state, 'trial-timeout', 'Trial timeout budget exhausted')
      if (!hasDurableCheckpoint && state.costUsd > this.program.ast.budget.maxCost) return this.fail(state, 'trial-cost-budget', 'Trial cost budget exhausted')
      if (!hasDurableCheckpoint && state.transitions >= this.program.ast.budget.maxTransitions) return this.fail(state, 'trial-transition-budget', 'Trial transition budget exhausted')

      const node = nodes.get(state.currentNode)
      if (!node) return this.fail(state, 'trial-node-missing', `Trial node ${state.currentNode} is missing`)
      if (state.inflight && state.inflight.nodeId !== node.id) return this.fail(state, 'trial-inflight-state-invalid', 'In-flight trial request does not match the current node')
      if (state.pending && state.pending.nodeId !== node.id) return this.fail(state, 'trial-pending-state-invalid', 'Pending trial response does not match the current node')
      const nodeState = state.nodeStates[node.id] ?? { status: 'pending' as const, attempts: 0 }
      state.nodeStates[node.id] = nodeState

      // A response checkpoint can be persisted just before the worker dies.
      // If the store implementation commits that state without the `pending`
      // marker, the running node and its last request still identify the
      // response. Reuse it rather than allocating a second effect request.
      const checkpointRecord = !state.pending && !state.inflight && nodeState.status === 'running' && nodeState.lastRequestId
        ? state.calls[nodeState.lastRequestId]
        : undefined
      if (checkpointRecord && (checkpointRecord.receipt.nodeId !== node.id || checkpointRecord.receipt.attempt !== nodeState.attempts)) {
        return this.fail(state, 'trial-checkpoint-state-invalid', `Durable response checkpoint does not match node ${node.id}`)
      }

      const pending = state.pending?.nodeId === node.id ? state.pending : undefined
      if (pending) {
        state.pending = undefined
        const port = portForNode(this.program.ports, node)
        const result = pending.result
        nodeState.status = 'running'
        nodeState.attempts = pending.attempt
        this.event(state, 'receipt-replayed', `Replayed durable response for ${node.id}`, node.id, pending.attempt)
        if (outputSize(result.output) > (this.options.maxContextBytes ?? 64 * 1024)) return this.fail(state, 'trial-output-too-large', `Node ${node.id} output exceeds ${this.options.maxContextBytes ?? 64 * 1024} bytes`)
        if (state.elapsedMs > this.program.ast.budget.timeoutMs) return this.fail(state, 'trial-timeout', 'Trial timeout budget exhausted')
        if (state.costUsd > this.program.ast.budget.maxCost) return this.fail(state, 'trial-cost-budget', 'Trial cost budget exhausted')
        const status = invokeStatus(result)
        if (status === 'waiting') {
          nodeState.status = 'waiting'
          state.status = 'waiting'
          state.waiting = {
            nodeId: node.id,
            attempt: pending.attempt,
            requestId: nodeState.lastRequestId,
            result: clone(result),
          }
          this.event(state, 'waiting', `Node ${node.id} is waiting for an external continuation`, node.id, pending.attempt)
          this.store.save(state)
          return state
        }
        if (!result.ok || status === 'failed' || status === 'denied') {
          const error = resultError(result)
          nodeState.status = 'failed'
          nodeState.lastError = error
          this.event(state, 'node-failed', error.message, node.id, pending.attempt)
          if (isRetryable(result) && pending.attempt < node.retry.maxAttempts) {
            nodeState.status = 'pending'
            this.event(state, 'node-retry', `Retrying ${node.id} after ${node.retry.backoffMs}ms`, node.id, pending.attempt)
            state.elapsedMs += node.retry.backoffMs
            this.store.save(state)
            await this.clock().sleep(node.retry.backoffMs)
            const cancelledDuringBackoff = this.store.load(state.id)
            if (cancelledDuringBackoff?.status === 'cancelled') return cancelledDuringBackoff
            this.store.save(state)
            continue
          }
          return this.fail(state, error.code, error.message)
        }
        const completed = this.finishCompletedNode(
          state,
          node,
          port,
          result,
          pending.attempt,
          maxArtifactBytes,
          this.options.maxContextBytes ?? 64 * 1024,
        )
        if (completed) return completed
        continue
      }

      const inflight = state.inflight
      const recoveredRequestId = !inflight && nodeState.status === 'running' ? nodeState.lastRequestId : undefined
      const recoveredAttempt = inflight?.attempt ?? checkpointRecord?.receipt.attempt ?? (recoveredRequestId ? nodeState.attempts : undefined)
      const attempt = recoveredAttempt ?? (state.attempts[node.id] ?? 0) + 1
      const isNewInvocation = !inflight && !recoveredRequestId
      if (isNewInvocation) {
        if (attempt > node.retry.maxAttempts) return this.fail(state, 'trial-attempt-budget', `Node ${node.id} exhausted its attempt budget`)
        state.attempts[node.id] = attempt
        state.transitions += 1
      }
      nodeState.status = 'running'
      nodeState.attempts = attempt

      const port = portForNode(this.program.ports, node)
      if (node.call && !port) return this.fail(state, 'trial-port-missing', `Trial node ${node.id} calls unavailable port ${node.call.raw}`)
      if (node.call && !this.host.has(node.call.name, node.call.version)) return this.fail(state, 'trial-capability-denied', `Host does not provide ${node.call.raw}`)
      for (const capability of node.capabilities) {
        const available = this.host.hasCapability?.(capability) ?? false
        if (!available) return this.fail(state, 'trial-capability-denied', `Host does not provide capability ${capability}`)
      }

      const used = pickContext(state.context, node.uses)
      const inputIssue = inputError(this.program.ast, node, port, used)
      if (inputIssue) return this.fail(state, inputIssue.code, inputIssue.message)
      if (!inflight) {
        for (const output of node.outputs) {
          if (!node.uses.includes(output.name)) delete state.context[output.name]
        }
      }
      const remaining = this.program.ast.budget.timeoutMs - state.elapsedMs
      const timeoutMs = inflight?.timeoutMs
        ?? Math.max(1, Math.min(remaining, node.timeoutMs ?? remaining))
      const now = this.clock().nowMs()
      // The transition ordinal stays unique even when a feedback edge resets
      // the node-local attempt counter.
      const requestId = inflight?.requestId ?? recoveredRequestId ?? `${state.id}:${node.id}:${state.transitions}`
      const request: TrialInvocationRequest = {
        requestId,
        runId: state.id,
        workflow: this.program.ast.name,
        definitionDigest: this.programDefinitionDigest,
        nodeId: node.id,
        attempt,
        port: node.call?.name ?? `pure.${node.id}`,
        ...(node.call?.version ? { version: node.call.version } : {}),
        effect: port?.effect ?? 'pure',
        input: used,
        ...(state.pendingFeedback ? { feedback: { ...state.pendingFeedback } } : {}),
        idempotencyKey: requestId,
        timeoutMs,
        deadlineAt: inflight?.deadlineAt ?? iso(now + timeoutMs),
        execution: { ...this.program.ast.execution },
        transition: state.transitions,
        budget: { ...this.program.ast.budget },
        costUsd: state.costUsd,
        elapsedMs: state.elapsedMs,
      }
      nodeState.lastRequestId = requestId
      this.event(state, 'node-started', `Started ${node.label}`, node.id, attempt)
      this.store.save(state)

      let record = state.calls[requestId]
      let result: TrialInvocationResult
      if (record) {
        state.inflight = undefined
        result = normalizeResult(record.result)
        this.event(state, 'receipt-replayed', `Replayed receipt ${record.receipt.id}`, node.id, attempt)
      } else {
        state.inflight = {
          nodeId: node.id,
          attempt,
          requestId,
          timeoutMs,
          deadlineAt: request.deadlineAt,
        }
        this.store.save(state)
        const cancelledBeforeInvoke = this.store.load(state.id)
        if (cancelledBeforeInvoke?.status === 'cancelled') {
          cancelledBeforeInvoke.inflight = undefined
          this.store.save(cancelledBeforeInvoke)
          return cancelledBeforeInvoke
        }
        const started = this.clock().nowMs()
        try {
          const deadlineMs = Date.parse(request.deadlineAt)
          const remainingDeadline = Number.isFinite(deadlineMs)
            ? Math.max(1, deadlineMs - this.clock().nowMs())
            : timeoutMs
          const invocationTimeoutMs = Math.min(timeoutMs, remainingDeadline)
          result = normalizeResult(node.call
            ? await this.invokeWithTimeout(request, invocationTimeoutMs)
            : { ok: true, status: 'completed', output: {} })
        } catch (error) {
          result = {
            ok: false,
            status: 'failed',
            output: {},
            retryable: true,
            error: { code: 'trial-host-error', message: error instanceof Error ? error.message : String(error) },
          }
        }
        state.inflight = undefined
        const finalized = finalizeInvocation(
          node,
          port,
          requestId,
          attempt,
          result,
          started,
          timeoutMs,
          this.clock(),
          this.options.maxContextBytes ?? 64 * 1024,
          maxArtifactBytes,
          this.program.ast.artifacts,
        )
        result = finalized.result
        const cancelledDuringInvoke = this.store.load(state.id)
        if (cancelledDuringInvoke?.status === 'cancelled') {
          return this.retainCancelledResponse(
            cancelledDuringInvoke,
            node,
            requestId,
            attempt,
            finalized,
          )
        }
        state.elapsedMs += finalized.elapsedMs
        state.costUsd += finalized.costUsd
        record = { requestId, result: clone(result), receipt: finalized.receipt }
        state.calls[requestId] = record
        state.receipts.push(finalized.receipt)
        state.pending = { nodeId: node.id, attempt, result: clone(result) }
        this.store.save(state)
      }

      if (state.elapsedMs > this.program.ast.budget.timeoutMs) return this.fail(state, 'trial-timeout', 'Trial timeout budget exhausted')
      if (state.costUsd > this.program.ast.budget.maxCost) return this.fail(state, 'trial-cost-budget', 'Trial cost budget exhausted')

      const status = invokeStatus(result)
      const maxContextBytes = this.options.maxContextBytes ?? 64 * 1024
      if (outputSize(result.output) > maxContextBytes) return this.fail(state, 'trial-output-too-large', `Node ${node.id} output exceeds ${maxContextBytes} bytes`)
      if (status === 'waiting') {
        nodeState.status = 'waiting'
        state.status = 'waiting'
        state.pending = undefined
        state.waiting = {
          nodeId: node.id,
          attempt,
          requestId,
          result: clone(result),
        }
        this.event(state, 'waiting', `Node ${node.id} is waiting for an external continuation`, node.id, attempt)
        this.store.save(state)
        return state
      }
      if (!result.ok || status === 'failed' || status === 'denied') {
        const error = resultError(result)
        nodeState.status = 'failed'
        nodeState.lastError = error
        state.pending = undefined
        this.event(state, 'node-failed', error.message, node.id, attempt)
        if (isRetryable(result) && attempt < node.retry.maxAttempts) {
          nodeState.status = 'pending'
          this.event(state, 'node-retry', `Retrying ${node.id} after ${node.retry.backoffMs}ms`, node.id, attempt)
          state.elapsedMs += node.retry.backoffMs
          this.store.save(state)
          await this.clock().sleep(node.retry.backoffMs)
          const cancelledDuringBackoff = this.store.load(state.id)
          if (cancelledDuringBackoff?.status === 'cancelled') return cancelledDuringBackoff
          this.store.save(state)
          continue
        }
        return this.fail(state, error.code, error.message)
      }

      const completed = this.finishCompletedNode(
        state,
        node,
        port,
        result,
        attempt,
        maxArtifactBytes,
        this.options.maxContextBytes ?? 64 * 1024,
      )
      if (completed) return completed
    }
    return state
  }

  private finishCompletedNode(
    state: TrialRunState,
    node: TrialNodeAst,
    port: PortAst | null,
    result: TrialInvocationResult,
    attempt: number,
    maxArtifactBytes: number,
    maxContextBytes: number,
  ): TrialRunState | null {
    state.pending = undefined
    const nodeState = state.nodeStates[node.id] ?? { status: 'pending' as const, attempts: attempt }
    state.nodeStates[node.id] = nodeState
    nodeState.status = 'succeeded'
    nodeState.attempts = attempt
    nodeState.lastError = undefined
    const missingOutput = outputError(node, port, result.output)
    if (missingOutput) {
      nodeState.status = 'failed'
      nodeState.lastError = missingOutput
      return this.fail(state, missingOutput.code, missingOutput.message)
    }
    const validatedArtifacts: TrialArtifactRecord[] = []
    for (const artifact of result.artifacts ?? []) {
      const declaration = this.program.ast.artifacts.find((candidate) => candidate.name === artifact.name)
      if (!declaration) {
        nodeState.status = 'failed'
        nodeState.lastError = { code: 'trial-artifact-undeclared', message: `Node ${node.id} returned undeclared artifact ${artifact.name}` }
        return this.fail(state, 'trial-artifact-undeclared', nodeState.lastError.message)
      }
      const artifactIssue = artifactError(artifact, declaration)
      if (artifactIssue) {
        nodeState.status = 'failed'
        nodeState.lastError = { code: 'trial-artifact-invalid', message: artifactIssue }
        return this.fail(state, 'trial-artifact-invalid', artifactIssue)
      }
      validatedArtifacts.push(validateArtifact(artifact, node.id, maxArtifactBytes, declaration))
    }
    const declaredOutputs = new Set(node.outputs.map((output) => output.name))
    for (const [name, value] of Object.entries(result.output)) {
      if (declaredOutputs.has(name)) state.context[name] = value
    }
    if (outputSize(state.context) > maxContextBytes) {
      nodeState.status = 'failed'
      nodeState.lastError = { code: 'trial-context-too-large', message: `Trial context exceeds ${maxContextBytes} bytes` }
      return this.fail(state, 'trial-context-too-large', nodeState.lastError.message)
    }
    this.reconcileCallResult(state, node, attempt, result)
    appendUniqueArtifacts(state, validatedArtifacts)
    this.event(state, 'node-completed', `Completed ${node.label}`, node.id, attempt)
    state.pendingFeedback = undefined
    state.waiting = undefined
    if (new Set(this.program.ast.terminal).has(node.id)) {
      const artifactIssue = this.materializeDeclaredArtifacts(state, node.id)
      if (artifactIssue) {
        nodeState.status = 'failed'
        nodeState.lastError = artifactIssue
        return this.fail(state, artifactIssue.code, artifactIssue.message)
      }
      state.status = 'succeeded'
      state.currentNode = null
      this.event(state, 'succeeded', `Trial ${this.program.ast.name} completed`)
      this.store.save(state)
      return state
    }

    const edgeContext: StepContext = {
      ...state.context,
      attempt,
      nodeAttempt: attempt,
      transitionCount: state.transitions,
      lastNode: node.id,
      lastStatus: invokeStatus(result),
      ...(result.error ? { lastError: result.error.message } : {}),
    }
    const edge = this.program.ast.edges
      .filter((candidate) => candidate.from === node.id)
      .find((candidate) => evaluateTrialCondition(candidate.when, edgeContext))
    if (!edge) return this.fail(state, 'trial-no-route', `No matching edge after node ${node.id}`)
    if (edge.feedback && state.context[edge.feedback] === undefined) return this.fail(state, 'trial-feedback-missing', `Feedback ${edge.feedback} is missing after node ${node.id}`)
    if (edge.resetAttempts) {
      state.attempts[edge.to] = 0
      const targetState = state.nodeStates[edge.to]
      if (targetState) {
        targetState.status = 'pending'
        targetState.attempts = 0
        targetState.lastError = undefined
        targetState.lastRequestId = undefined
      }
    }
    if (edge.feedback) {
      const feedbackName = edge.feedbackAs ?? edge.feedback
      const feedbackValue = state.context[edge.feedback]
      state.context[feedbackName] = feedbackValue
      state.pendingFeedback = { name: feedbackName, value: feedbackValue }
    }
    state.currentNode = edge.to
    this.event(state, 'edge-selected', `Selected edge ${edge.from} -> ${edge.to}`, edge.to)
    this.store.save(state)
    return null
  }

  private reconcileCallResult(
    state: TrialRunState,
    node: TrialNodeAst,
    attempt: number,
    result: TrialInvocationResult,
  ): void {
    const requestId = state.nodeStates[node.id]?.lastRequestId
    const record = requestId ? state.calls[requestId] : undefined
    if (!record || record.receipt.nodeId !== node.id || record.receipt.attempt !== attempt) return
    record.result = clone(result)
    record.receipt = {
      ...record.receipt,
      status: invokeStatus(result),
      outputDigest: outputDigest(result.output),
    }
    const receiptIndex = state.receipts.findIndex((receipt) => receipt.requestId === requestId)
    if (receiptIndex >= 0) state.receipts[receiptIndex] = { ...record.receipt }
  }

  private retainCancelledResponse(
    state: TrialRunState,
    node: TrialNodeAst,
    requestId: string,
    attempt: number,
    finalized: FinalizedInvocation,
  ): TrialRunState {
    state.inflight = undefined
    state.pending = undefined
    state.waiting = undefined
    state.pendingFeedback = undefined
    if (!state.calls[requestId]) {
      state.calls[requestId] = {
        requestId,
        result: clone(finalized.result),
        receipt: finalized.receipt,
      }
      state.receipts.push(finalized.receipt)
      state.elapsedMs += finalized.elapsedMs
      state.costUsd += finalized.costUsd
      if (finalized.result.artifacts) appendUniqueArtifacts(state, finalized.result.artifacts)
    }
    const nodeState = state.nodeStates[node.id] ?? { status: 'cancelled' as const, attempts: 0 }
    nodeState.status = 'cancelled'
    nodeState.attempts = attempt
    nodeState.lastRequestId = requestId
    state.nodeStates[node.id] = nodeState
    this.store.save(state)
    return state
  }

  private materializeDeclaredArtifacts(state: TrialRunState, nodeId: string): { code: string; message: string } | null {
    for (const declaration of this.program.ast.artifacts) {
      const value = state.context[declaration.name]
      if (value === undefined || value === '') continue
      if (state.artifacts.some((artifact) => artifact.name === declaration.name && artifact.ref === String(value))) continue
      const sizeValue = state.context[`${declaration.name}Size`]
      const digestValue = state.context[`${declaration.name}Digest`]
      const artifact: TrialArtifactRecord = {
        id: `artifact-${state.id}-${declaration.name}`,
        name: declaration.name,
        kind: declaration.kind,
        nodeId,
        type: declaration.type,
        size: typeof sizeValue === 'number' && Number.isFinite(sizeValue) ? Math.max(0, sizeValue) : 0,
        redacted: declaration.redacted,
        ref: String(value),
        ...(typeof digestValue === 'string' && digestValue ? { digest: digestValue } : {}),
      }
      const artifactIssue = artifactError(artifact, declaration)
      if (artifactIssue) return { code: 'trial-artifact-invalid', message: artifactIssue }
      state.artifacts.push(artifact)
    }
    return null
  }

  private async invokeWithTimeout(
    request: TrialInvocationRequest,
    timeoutMs: number,
  ): Promise<TrialInvocationResult> {
    const controller = new AbortController()
    const invocation = Promise.resolve(this.host.invoke({ ...request, signal: controller.signal }))
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<TrialInvocationResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve({
          ok: false,
          status: 'failed',
          output: {},
          retryable: false,
          error: { code: 'trial-node-timeout', message: `Node ${request.nodeId} exceeded ${timeoutMs}ms` },
        })
      }, timeoutMs)
    })
    try {
      return await Promise.race([invocation, deadline])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private fail(state: TrialRunState, code: string, message: string): TrialRunState {
    const activeNode = state.currentNode ? state.nodeStates[state.currentNode] : undefined
    if (activeNode?.status === 'running' || activeNode?.status === 'pending') {
      activeNode.status = 'failed'
      activeNode.lastError = { code, message }
    }
    state.status = 'failed'
    state.currentNode = null
    state.error = { code, message }
    this.event(state, 'failed', message)
    this.store.save(state)
    return state
  }
}

export function trialHostFromFfi(
  host: FfiHost | AsyncFfiHost,
  hasCapability: (capability: string) => boolean = () => false,
): TrialHost {
  return {
    has: (port, version) => host.has(port, version),
    hasCapability,
    invoke: async (request) => {
      const requestInput = {
        port: request.port,
        version: request.version,
        input: request.input,
        meta: {
          stepId: request.nodeId,
          flowName: request.workflow,
          mode: 'compile' as const,
          runId: request.runId,
          nodeId: request.nodeId,
          attempt: request.attempt,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          deadlineAt: request.deadlineAt,
          definitionDigest: request.definitionDigest,
          transition: request.transition,
          timeoutMs: request.timeoutMs,
          costUsd: request.costUsd,
          elapsedMs: request.elapsedMs,
          execution: request.execution,
          feedback: request.feedback,
        },
      }
      const result: FfiInvokeResult = 'invokeAsync' in host && host.invokeAsync
        ? await host.invokeAsync(requestInput)
        : host.invoke(requestInput)
      return {
        ok: result.ok,
        status: result.ok ? 'completed' : 'failed',
        output: result.output,
        ...(result.error ? { error: { code: 'ffi-failed', message: result.error } } : {}),
        retryable: !result.ok,
      }
    },
  }
}

export function compileTrial(trial: TrialAst, ports: readonly PortAst[]): TrialProgram {
  const locks = new Map<string, Promise<TrialRunState>>()
  const program: TrialProgram = {
    ast: clone(trial),
    ports: ports.map((port) => clone(port)),
    async run(input, host, options = {}) {
      const runId = options.runId ?? genId('TRIAL')
      return withTrialRunLock(locks, runId, () => {
        const store = options.store ?? new InMemoryTrialStateStore()
        const runtime = new TrialRuntime(program, host, store, options)
        return runtime.start(input, runId)
      })
    },
    async resume(runId, host, options = {}) {
      return withTrialRunLock(locks, runId, () => {
        const store = options.store ?? new InMemoryTrialStateStore()
        const runtime = new TrialRuntime(program, host, store, options)
        return runtime.resume(runId, options.output)
      })
    },
    cancel(runId, store) {
      const runtime = new TrialRuntime(program, {
        has: () => false,
        invoke: () => ({ ok: false, status: 'denied', output: {}, error: { code: 'cancel-only-host', message: 'cancel does not invoke a Host' } }),
      }, store, {})
      return runtime.cancel(runId)
    },
  }
  return program
}

function withTrialRunLock(
  locks: Map<string, Promise<TrialRunState>>,
  runId: string,
  operation: () => Promise<TrialRunState>,
): Promise<TrialRunState> {
  const previous = locks.get(runId) ?? Promise.resolve<TrialRunState | undefined>(undefined)
  const current = previous.then(operation, operation)
  locks.set(runId, current)
  void current.finally(() => {
    if (locks.get(runId) === current) locks.delete(runId)
  }).catch(() => undefined)
  return current
}
