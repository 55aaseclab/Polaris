import type {
  EvolutionMemoryEntry,
  EvolutionMemoryProviderEntry,
} from "./types.js";

export interface RetrievalContext {
  vaultId: string;
  userProfileId?: string;
  prompt: string;
  limit?: number;
}

export async function retrieveMemoryContext(
  entries: EvolutionMemoryEntry[],
  context: RetrievalContext,
): Promise<EvolutionMemoryEntry[]> {
  const prompt = context.prompt.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (entry.vaultId !== context.vaultId) {
        return false;
      }
      if (entry.target === "user-memory" && context.userProfileId && entry.userProfileId !== context.userProfileId) {
        return false;
      }
      return entry.status === "active";
    })
    .map((entry) => {
      const metadata = typeof entry.metadata === "object" && entry.metadata ? entry.metadata : {};
      const tags = Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag).toLowerCase()) : [];
      const reasons: string[] = [];
      let score = entry.confidence * 100;
      if (entry.target === "vault-memory") {
        score += 8;
        reasons.push("vault-memory");
      }
      if (context.userProfileId && entry.userProfileId === context.userProfileId) {
        score += 6;
        reasons.push("same user profile");
      }
      if (prompt) {
        const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
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
      const updatedAt = Date.parse(entry.updatedAt);
      if (!Number.isNaN(updatedAt)) {
        const ageDays = Math.max(0, (Date.now() - updatedAt) / (1000 * 60 * 60 * 24));
        score += Math.max(0, 10 - ageDays / 7);
        if (ageDays < 14) {
          reasons.push("recently updated");
        }
      }
      return {
        entry: {
          ...entry,
          metadata: {
            ...metadata,
            retrieval: {
              score,
              reasons,
              prompt: context.prompt,
              retrievedAt: new Date().toISOString(),
            },
          },
        },
        score,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, context.limit ?? 8)
    .map((row) => row.entry);
}

export function renderMemoryEntries(entries: EvolutionMemoryEntry[]): string {
  if (entries.length === 0) {
    return "_No durable memory entries were retrieved._";
  }
  const bySection = new Map<string, EvolutionMemoryEntry[]>();
  for (const entry of entries) {
    const section = entry.section || "Memory";
    const bucket = bySection.get(section) ?? [];
    bucket.push(entry);
    bySection.set(section, bucket);
  }
  const lines: string[] = [];
  for (const [section, sectionEntries] of bySection.entries()) {
    lines.push(`## ${section}`);
    lines.push("");
    for (const entry of sectionEntries) {
      lines.push(`- \`${entry.key}\` ${entry.title}.`);
      lines.push(`  ${entry.body}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderProviderMemory(entries: EvolutionMemoryProviderEntry[]): string {
  if (entries.length === 0) {
    return "_No external memory provider configured._";
  }
  return entries
    .map((entry) => `- [${entry.source}] ${entry.title}: ${entry.body}`)
    .join("\n");
}
