import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  InMemoryTrialStateStore,
  deserializeTrialRun,
  evaluateTrialCondition,
  isTrialConditionSyntax,
  runPipeline,
  serializeTrialRun,
  type TrialHost,
  type TrialInvocationRequest,
  type TrialInvocationResult,
  type TrialRunState,
  type TrialStateStore,
} from '../src/index.js'

const TRIAL_SOURCE = fs.readFileSync(
  new URL('../../../packs/cve-genie-trial/main.ord', import.meta.url),
  'utf8',
)

const NO_WAIT_CLOCK = {
  nowMs: () => 0,
  sleep: async () => {},
}

test('v0.3 remains the default language surface', () => {
  const result = runPipeline([
    'domain LegacyPack version "1.0.0"',
    'entity Record {',
    '  id: ID',
    '}',
    'flow Create title "Create" on Record {',
    '  create',
    '  input {',
    '    name: String required',
    '  }',
    '  steps {',
    '    make "Make" {',
    '      uses { name }',
    '      output { recordId: ID }',
    '    }',
    '  }',
    '  output { recordId: ID from recordId }',
    '  transition status -> Created',
    '}',
  ].join('\n'))

  assert.equal(result.ok, true)
  assert.equal(result.ast?.languageVersion, '0.3')
  assert.deepEqual(result.ast?.trials, [])
  assert.equal(result.program?.trials.length, 0)
})

test('v0.4-trial example parses and compiles the complete CVE-Genie graph', () => {
  const result = runPipeline(TRIAL_SOURCE)

  assert.equal(result.ok, true)
  assert.equal(result.ast?.languageVersion, '0.4-trial')
  assert.equal(result.ast?.trials.length, 1)
  assert.equal(result.ast?.trials[0]?.nodes.length, 11)
  assert.equal(result.ast?.trials[0]?.edges.length, 16)
  assert.equal(result.ast?.trials[0]?.artifacts.length, 9)
  assert.equal(result.trialPrograms?.length, 1)
  assert.equal(result.trialPrograms?.[0]?.ast.budget.timeoutMs, 2_700_000)
  assert.equal(result.trialPrograms?.[0]?.ast.budget.maxCost, 5)
})

class CveGenieSyntheticHost implements TrialHost {
  readonly requests: TrialInvocationRequest[] = []
  private readonly counts = new Map<string, number>()

  has(): boolean {
    return true
  }

  hasCapability(): boolean {
    return true
  }

  async invoke(request: TrialInvocationRequest): Promise<TrialInvocationResult> {
    this.requests.push({
      ...request,
      input: { ...request.input },
      ...(request.feedback ? { feedback: { ...request.feedback } } : {}),
    })
    const count = (this.counts.get(request.nodeId) ?? 0) + 1
    this.counts.set(request.nodeId, count)
    let output: Record<string, string | boolean | undefined> = {}
    if (request.nodeId === 'dataProcessor') {
      output = { sourceRef: 'source-synthetic', rawEvidenceRef: 'raw-synthetic' }
    } else if (request.nodeId === 'knowledgeBuilder') {
      output = { knowledgeRef: 'knowledge-synthetic' }
    } else if (request.nodeId === 'prerequisiteDeveloper') {
      output = { prerequisiteRef: 'prerequisite-synthetic' }
    } else if (request.nodeId === 'repositoryBuilder') {
      output = {
        setupReady: count > 1,
        environmentRef: 'environment-synthetic',
        environmentSnapshotRef: 'snapshot-synthetic',
        setupEvidenceRef: 'setup-log-synthetic',
        setupAccessRef: 'access-synthetic',
      }
    } else if (request.nodeId === 'setupCritic') {
      output = count > 1
        ? { setupAccepted: true, setupPossible: true }
        : { setupAccepted: false, setupPossible: true, setupFeedbackRef: 'setup-feedback-synthetic' }
    } else if (request.nodeId === 'exploitDeveloper') {
      output = {
        exploitReady: count > 2,
        exploitRef: 'exploit-synthetic',
        exploitEvidenceRef: 'exploit-log-synthetic',
      }
    } else if (request.nodeId === 'exploitCritic') {
      output = count > 1
        ? { exploitAccepted: true, exploitPossible: true }
        : { exploitAccepted: false, exploitPossible: true, exploitFeedbackRef: 'exploit-feedback-synthetic' }
    } else if (request.nodeId === 'verifierDeveloper') {
      output = { verifierRef: 'verifier-synthetic-' + count }
    } else if (request.nodeId === 'flagChecker') {
      output = {
        flagFound: count > 2,
        verificationEvidenceRef: 'verification-synthetic',
        verifierFeedbackRef: 'verifier-feedback-synthetic',
      }
    } else if (request.nodeId === 'verifierCritic') {
      output = count > 1
        ? { verifierAccepted: true }
        : { verifierAccepted: false, verifierFeedbackRef: 'verifier-critic-feedback-synthetic' }
    } else {
      output = { reproductionArtifactRef: 'reproduction-synthetic' }
    }
    return { ok: true, output, costUsd: 0.1, elapsedMs: 1, actions: 1 }
  }
}

