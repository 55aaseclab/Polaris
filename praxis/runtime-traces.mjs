const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const version = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const status = value => ['queued','running','waiting','succeeded','failed','cancelled','unknown'].includes(value)?value:'unknown';
export function normalizeRuntimeRun(run) {
  if (!safeId(run?.runId) || !Number.isSafeInteger(run.cursor) || run.cursor < 1 || !Array.isArray(run.steps) || run.steps.length > 8 || !Array.isArray(run.artifactRefs)) throw Error('Invalid runtime metadata.');
  const href = run.nativeHref;
  if (typeof href !== 'string' || !href.startsWith('/apps/polaris/') || /[\\\s]|%(?:2e|2f|5c)|(?:^|\/)\.{1,2}(?:\/|$)/i.test(href.split(/[?#]/, 1)[0])) throw Error('Invalid native runtime reference.');
  const reference = { appId: 'polaris', resourceId: run.runId, href };
  const workflow = safeId(run.flowId) ? { id: run.flowId, runId: run.runId, ...(version(run.flowVersion) ? { version: run.flowVersion } : {}) } : null;
  const steps = run.steps.map(step => {
    if (!safeId(step?.stepId)) throw Error('Invalid runtime step.');
    return { stage: 'runtime', stepId: step.stepId, status: step.status === 'completed' ? 'succeeded' : status(step.status), at: timestamp(step.completedAt) || timestamp(step.createdAt), reference,
      ...(version(step.version) ? { revision: step.version, revisionRecorded: true } : {}) };
  });
  const artifactRefs = run.artifactRefs.filter(value => typeof value === 'string' && /^artifact:[a-f0-9]{64}$/.test(value)).slice(0, 8);
  const count = (value, minimum) => Number.isSafeInteger(value) && value >= minimum ? value : minimum;
  return { id: `runtime:${run.runId}`, cursor: run.cursor, kind: 'runtime', appId: 'polaris', operation: workflow?.id || 'workflow_run', at: timestamp(run.startedAt) || timestamp(run.createdAt) || timestamp(run.updatedAt), updatedAt: timestamp(run.updatedAt), status: status(run.status),
    committed: null, readback: 'not_recorded', reference, workflowRecorded: Boolean(workflow), ...(workflow ? { workflow } : {}), steps,
    runtime: { runId: run.runId, ...(safeId(run.packId) ? { packId: run.packId } : {}), ...(version(run.packVersion) ? { packVersion: run.packVersion } : {}),
      createdAt: timestamp(run.createdAt), startedAt: timestamp(run.startedAt), updatedAt: timestamp(run.updatedAt), stepCount: count(run.stepCount, steps.length), artifactCount: count(run.artifactCount, artifactRefs.length), artifactRefs } };
}
