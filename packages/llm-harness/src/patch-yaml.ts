import { stringify } from "yaml";

/**
 * One dsh loader patch entry (Cordis entry-list dialect). Config values are
 * literal; no !!js expressions are emitted.
 */
export interface DshPatchEntry {
  id: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
}

/** Render the patch document: a top-level YAML array of loader patch entries. */
export function renderPatchYaml(entries: DshPatchEntry[]): string {
  return stringify(entries, {
    lineWidth: 100,
    defaultStringType: "QUOTE_DOUBLE",
  });
}
