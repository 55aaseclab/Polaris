import { randomUUID } from "node:crypto";
import type {
  EvolutionMemoryChange,
  EvolutionReviewCandidate,
  EvolutionReviewResult,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function buildChange(
  candidate: EvolutionReviewCandidate,
  params: {
    target: EvolutionMemoryChange["target"];
    section: string;
    key: string;
    title: string;
    body: string;
    reason: string;
    confidence: number;
  },
): EvolutionMemoryChange {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    workspaceId: candidate.workspaceId,
    userProfileId: candidate.userProfileId,
    target: params.target,
    operation: "replace",
    section: params.section,
    key: params.key,
    candidate: {
      title: params.title,
      body: params.body,
    },
    reason: params.reason,
    confidence: params.confidence,
    sourceSessionId: candidate.sessionId,
    sourceRunIds: [candidate.sessionId],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "pending",
    metadata: {
      managerId: candidate.managerId,
      eventCount: candidate.events.length,
    },
  };
}

function classifyEvent(candidate: EvolutionReviewCandidate): EvolutionMemoryChange[] {
  const textPayload = candidate.events
    .map((event) => JSON.stringify(event.payload))
    .join("\n")
    .toLowerCase();
  const changes: EvolutionMemoryChange[] = [];

  if (textPayload.includes("prefer") || textPayload.includes("concise") || textPayload.includes("verbose")) {
    changes.push(buildChange(candidate, {
      target: "user-memory",
      section: "Preferences",
      key: "response-style",
      title: "Operator response style",
      body: "Prefer concise, direct responses unless extra detail is explicitly requested.",
      reason: "Repeated durable response-style preference detected in session output.",
      confidence: 0.72,
    }));
  }

  if (
    textPayload.includes("verifier")
    || textPayload.includes("verification")
    || candidate.events.some((event) => event.kind === "task-failed" || event.kind === "tool-result")
  ) {
    changes.push(buildChange(candidate, {
      target: "workspace-memory",
      section: "Validation",
      key: "run-verifier-first",
      title: "Run verifier before retrying",
      body: "Use the verifier before repeating the same failing command in this workspace.",
      reason: "Session produced a durable validation or retry workflow fact.",
      confidence: 0.68,
    }));
  }

  if (changes.length === 0 && textPayload.includes("401")) {
    changes.push(buildChange(candidate, {
      target: "workspace-memory",
      section: "Environment",
      key: "auth-failure-pattern",
      title: "Authentication failure recovery",
      body: "When a 401 appears, verify workspace auth material before retrying the same task.",
      reason: "Session exposed a durable authentication recovery fact.",
      confidence: 0.62,
    }));
  }

  return changes;
}

export async function reviewExecutionCandidate(
  candidate: EvolutionReviewCandidate,
): Promise<EvolutionReviewResult> {
  return {
    changes: classifyEvent(candidate),
  };
}
