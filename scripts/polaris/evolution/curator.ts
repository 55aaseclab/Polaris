import type { EvolutionArtifact, EvolutionCuratorResult } from "./types.js";
import { EvolutionStore } from "./store.js";

export function curateArtifacts(artifacts: EvolutionArtifact[]): EvolutionCuratorResult {
  const bySignature = new Map<string, EvolutionArtifact>();
  const mergedIds: string[] = [];
  const archivedIds: string[] = [];
  const suppressedIds: string[] = [];

  for (const artifact of artifacts) {
    const signature = `${artifact.scope}:${artifact.kind}:${artifact.title.trim().toLowerCase()}`;
    const existing = bySignature.get(signature);
    if (!existing) {
      bySignature.set(signature, artifact);
      continue;
    }
    if (artifact.confidence > existing.confidence) {
      archivedIds.push(existing.id);
      bySignature.set(signature, artifact);
      mergedIds.push(artifact.id);
      continue;
    }
    archivedIds.push(artifact.id);
  }

  for (const artifact of bySignature.values()) {
    if (artifact.confidence < 0.2 && artifact.status === "active") {
      suppressedIds.push(artifact.id);
    }
  }

  return { mergedIds, archivedIds, suppressedIds };
}

export function applyCuratorResult(
  store: EvolutionStore,
  artifacts: EvolutionArtifact[],
): EvolutionCuratorResult {
  const result = curateArtifacts(artifacts);
  store.archiveArtifacts(result.archivedIds);
  store.archiveArtifacts(result.suppressedIds);
  return result;
}
