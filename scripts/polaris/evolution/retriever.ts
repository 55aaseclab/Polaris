import type { EvolutionArtifact } from "./types.js";
import { EvolutionStore } from "./store.js";

export interface RetrievalContext {
  workspaceId: string;
  userProfileId?: string;
  prompt: string;
  limit?: number;
}

export async function retrieveEvolutionContext(
  store: EvolutionStore,
  context: RetrievalContext,
): Promise<EvolutionArtifact[]> {
  return store.queryArtifacts({
    workspaceId: context.workspaceId,
    userProfileId: context.userProfileId,
    text: context.prompt,
    limit: context.limit ?? 8,
  });
}

export function renderRetrievedArtifacts(artifacts: EvolutionArtifact[]): string {
  if (artifacts.length === 0) {
    return "";
  }
  return [
    "Relevant prior lessons:",
    ...artifacts.map((artifact) => `- [${artifact.kind}] ${artifact.title}: ${artifact.content}`),
  ].join("\n");
}
