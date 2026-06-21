import type { EvolutionArtifact, EvolutionCuratorResult } from "./types.js";
import { EvolutionStore } from "./store.js";

function withCuratorMetadata(
  artifact: EvolutionArtifact,
  params: {
    action: "promoted" | "merged" | "archived" | "suppressed" | "decayed" | "kept";
    reason: string;
    status?: EvolutionArtifact["status"];
    targetArtifactId?: string;
  },
): EvolutionArtifact {
  const history = Array.isArray((artifact.metadata as Record<string, unknown>).curationHistory)
    ? ([...(artifact.metadata as Record<string, unknown>).curationHistory as unknown[]] as Record<string, unknown>[])
    : [];
  const entry: Record<string, unknown> = {
    action: params.action,
    reason: params.reason,
    at: new Date().toISOString(),
  };
  if (params.targetArtifactId) {
    entry.targetArtifactId = params.targetArtifactId;
  }
  history.push(entry);
  return {
    ...artifact,
    status: params.status ?? artifact.status,
    updatedAt: new Date().toISOString(),
    metadata: {
      ...artifact.metadata,
      curator: {
        action: params.action,
        reason: params.reason,
        ...(params.targetArtifactId ? { targetArtifactId: params.targetArtifactId } : {}),
      },
      curationHistory: history,
      explainability: {
        ...((artifact.metadata as Record<string, unknown>).explainability as Record<string, unknown> | undefined),
        existsBecause: String(
          ((artifact.metadata as Record<string, unknown>).explainability as Record<string, unknown> | undefined)?.existsBecause ??
          artifact.content,
        ),
        ...(params.action === "suppressed" ? { suppressedBecause: params.reason } : {}),
      },
    },
  };
}

export function curateArtifacts(artifacts: EvolutionArtifact[]): EvolutionCuratorResult {
  const bySignature = new Map<string, EvolutionArtifact>();
  const mergedIds: string[] = [];
  const archivedIds: string[] = [];
  const suppressedIds: string[] = [];
  const promotedIds: string[] = [];
  const decayedIds: string[] = [];
  const details: NonNullable<EvolutionCuratorResult["details"]> = [];

  for (const artifact of artifacts) {
    const signature = `${artifact.scope}:${artifact.kind}:${artifact.title.trim().toLowerCase()}`;
    const existing = bySignature.get(signature);
    if (!existing) {
      bySignature.set(signature, artifact);
      details.push({ artifactId: artifact.id, action: "kept", reason: "first artifact for signature" });
      continue;
    }
    if (artifact.confidence > existing.confidence) {
      archivedIds.push(existing.id);
      bySignature.set(signature, artifact);
      mergedIds.push(artifact.id);
      details.push({
        artifactId: existing.id,
        action: "archived",
        reason: "lower-confidence duplicate was replaced",
        targetArtifactId: artifact.id,
      });
      details.push({
        artifactId: artifact.id,
        action: "merged",
        reason: "higher-confidence duplicate kept for signature",
        targetArtifactId: existing.id,
      });
      continue;
    }
    archivedIds.push(artifact.id);
    details.push({
      artifactId: artifact.id,
      action: "archived",
      reason: "duplicate signature with lower confidence",
      targetArtifactId: existing.id,
    });
  }

  for (const artifact of bySignature.values()) {
    if (artifact.confidence < 0.2 && artifact.status === "active") {
      suppressedIds.push(artifact.id);
      details.push({
        artifactId: artifact.id,
        action: "suppressed",
        reason: "confidence below suppression threshold",
      });
      continue;
    }
    const updatedAtMs = Date.parse(artifact.updatedAt);
    if (!Number.isNaN(updatedAtMs)) {
      const ageDays = (Date.now() - updatedAtMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 30 && artifact.confidence < 0.5) {
        decayedIds.push(artifact.id);
        details.push({
          artifactId: artifact.id,
          action: "decayed",
          reason: "stale low-confidence artifact",
        });
        continue;
      }
    }
    if (artifact.confidence >= 0.85 && artifact.status === "active") {
      promotedIds.push(artifact.id);
      details.push({
        artifactId: artifact.id,
        action: "promoted",
        reason: "high-confidence active artifact",
      });
    }
  }

  return { mergedIds, archivedIds, suppressedIds, promotedIds, decayedIds, details };
}

export function applyCuratorResult(
  store: EvolutionStore,
  artifacts: EvolutionArtifact[],
): EvolutionCuratorResult {
  const result = curateArtifacts(artifacts);
  const archived = new Set(result.archivedIds);
  const suppressed = new Set(result.suppressedIds);
  const decayed = new Set(result.decayedIds ?? []);
  const promoted = new Set(result.promotedIds ?? []);
  const detailById = new Map((result.details ?? []).map((detail) => [detail.artifactId, detail]));
  for (const artifact of artifacts) {
    const detail = detailById.get(artifact.id);
    if (!detail) {
      continue;
    }
    if (archived.has(artifact.id)) {
      store.upsertArtifact(withCuratorMetadata(artifact, {
        action: detail.action,
        reason: detail.reason,
        status: "archived",
        targetArtifactId: detail.targetArtifactId,
      }));
      continue;
    }
    if (suppressed.has(artifact.id)) {
      store.upsertArtifact(withCuratorMetadata(artifact, {
        action: detail.action,
        reason: detail.reason,
        status: "suppressed",
      }));
      continue;
    }
    if (decayed.has(artifact.id)) {
      store.upsertArtifact(withCuratorMetadata(artifact, {
        action: detail.action,
        reason: detail.reason,
        status: "archived",
      }));
      continue;
    }
    if (promoted.has(artifact.id)) {
      store.upsertArtifact(withCuratorMetadata(artifact, {
        action: detail.action,
        reason: detail.reason,
      }));
    }
  }
  return result;
}