test('CVE-Genie graph executes feedback loops and preserves evidence', async () => {
  const result = runPipeline(TRIAL_SOURCE)
  assert.ok(result.trialPrograms?.[0])
  const host = new CveGenieSyntheticHost()
  const state = await result.trialPrograms[0].run(
    { cveId: 'CVE-SYNTHETIC-0001' },
    host,
    { runId: 'trial-cve-synthetic-1', clock: NO_WAIT_CLOCK },
  )

  assert.equal(state.status, 'succeeded')
  assert.equal(state.context.reproductionArtifactRef, 'reproduction-synthetic')
  assert.equal(state.context.feedbackRef, 'setup-feedback-synthetic')
  assert.equal(state.transitions, 25)
  assert.equal(state.receipts.length, 25)
  assert.equal(new Set(host.requests.map((request) => request.requestId)).size, host.requests.length)
  assert.ok(host.requests.every((request) => request.idempotencyKey === request.requestId))
  assert.ok(host.requests.every((request) => request.definitionDigest === state.definitionDigest))
  assert.ok(host.requests.every((request) => request.execution.network === 'deny'))
  assert.equal(state.nodeStates.repositoryBuilder?.status, 'succeeded')
  assert.equal(state.nodeStates.exploitCritic?.attempts, 2)
  assert.equal(state.nodeStates.persistReproduction?.status, 'succeeded')
  assert.equal(
    host.requests.find((request) => request.nodeId === 'repositoryBuilder' && request.feedback?.value === 'setup-feedback-synthetic')?.feedback?.value,
    'setup-feedback-synthetic',
  )
  assert.equal(
    host.requests.find((request) => request.nodeId === 'exploitDeveloper' && request.feedback?.value === 'exploit-feedback-synthetic')?.feedback?.value,
    'exploit-feedback-synthetic',
  )
  assert.ok(state.events.some((event) => event.kind === 'edge-selected'))
  assert.ok(state.events.some((event) => event.kind === 'succeeded'))
})

const SMALL_TRIAL = [
  'dsl version "0.4-trial"',
  'domain SmallTrial version "1.0.0"',
  'port Work version "1.0.0" {',
  '  in {',
  '    token: String',
  '  }',
  '  out {',
  '    result: String',
  '  }',
  '  effect ffi',
  '}',
  'trial Retryable title "Retryable" {',
  '  input {',
  '    token: String required',
  '  }',
  '  budget { timeout 10s cost 5 maxTransitions 5 }',
  '  execution { class ai isolation disposable network deny }',
  '  start work',
  '  terminal { work }',
  '  nodes {',
  '    work "Work" {',
  '      uses { token }',
  '      call Work',
  '      output { result: String }',
  '      retry { max 2 backoff 0s }',
  '    }',
  '  }',
  '}',
].join('\n')

