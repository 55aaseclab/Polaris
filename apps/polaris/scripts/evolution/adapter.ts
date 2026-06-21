import type { WorkspaceSpec } from "../core/workspace.js";
import type { EvolutionExecutionEvent } from "./types.js";

export interface AgentManagerAdapter {
  readonly managerId: string;
  readonly contractVersion: string;
  supports(workspace: WorkspaceSpec): boolean;
  buildRuntimePaths(workspace: WorkspaceSpec): {
    stateRoot: string;
    evolutionRoot: string;
  };
  normalizeTranscript(params: {
    workspace: WorkspaceSpec;
    sessionId: string;
    transcript: Array<Record<string, unknown>>;
  }): EvolutionExecutionEvent[];
}

export class PaseoManagerAdapter implements AgentManagerAdapter {
  readonly managerId = "paseo";
  readonly contractVersion = "v1";

  supports(workspace: WorkspaceSpec): boolean {
    return workspace.agent.managerId === "paseo";
  }

  buildRuntimePaths(workspace: WorkspaceSpec): { stateRoot: string; evolutionRoot: string } {
    return {
      stateRoot: workspace.agent.runtime.stateRoot,
      evolutionRoot: workspace.agent.runtime.evolutionRoot,
    };
  }

  normalizeTranscript(params: {
    workspace: WorkspaceSpec;
    sessionId: string;
    transcript: Array<Record<string, unknown>>;
  }): EvolutionExecutionEvent[] {
    return params.transcript.map((entry, index) => ({
      id: `${params.sessionId}:${index + 1}`,
      workspaceId: params.workspace.identity.projectName,
      managerId: this.managerId,
      sessionId: params.sessionId,
      kind: "task-output",
      timestamp: String(entry.timestamp ?? new Date().toISOString()),
      payload: entry,
    }));
  }
}
