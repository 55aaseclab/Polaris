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
  kind: EvolutionEventKind;
  timestamp: string;
  payload: Record<string, unknown>;
}

export type EvolutionArtifactKind =
  | "user-preference"
  | "workspace-playbook"
  | "verified-lesson"
  | "discarded-observation";

export type EvolutionArtifactScope = "workspace" | "user";

export interface EvolutionArtifact {
  id: string;
  workspaceId: string;
  userProfileId?: string;
  kind: EvolutionArtifactKind;
  scope: EvolutionArtifactScope;
  title: string;
  content: string;
  confidence: number;
  status: "active" | "archived" | "suppressed";
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
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
  artifacts: EvolutionArtifact[];
}

export interface EvolutionRetrievalQuery {
  workspaceId: string;
  userProfileId?: string;
  kinds?: EvolutionArtifactKind[];
  text?: string;
  limit?: number;
}

export interface EvolutionCuratorResult {
  mergedIds: string[];
  archivedIds: string[];
  suppressedIds: string[];
  promotedIds?: string[];
  decayedIds?: string[];
  details?: Array<{
    artifactId: string;
    action: "promoted" | "merged" | "archived" | "suppressed" | "decayed" | "kept";
    reason: string;
    targetArtifactId?: string;
  }>;
}
