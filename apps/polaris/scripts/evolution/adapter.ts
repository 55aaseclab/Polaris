import type { VaultSpec } from "../core/vault.js";
import type { EvolutionExecutionEvent } from "./types.js";

export interface AgentManagerAdapter {
  readonly managerId: string;
  readonly contractVersion: string;
  supports(vault: VaultSpec): boolean;
  buildRuntimePaths(vault: VaultSpec): {
    stateRoot: string;
    evolutionRoot: string;
  };
  normalizeTranscript(params: {
    vault: VaultSpec;
    sessionId: string;
    transcript: Array<Record<string, unknown>>;
  }): EvolutionExecutionEvent[];
}

export class PaseoManagerAdapter implements AgentManagerAdapter {
  readonly managerId = "paseo";
  readonly contractVersion = "v1";

  supports(vault: VaultSpec): boolean {
    return vault.agent.managerId === "paseo";
  }

  buildRuntimePaths(vault: VaultSpec): { stateRoot: string; evolutionRoot: string } {
    return {
      stateRoot: vault.agent.runtime.stateRoot,
      evolutionRoot: vault.agent.runtime.evolutionRoot,
    };
  }

  normalizeTranscript(params: {
    vault: VaultSpec;
    sessionId: string;
    transcript: Array<Record<string, unknown>>;
  }): EvolutionExecutionEvent[] {
    return params.transcript.map((entry, index) => ({
      id: `${params.sessionId}:${index + 1}`,
      vaultId: params.vault.identity.projectName,
      managerId: this.managerId,
      sessionId: params.sessionId,
      kind: "task-output",
      timestamp: String(entry.timestamp ?? new Date().toISOString()),
      payload: entry,
    }));
  }
}
