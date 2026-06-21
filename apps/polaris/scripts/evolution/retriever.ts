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
  const prompt = context.prompt.trim().toLowerCase();
  const candidates = store.queryArtifacts({
    workspaceId: context.workspaceId,
    userProfileId: context.userProfileId,
    limit: Math.max((context.limit ?? 8) * 4, 12),
  });
  const scored = candidates
    .map((artifact) => {
      const metadata = typeof artifact.metadata === "object" && artifact.metadata ? artifact.metadata : {};
      const tags = Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag).toLowerCase()) : [];
      const reasons: string[] = [];
      let score = artifact.confidence * 100;

      if (artifact.scope === "workspace") {
        score += 8;
        reasons.push("workspace-scoped");
      }
      if (context.userProfileId && artifact.userProfileId === context.userProfileId) {
        score += 6;
        reasons.push("same user profile");
      }
      if (prompt) {
        const haystack = `${artifact.title}\n${artifact.content}`.toLowerCase();
        if (haystack.includes(prompt)) {
          score += 20;
          reasons.push("direct prompt text match");
        }
        const matchedTags = tags.filter((tag) => prompt.includes(tag));
        if (matchedTags.length > 0) {
          score += 12 + matchedTags.length;
          reasons.push(`matched tags: ${matchedTags.join(", ")}`);
        }
      }
      const updatedAt = Date.parse(artifact.updatedAt);
      if (!Number.isNaN(updatedAt)) {
        const ageDays = Math.max(0, (Date.now() - updatedAt) / (1000 * 60 * 60 * 24));
        score += Math.max(0, 10 - ageDays / 7);
        if (ageDays < 14) {
          reasons.push("recently updated");
        }
      }
      const explainability = {
        ...(metadata as Record<string, unknown>),
        retrieval: {
          score,
          reasons,
          prompt: context.prompt,
          retrievedAt: new Date().toISOString(),
        },
      };
      return {
        artifact: {
          ...artifact,
          metadata: explainability,
        },
        score,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, context.limit ?? 8)
    .map((entry) => entry.artifact);
  return scored;
}

export function renderRetrievedArtifacts(artifacts: EvolutionArtifact[]): string {
  if (artifacts.length === 0) {
    return "";
  }
  return [
    "Relevant prior lessons:",
    ...artifacts.map((artifact) => {
      const retrieval = typeof artifact.metadata?.retrieval === "object" && artifact.metadata?.retrieval
        ? artifact.metadata.retrieval as { reasons?: unknown }
        : null;
      const reasons = Array.isArray(retrieval?.reasons)
        ? retrieval.reasons.map((reason) => String(reason)).join("; ")
        : "";
      return `- [${artifact.kind}] ${artifact.title}: ${artifact.content}${reasons ? ` (why retrieved: ${reasons})` : ""}`;
    }),
  ].join("\n");
}