test('failed calls retry and durable checkpoints avoid duplicate invocation', async () => {
  const result = runPipeline(SMALL_TRIAL)
  assert.equal(result.ok, true)
  assert.ok(result.trialPrograms?.[0])
  let calls = 0
  const host: TrialHost = {
    has: () => true,
    invoke: () => {
      calls += 1
      return calls === 1
        ? { ok: false, output: {}, retryable: true, error: { code: 'temporary', message: 'retry me' } }
        : { ok: true, output: { result: 'done' } }
    },
  }
  const retried = await result.trialPrograms[0].run(
    { token: 'synthetic' },
    host,
    { runId: 'trial-retry-synthetic', clock: NO_WAIT_CLOCK },
  )
  assert.equal(retried.status, 'succeeded')
  assert.equal(calls, 2)
  assert.ok(retried.events.some((event) => event.kind === 'node-retry'))

  class CrashOnceStore extends InMemoryTrialStateStore {
    private crashed = false
    override save(state: TrialRunState): void {
      super.save(state)
      if (!this.crashed && Object.keys(state.calls).length > 0 && state.pending) {
        this.crashed = true
        throw new Error('synthetic worker crash after receipt checkpoint')
      }
    }
  }
  const checkpointStore: TrialStateStore = new CrashOnceStore()
  let checkpointCalls = 0
  const checkpointHost: TrialHost = {
    has: () => true,
    invoke: () => {
      checkpointCalls += 1
      return { ok: true, output: { result: 'checkpointed' } }
    },
  }
  await assert.rejects(() => result.trialPrograms[0].run(
    { token: 'synthetic' },
    checkpointHost,
    { runId: 'trial-checkpoint-synthetic', clock: NO_WAIT_CLOCK, store: checkpointStore },
  ))
  const resumed = await result.trialPrograms[0].run(
    { token: 'synthetic' },
    checkpointHost,
    { runId: 'trial-checkpoint-synthetic', clock: NO_WAIT_CLOCK, store: checkpointStore },
  )
  assert.equal(resumed.status, 'succeeded')
  assert.equal(checkpointCalls, 1)
  assert.ok(resumed.events.some((event) => event.kind === 'receipt-replayed'))
  assert.equal(
    serializeTrialRun(deserializeTrialRun(serializeTrialRun(resumed))),
    serializeTrialRun(resumed),
  )

  class ResponseWithoutPendingStore extends InMemoryTrialStateStore {
    private dropped = false
    override save(state: TrialRunState): void {
      super.save(state)
      if (!this.dropped && state.pending) {
        this.dropped = true
        const persisted = this.load(state.id)!
        delete persisted.pending
        super.save(persisted)
        throw new Error('synthetic crash after response without pending marker')
      }
    }
  }
  const orphanStore = new ResponseWithoutPendingStore()
  let orphanCalls = 0
  const orphanHost: TrialHost = {
    has: () => true,
    invoke: () => {
      orphanCalls += 1
      return { ok: true, output: { result: 'orphan-checkpoint' } }
    },
  }
  await assert.rejects(() => result.trialPrograms[0].run(
    { token: 'synthetic' },
    orphanHost,
    { runId: 'trial-orphan-checkpoint-synthetic', clock: NO_WAIT_CLOCK, store: orphanStore },
  ))
  const orphanResumed = await result.trialPrograms[0].run(
    { token: 'synthetic' },
    orphanHost,
    { runId: 'trial-orphan-checkpoint-synthetic', clock: NO_WAIT_CLOCK, store: orphanStore },
  )
  assert.equal(orphanResumed.status, 'succeeded')
  assert.equal(orphanCalls, 1)
})

