import { createHash } from 'node:crypto'
import type { FieldAst, PortAst, PortEffect } from './ast.js'
import type { CtxValue, StepContext } from './runtime.js'

/** Versioned wire contract shared by a DSL workflow and its Polaris Host. */
export const FFI_RPC_PROTOCOL_VERSION = '1.0'

export type FfiRpcMode = 'mock' | 'live'
export type FfiRpcStatus = 'completed' | 'waiting' | 'failed' | 'denied'

export interface FfiRpcPackPin {
  id: string
  version: string
  digest: string
}

export interface FfiRpcCapabilityLease {
  id: string
  packDigest: string
  vaultId: string
  expiresAt: string
}

export interface FfiRpcCallRef {
  port: string
  version: string
  effect: PortEffect
  builtin?: string
}

export interface FfiRpcRequest {
  protocolVersion: typeof FFI_RPC_PROTOCOL_VERSION
  requestId: string
  idempotencyKey: string
  runId: string
  tenantId: string
  vaultId: string
  pack: FfiRpcPackPin
  capabilityLease: FfiRpcCapabilityLease
  call: FfiRpcCallRef
  input: StepContext
  mode: FfiRpcMode
  stepId?: string
  stepLabel?: string
  outputFields?: string[]
  deadlineAt?: string
  traceId?: string
}

export interface FfiRpcReceipt {
  id: string
  requestId: string
  status: FfiRpcStatus
  call: FfiRpcCallRef
  startedAt: string
  completedAt: string
  outputDigest?: string
}

export interface FfiRpcResponse {
  protocolVersion: typeof FFI_RPC_PROTOCOL_VERSION
  requestId: string
  status: FfiRpcStatus
  output: StepContext
  receipt: FfiRpcReceipt
  error?: { code: string; message: string }
}

export interface FfiRpcTransport {
  invoke(request: FfiRpcRequest): Promise<FfiRpcResponse>
}

export type FfiAdmissionResult =
  | { allowed: true }
  | { allowed: false; code: string; message: string }

/**
 * Every host, including a future live/AI host, must repeat this admission
 * check before invoking a tool.
 */
export function checkFfiAdmission(
  request: FfiRpcRequest,
  now = new Date(),
): FfiAdmissionResult {
  if (!request.pack.digest.trim()) {
    return { allowed: false, code: 'pack-digest-required', message: 'FFI requires an immutable pack digest' }
  }
  if (!request.capabilityLease.id.trim()) {
    return { allowed: false, code: 'capability-lease-required', message: 'FFI requires a Vault capability lease' }
  }
  if (request.capabilityLease.packDigest !== request.pack.digest) {
    return { allowed: false, code: 'pack-digest-mismatch', message: 'FFI pack pin does not match the capability lease' }
  }
  if (request.capabilityLease.vaultId !== request.vaultId) {
    return { allowed: false, code: 'vault-capability-mismatch', message: 'FFI capability lease is bound to another Vault' }
  }
  const expiresAt = Date.parse(request.capabilityLease.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { allowed: false, code: 'capability-lease-expired', message: 'FFI capability lease is expired' }
  }
  return { allowed: true }
}

export interface BuiltinCallDefinition {
  id: string
  version: string
  effect: PortEffect
  input: FieldAst[]
  output: FieldAst[]
  requiresApproval: boolean
  risk: 'read' | 'workspace' | 'external' | 'human'
}

const MANUAL_REVIEW: BuiltinCallDefinition = {
  id: 'manual.review',
  version: '1.0.0',
  effect: 'human',
  input: [
    { name: 'title', type: 'String' },
    { name: 'instructions', type: 'String' },
    { name: 'context', type: 'String', optional: true },
  ],
  output: [
    { name: 'approved', type: 'Boolean' },
    { name: 'reviewId', type: 'ID' },
    { name: 'notes', type: 'String', optional: true },
  ],
  requiresApproval: true,
  risk: 'human',
}

/** Built-ins are interfaces, not executable domain logic. */
export const BUILTIN_CALLS: readonly BuiltinCallDefinition[] = [MANUAL_REVIEW]

export function builtinCall(id: string, version = '1.0.0'): BuiltinCallDefinition | null {
  return BUILTIN_CALLS.find((candidate) => candidate.id === id && candidate.version === version) ?? null
}

export function builtinCallForPort(port: Pick<PortAst, 'name' | 'builtin' | 'version'>): BuiltinCallDefinition | null {
  const id = port.builtin ?? (port.name === 'ManualReview' ? 'manual.review' : undefined)
  return id ? builtinCall(id, port.version) : null
}

export function mockRpcResponse(request: FfiRpcRequest): FfiRpcResponse {
  const startedAt = new Date().toISOString()
  const output: StepContext = {}
  const admission = checkFfiAdmission(request)
  if (!admission.allowed) {
    const completedAt = new Date().toISOString()
    return {
      protocolVersion: FFI_RPC_PROTOCOL_VERSION,
      requestId: request.requestId,
      status: 'denied',
      output,
      receipt: {
        id: `receipt-${request.requestId}`,
        requestId: request.requestId,
        status: 'denied',
        call: request.call,
        startedAt,
        completedAt,
        outputDigest: `sha256:${createHash('sha256').update('{}', 'utf8').digest('hex')}`,
      },
      error: { code: admission.code, message: admission.message },
    }
  }
  const definition = request.call.builtin ? builtinCall(request.call.builtin, request.call.version) : null
  for (const field of definition?.output ?? []) {
    if (field.name === 'approved') output[field.name] = true
    else if (field.name === 'reviewId') output[field.name] = `review-${request.requestId.slice(0, 12)}`
    else output[field.name] = `mock:${request.call.port}/${field.name}`
  }
  if (!definition) {
    output.result = `mock:${request.call.port}@${request.call.version}`
  }
  const encoded = JSON.stringify(output)
  const completedAt = new Date().toISOString()
  const status: FfiRpcStatus = definition?.requiresApproval ? 'waiting' : 'completed'
  return {
    protocolVersion: FFI_RPC_PROTOCOL_VERSION,
    requestId: request.requestId,
    status,
    output,
    receipt: {
      id: `receipt-${request.requestId}`,
      requestId: request.requestId,
      status,
      call: request.call,
      startedAt,
      completedAt,
      outputDigest: `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`,
    },
  }
}
