import type { EvolutionMemoryCuratorResult, EvolutionMemoryEntry } from "./types.js";

function withCuratorMetadata(
  entry: EvolutionMemoryEntry,
  params: {
    action: "promoted" | "archived" | "suppressed" | "kept";
    reason: string;
    status?: EvolutionMemoryEntry["status"];
  },
): EvolutionMemoryEntry {
  const history = Array.isArray((entry.metadata as Record<string, unknown>).curationHistory)
    ? ([...(entry.metadata as Record<string, unknown>).curationHistory as unknown[]] as Record<string, unknown>[])
    : [];
  history.push({
    action: params.action,
    reason: params.reason,
    at: new Date().toISOString(),
  });
  return {
    ...entry,
    status: params.status ?? entry.status,
    updatedAt: new Date().toISOString(),
    metadata: {
      ...entry.metadata,
      curator: {
        action: params.action,
        reason: params.reason,
      },
      curationHistory: history,
      explainability: {
        ...((entry.metadata as Record<string, unknown>).explainability as Record<string, unknown> | undefined),
        existsBecause: String(
          ((entry.metadata as Record<string, unknown>).explainability as Record<string, unknown> | undefined)?.existsBecause
            ?? entry.body,
        ),
        ...(params.action === "suppressed" ? { suppressedBecause: params.reason } : {}),
      },
    },
  };
}

export function curateMemoryEntries(entries: EvolutionMemoryEntry[]): EvolutionMemoryCuratorResult {
  const activeBySignature = new Map<string, EvolutionMemoryEntry>();
  const archivedIds: string[] = [];
  const suppressedIds: string[] = [];
  const promotedIds: string[] = [];
  const details: EvolutionMemoryCuratorResult["details"] = [];
  for (const entry of entries) {
    const signature = `${entry.target}:${entry.section}:${entry.key}`;
    const existing = activeBySignature.get(signature);
    if (!existing) {
      activeBySignature.set(signature, entry);
      details.push({ entryId: entry.id, action: "kept", reason: "first active entry for signature" });
      continue;
    }
    if (entry.confidence >= existing.confidence) {
      archivedIds.push(existing.id);
      activeBySignature.set(signature, entry);
      details.push({ entryId: existing.id, action: "archived", reason: "replaced by higher-confidence entry" });
      details.push({ entryId: entry.id, action: "kept", reason: "higher-confidence entry for signature" });
      continue;
    }
    archivedIds.push(entry.id);
    details.push({ entryId: entry.id, action: "archived", reason: "lower-confidence duplicate entry" });
  }
  for (const entry of activeBySignature.values()) {
    if (entry.confidence < 0.2) {
      suppressedIds.push(entry.id);
      details.push({ entryId: entry.id, action: "suppressed", reason: "confidence below threshold" });
    } else if (entry.confidence >= 0.85) {
      promotedIds.push(entry.id);
      details.push({ entryId: entry.id, action: "promoted", reason: "high-confidence memory entry" });
    }
  }
  return { archivedIds, suppressedIds, promotedIds, details };
}

export function applyCuratorResult(entries: EvolutionMemoryEntry[]): EvolutionMemoryEntry[] {
  const result = curateMemoryEntries(entries);
  const archived = new Set(result.archivedIds);
  const suppressed = new Set(result.suppressedIds);
  const promoted = new Set(result.promotedIds);
  const detailById = new Map(result.details.map((detail) => [detail.entryId, detail]));
  return entries.map((entry) => {
    const detail = detailById.get(entry.id);
    if (!detail) {
      return entry;
    }
    if (archived.has(entry.id)) {
      return withCuratorMetadata(entry, {
        action: detail.action,
        reason: detail.reason,
        status: "archived",
      });
    }
    if (suppressed.has(entry.id)) {
      return withCuratorMetadata(entry, {
        action: detail.action,
        reason: detail.reason,
        status: "suppressed",
      });
    }
    if (promoted.has(entry.id)) {
      return withCuratorMetadata(entry, {
        action: detail.action,
        reason: detail.reason,
      });
    }
    return entry;
  });
}