test('waiting continuation, cancellation, and cost budgets are durable', async () => {
  const result = runPipeline(SMALL_TRIAL)
  assert.equal(result.ok, true)
  assert.ok(result.trialPrograms?.[0])
  const store = new InMemoryTrialStateStore()
  let calls = 0
  const host: TrialHost = {
    has: () => true,
    invoke: () => {
      calls += 1
      return calls === 1
        ? { ok: true, status: 'waiting', output: {} }
        : { ok: true, output: { result: 'done' } }
    },
  }
  const waiting = await result.trialPrograms[0].run(
    { token: 'synthetic' },
    host,
    { runId: 'trial-waiting-synthetic', clock: NO_WAIT_CLOCK, store },
  )
  assert.equal(waiting.status, 'waiting')
  const continued = await result.trialPrograms[0].resume(
    'trial-waiting-synthetic',
    host,
    { clock: NO_WAIT_CLOCK, store, output: { result: 'continued' } },
  )
  assert.equal(continued.status, 'succeeded')
  assert.equal(continued.context.result, 'continued')
  assert.equal(calls, 1)

  const cancelledStore = new InMemoryTrialStateStore()
  const cancelledWaiting = await result.trialPrograms[0].run(
    { token: 'synthetic' },
    { has: () => true, invoke: () => ({ ok: true, status: 'waiting', output: {} }) },
    { runId: 'trial-cancel-synthetic', clock: NO_WAIT_CLOCK, store: cancelledStore },
  )
  assert.equal(cancelledWaiting.status, 'waiting')
  assert.equal(result.trialPrograms[0].cancel('trial-cancel-synthetic', cancelledStore).status, 'cancelled')

  const budgetPipeline = runPipeline(SMALL_TRIAL.replace('cost 5', 'cost 0.01'))
  assert.equal(budgetPipeline.ok, true)
  assert.ok(budgetPipeline.trialPrograms?.[0])
  const budget = await budgetPipeline.trialPrograms[0].run(
    { token: 'synthetic' },
    { has: () => true, invoke: () => ({ ok: true, output: { result: 'expensive' }, costUsd: 0.02 }) },
    { runId: 'trial-budget-synthetic', clock: NO_WAIT_CLOCK },
  )
  assert.equal(budget.status, 'failed')
  assert.equal(budget.error?.code, 'trial-cost-budget')
})

test('trial admission fails closed for network, action, and node-time budgets', async () => {
  const networkPipeline = runPipeline(SMALL_TRIAL.replace('network deny', 'network allow'))
  assert.equal(networkPipeline.ok, true)
  assert.ok(networkPipeline.trialPrograms?.[0])
  const networkDenied = await networkPipeline.trialPrograms[0].run(
    { token: 'synthetic' },
    { has: () => true, invoke: () => ({ ok: true, output: { result: 'unexpected' } }) },
    { runId: 'trial-network-synthetic', clock: NO_WAIT_CLOCK },
  )
  assert.equal(networkDenied.error?.code, 'network-not-admitted')

  const actionSource = SMALL_TRIAL.replace(
    '      retry { max 2 backoff 0s }',
    '      retry { max 2 backoff 0s }\n      maxActions 1',
  )
  const actionPipeline = runPipeline(actionSource)
  assert.equal(actionPipeline.ok, true)
  assert.ok(actionPipeline.trialPrograms?.[0])
  const actionDenied = await actionPipeline.trialPrograms[0].run(
    { token: 'synthetic' },
    { has: () => true, invoke: () => ({ ok: true, output: { result: 'too many actions' }, actions: 2 }) },
    { runId: 'trial-action-synthetic', clock: NO_WAIT_CLOCK },
  )
  assert.equal(actionDenied.error?.code, 'trial-action-budget')

  const timeoutSource = SMALL_TRIAL.replace(
    '      retry { max 2 backoff 0s }',
    '      retry { max 2 backoff 0s }\n      timeout 1ms',
  )
  const timeoutPipeline = runPipeline(timeoutSource)
  assert.equal(timeoutPipeline.ok, true)
  assert.ok(timeoutPipeline.trialPrograms?.[0])
  const timedOut = await timeoutPipeline.trialPrograms[0].run(
    { token: 'synthetic' },
    { has: () => true, invoke: () => ({ ok: true, output: { result: 'slow' }, elapsedMs: 2 }) },
    { runId: 'trial-timeout-synthetic', clock: NO_WAIT_CLOCK },
  )
  assert.equal(timedOut.error?.code, 'trial-node-timeout')
})

