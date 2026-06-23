export type EvolutionEventKind =
  | "task-started"
  | "task-input"
  | "task-output"
  | "task-completed"
  | "task-failed"
  | "tool-call"
  | "tool-result";

export interface EvolutionExecutionEvent {
  id: string;
  workspaceId: string;
  managerId: string;
  sessionId: string;
  turnId?: string;
  timestamp: string;
  kind: EvolutionEventKind;
  payload: Record<string, unknown>;
}

export type EvolutionMemoryTarget = "workspace-memory" | "user-memory";
export type EvolutionMemoryOperation = "add" | "replace" | "remove";
export type EvolutionMemoryStatus = "active" | "archived" | "suppressed";
export type EvolutionMemoryChangeStatus = "pending" | "approved" | "rejected" | "applied";

export interface EvolutionMemoryEntry {
  id: string;
  workspaceId: string;
  userProfileId?: string;
  target: EvolutionMemoryTarget;
  section: string;
  key: string;
  title: string;
  body: string;
  confidence: number;
  status: EvolutionMemoryStatus;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface EvolutionMemoryCandidate {
  title: string;
  body: string;
}

export interface EvolutionMemoryChange {
  id: string;
  workspaceId: string;
  userProfileId?: string;
  target: EvolutionMemoryTarget;
  operation: EvolutionMemoryOperation;
  section: string;
  key: string;
  candidate?: EvolutionMemoryCandidate;
  reason: string;
  confidence: number;
  sourceSessionId?: string;
  sourceRunIds?: string[];
  createdAt: string;
  updatedAt: string;
  status: EvolutionMemoryChangeStatus;
  metadata: Record<string, unknown>;
}

export interface EvolutionReviewCandidate {
  workspaceId: string;
  userProfileId: string;
  managerId: string;
  sessionId: string;
  events: EvolutionExecutionEvent[];
}

export interface EvolutionReviewResult {
  changes: EvolutionMemoryChange[];
}

export interface EvolutionMemoryQuery {
  workspaceId: string;
  userProfileId?: string;
  target?: EvolutionMemoryTarget;
  section?: string;
  text?: string;
  limit?: number;
}

export interface EvolutionMemoryProviderEntry {
  source: string;
  title: string;
  body: string;
  score?: number;
}

export interface EvolutionMemoryCuratorResult {
  archivedIds: string[];
  suppressedIds: string[];
  promotedIds: string[];
  details: Array<{
    entryId: string;
    action: "promoted" | "archived" | "suppressed" | "kept";
    reason: string;
  }>;
}
