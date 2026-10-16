/**
 * FFI Host — port 符号（含版本）的运行时实现表
 */

import { normalizeVersion, portKey, type PortAst } from './ast.js'
import { resolvePort } from './resolve.js'
import { genId, type CtxValue, type StepContext } from './runtime.js'

export interface FfiInvokeRequest {
  /** port 名或 Alias.Name */
  port: string
  /** 可选版本钉扎 */
  version?: string
  input: StepContext
  meta?: {
    stepId?: string
    flowName?: string
    command?: string
    outputFields?: string[]
    mode?: 'interpret' | 'compile'
    runId?: string
    nodeId?: string
    attempt?: number
    requestId?: string
    idempotencyKey?: string
    deadlineAt?: string
    definitionDigest?: string
    transition?: number
    timeoutMs?: number
    costUsd?: number
    elapsedMs?: number
    /** DSL v2 step-level policy (PRD 3.10.9); the host prefers it over env. */
    maxAttempts?: number
    budgetUsd?: number
    execution?: {
      class: 'pure' | 'workspace' | 'ai'
      isolation: 'disposable' | 'scoped' | 'none'
      network: 'deny' | 'allow'
    }
    feedback?: { name: string; value: CtxValue }
  }
}

export interface FfiInvokeResult {
  ok: boolean
  output: StepContext
  detail?: string
  error?: string
  /** 实际命中的 version */
  resolvedVersion?: string
}

export interface FfiCallLog {
  at: string
  port: string
  version?: string
  stepId?: string
  flowName?: string
  mode?: 'interpret' | 'compile'
  input: StepContext
  output: StepContext
  ok: boolean
  detail?: string
}

export interface FfiHost {
  /** 是否提供该 port（可选版本） */
  has(port: string, version?: string): boolean
  invoke(req: FfiInvokeRequest): FfiInvokeResult
  readonly log: FfiCallLog[]
  clearLog(): void
  resolveCollection?: (reference: CtxValue) => unknown[] | null
}

export interface AsyncFfiHost extends FfiHost {
  invokeAsync(req: FfiInvokeRequest): Promise<FfiInvokeResult>
}

export class MockHost implements FfiHost {
  readonly log: FfiCallLog[] = []
  private readonly ports: PortAst[]
  private readonly byKey: Map<string, PortAst>

  constructor(ports: PortAst[]) {
    this.ports = ports.map((p) => ({
      ...p,
      version: normalizeVersion(p.version || '1.0.0'),
    }))
    this.byKey = new Map()
    for (const p of this.ports) {
      const q = p.qualifiedName ?? p.name
      this.byKey.set(portKey(q, p.version), p)
      this.byKey.set(portKey(p.name, p.version), p)
      // bare name → 稍后 resolve 选最高版本
    }
  }

  has(port: string, version?: string): boolean {
    return resolvePort(this.ports, port, version) != null
  }

  clearLog(): void {
    this.log.length = 0
  }

  invoke(req: FfiInvokeRequest): FfiInvokeResult {
    const def = resolvePort(this.ports, req.port, req.version)
    if (!def) {
      const fail: FfiInvokeResult = {
        ok: false,
        output: {},
        error: `Host 未绑定 port: ${req.port}${req.version ? '@' + req.version : ''}`,
      }
      this.pushLog(req, fail)
      return fail
    }

    for (const f of def.inFields) {
      if (!f.optional && (req.input[f.name] === undefined || req.input[f.name] === '')) {
        const fail: FfiInvokeResult = {
          ok: false,
          output: {},
          error: `port ${def.name}@${def.version} 缺少 in.${f.name}`,
          resolvedVersion: def.version,
        }
        this.pushLog(req, fail, def.version)
        return fail
      }
    }

    const output: StepContext = {}
    for (const f of def.outFields) {
      output[f.name] = mockProduce(def.name, def.version, f.name, f.type, req.input)
    }

    const ok: FfiInvokeResult = {
      ok: true,
      output,
      detail: `mock://${def.name}@${def.version} → ${Object.keys(output).join(',')}`,
      resolvedVersion: def.version,
    }
    this.pushLog(req, ok, def.version)
    return ok
  }

  private pushLog(req: FfiInvokeRequest, res: FfiInvokeResult, ver?: string) {
    this.log.unshift({
      at: new Date().toISOString(),
      port: req.port,
      version: ver ?? res.resolvedVersion ?? req.version,
      stepId: req.meta?.stepId,
      flowName: req.meta?.flowName,
      mode: req.meta?.mode,
      input: { ...req.input },
      output: { ...res.output },
      ok: res.ok,
      detail: res.detail ?? res.error,
    })
  }
}

function mockProduce(
  port: string,
  version: string,
  name: string,
  type: string,
  input: StepContext,
): CtxValue {
  if (name.endsWith('Id') || type === 'ID') {
    const base = name.replace(/Id$/i, '').slice(0, 3).toUpperCase() || port.slice(0, 3).toUpperCase()
    return genId(base)
  }
  if (type === 'Boolean' || name.endsWith('Ok')) return true
  if (type === 'Number' || type === 'Money') {
    const n = Number(input.qty ?? input.amount ?? input.paidAmount ?? 0)
    return Number.isFinite(n) ? n : 0
  }
  const bits = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== '')
    .slice(0, 4)
    .map(([k, v]) => `${k}=${v}`)
  return `ffi:${port}@${version}/${name}${bits.length ? '{' + bits.join(',') + '}' : ''}`
}

export function createMockHost(ports: PortAst[]): MockHost {
  return new MockHost(ports)
}