test('trial validation rejects an unversioned graph and an out-of-scope edge condition', () => {
  const withoutVersion = runPipeline(SMALL_TRIAL.replace('dsl version "0.4-trial"\n', ''))
  assert.equal(withoutVersion.ok, false)
  assert.match(withoutVersion.parseErrors.map((error) => error.message).join('; '), /0\.4-trial/u)

  const invalid = SMALL_TRIAL.replace(
    '  terminal { work }',
    '  terminal { work }\n  edges {\n    edge work -> work when "unknownFlag == true"\n  }',
  )
  const invalidResult = runPipeline(invalid)
  assert.equal(invalidResult.ok, false)
  assert.ok(invalidResult.issues.some((issue) => issue.code === 'E_TRIAL_CONDITION_VALUE'))
  assert.ok(invalidResult.issues.some((issue) => issue.code === 'E_TRIAL_CONDITION_SCOPE'))

  const weakenedOutput = runPipeline(SMALL_TRIAL.replace(
    'output { result: String }',
    'output { result: String? }',
  ))
  assert.equal(weakenedOutput.ok, false)
  assert.ok(weakenedOutput.issues.some((issue) => issue.code === 'E_TRIAL_OUTPUT_DECL'))

  const invalidBudget = runPipeline(SMALL_TRIAL.replace('cost 5', 'cost not-a-number'))
  assert.equal(invalidBudget.ok, false)
  assert.ok(invalidBudget.issues.some((issue) => issue.code === 'E_TRIAL_COST'))
})

test('trial conditions are parsed safely and missing values fail closed', () => {
  assert.equal(isTrialConditionSyntax('(accepted == true || verdict == "ok") && attempt < 3'), true)
  assert.equal(evaluateTrialCondition('(accepted == true || verdict == "ok") && attempt < 3', {
    accepted: false,
    verdict: 'ok',
    attempt: 2,
  }), true)
  assert.equal(evaluateTrialCondition('attempt >= 3', { attempt: 3 }), true)
  assert.equal(evaluateTrialCondition('missing != true', {}), false)
  assert.equal(evaluateTrialCondition('accepted == true ||', { accepted: true }), false)
  assert.equal(isTrialConditionSyntax('accepted == true; process.exit()'), false)
})

test('trial runtime rejects undeclared outputs and redacts bounded artifacts', async () => {
  const strictPipeline = runPipeline(SMALL_TRIAL)
  assert.equal(strictPipeline.ok, true)
  assert.ok(strictPipeline.trialPrograms?.[0])
  const undeclared = await strictPipeline.trialPrograms[0].run(
    { token: 'synthetic' },
    { has: () => true, invoke: () => ({ ok: true, output: { result: 'done', secret: 'not-declared' } }) },
    { runId: 'trial-undeclared-output-synthetic', clock: NO_WAIT_CLOCK },
  )
  assert.equal(undeclared.status, 'failed')
  assert.equal(undeclared.error?.code, 'trial-output-undeclared')

  const artifactSource = SMALL_TRIAL.replace(
    '  nodes {',
    '  artifacts {\n    token: String kind report redacted\n  }\n  nodes {',
  )
  const artifactPipeline = runPipeline(artifactSource)
  assert.equal(artifactPipeline.ok, true)
  assert.ok(artifactPipeline.trialPrograms?.[0])
  const artifactRun = await artifactPipeline.trialPrograms[0].run(
    { token: 'synthetic' },
    {
      has: () => true,
      invoke: () => ({
        ok: true,
        output: { result: 'done' },
        artifacts: [{
          id: 'artifact-synthetic',
          name: 'token',
          kind: 'report',
          nodeId: 'work',
          size: 6,
          redacted: false,
          ref: 'opaque-token',
          content: 'secret',
        }],
      }),
    },
    { runId: 'trial-redacted-artifact-synthetic', clock: NO_WAIT_CLOCK },
  )
  assert.equal(artifactRun.status, 'succeeded')
  const redacted = artifactRun.artifacts.find((artifact) => artifact.id === 'artifact-synthetic')
  assert.equal(redacted?.redacted, true)
  assert.equal(redacted?.content, undefined)
  assert.match(redacted?.digest ?? '', /^sha256:[0-9a-f]{64}$/u)
})

