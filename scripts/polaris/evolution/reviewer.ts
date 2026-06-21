import { randomUUID } from "node:crypto";
import type {
  EvolutionArtifact,
  EvolutionReviewCandidate,
  EvolutionReviewResult,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function classifyEvent(candidate: EvolutionReviewCandidate): EvolutionArtifact[] {
  const artifacts: EvolutionArtifact[] = [];
  const textPayload = candidate.events
    .map((event) => JSON.stringify(event.payload))
    .join("\n")
    .toLowerCase();

  if (textPayload.includes("prefer") || textPayload.includes("verbose") || textPayload.includes("format")) {
    artifacts.push({
      id: randomUUID(),
      workspaceId: candidate.workspaceId,
      userProfileId: candidate.userProfileId,
      kind: "user-preference",
      scope: "user",
      title: "Recovered operator preference",
      content: "The operator expressed a durable execution or formatting preference in this session.",
      confidence: 0.55,
      status: "active",
      sourceSessionId: candidate.sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: { managerId: candidate.managerId },
    });
  }

  if (candidate.events.some((event) => event.kind === "task-failed" || event.kind === "tool-result")) {
    artifacts.push({
      id: randomUUID(),
      workspaceId: candidate.workspaceId,
      kind: "workspace-playbook",
      scope: "workspace",
      title: "Recovered workflow lesson",
      content: "This session produced an actionable workflow, troubleshooting step, or validation recipe worth reusing in the workspace.",
      confidence: 0.6,
      status: "active",
      sourceSessionId: candidate.sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: { managerId: candidate.managerId, eventCount: candidate.events.length },
    });
  }

  if (artifacts.length === 0) {
    artifacts.push({
      id: randomUUID(),
      workspaceId: candidate.workspaceId,
      userProfileId: candidate.userProfileId,
      kind: "discarded-observation",
      scope: "workspace",
      title: "No durable lesson",
      content: "The reviewer found no durable learning item in this session.",
      confidence: 0.1,
      status: "suppressed",
      sourceSessionId: candidate.sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: { managerId: candidate.managerId },
    });
  }

  return artifacts;
}

export async function reviewExecutionCandidate(
  candidate: EvolutionReviewCandidate,
): Promise<EvolutionReviewResult> {
  return {
    artifacts: classifyEvent(candidate),
  };
}