test('resuming a waiting node is checkpointed before routing', async () => {
  const result = runPipeline(SMALL_TRIAL)
  assert.equal(result.ok, true)
  assert.ok(result.trialPrograms?.[0])
  const store = new InMemoryTrialStateStore()
  let calls = 0
  const host: TrialHost = {
    has: () => true,
    invoke: () => {
      calls += 1
      return { ok: true, status: 'waiting', output: {} }
    },
  }
  await result.trialPrograms[0].run(
    { token: 'synthetic' },
    host,
    { runId: 'trial-resume-checkpoint-synthetic', clock: NO_WAIT_CLOCK, store },
  )

  class CrashOnResumeStore extends InMemoryTrialStateStore {
    private crashed = false
    override save(state: TrialRunState): void {
      super.save(state)
      if (!this.crashed && state.pending?.result.output.result === 'continued') {
        this.crashed = true
        throw new Error('synthetic crash after continuation checkpoint')
      }
    }
  }
  // Copy the waiting state into a store that can fail during the resume save.
  const resumeStore = new CrashOnResumeStore()
  resumeStore.save(store.load('trial-resume-checkpoint-synthetic')!)
  await assert.rejects(() => result.trialPrograms[0].resume(
    'trial-resume-checkpoint-synthetic',
    host,
    { clock: NO_WAIT_CLOCK, store: resumeStore, output: { result: 'continued' } },
  ))
  const resumed = await result.trialPrograms[0].resume(
    'trial-resume-checkpoint-synthetic',
    host,
    { clock: NO_WAIT_CLOCK, store: resumeStore },
  )
  assert.equal(resumed.status, 'succeeded')
  assert.equal(calls, 1)
  assert.ok(resumed.events.some((event) => event.kind === 'receipt-replayed'))
})

test('cancellation during a Host call remains terminal and retains its receipt', async () => {
  const result = runPipeline(SMALL_TRIAL)
  assert.equal(result.ok, true)
  assert.ok(result.trialPrograms?.[0])
  const store = new InMemoryTrialStateStore()
  let release: ((result: TrialInvocationResult) => void) | undefined
  let enteredResolve: (() => void) | undefined
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve
  })
  let calls = 0
  const host: TrialHost = {
    has: () => true,
    invoke: () => {
      calls += 1
      enteredResolve?.()
      return new Promise<TrialInvocationResult>((resolve) => {
        release = resolve
      })
    },
  }
  const running = result.trialPrograms[0].run(
    { token: 'synthetic' },
    host,
    { runId: 'trial-cancel-inflight-synthetic', clock: NO_WAIT_CLOCK, store },
  )
  await entered
  const cancelled = result.trialPrograms[0].cancel('trial-cancel-inflight-synthetic', store)
  release?.({ ok: true, output: { result: 'late' } })
  const completed = await running
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(completed.status, 'cancelled')
  assert.equal(completed.currentNode, null)
  assert.equal(completed.receipts.length, 1)
  assert.equal(calls, 1)
})
