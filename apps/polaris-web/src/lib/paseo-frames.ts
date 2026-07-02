export type EmbeddedPaseoFrame = {
  workspaceKey: string;
  src: string;
  loaded: boolean;
};

export type EmbeddedPaseoFrameSource = {
  workspaceKey: string;
  src: string;
};

export function mergeEmbeddedPaseoFrames(
  current: EmbeddedPaseoFrame[],
  knownWorkspaceKeys: string[],
  nextSources: EmbeddedPaseoFrameSource[],
): EmbeddedPaseoFrame[] {
  const knownWorkspaceKeySet = new Set(knownWorkspaceKeys);
  const nextByWorkspaceKey = new Map(
    nextSources.map((source) => [source.workspaceKey, source.src]),
  );
  let changed = false;
  const filteredCurrent = current.filter((entry) => {
    const keep = knownWorkspaceKeySet.has(entry.workspaceKey);
    if (!keep) {
      changed = true;
    }
    return keep;
  });

  const next = filteredCurrent.map((entry) => {
    const nextSrc = nextByWorkspaceKey.get(entry.workspaceKey);
    if (!nextSrc) {
      return entry;
    }
    nextByWorkspaceKey.delete(entry.workspaceKey);
    if (entry.src === nextSrc) {
      return entry;
    }
    changed = true;
    return {
      workspaceKey: entry.workspaceKey,
      src: nextSrc,
      loaded: false,
    };
  });

  for (const [workspaceKey, src] of nextByWorkspaceKey.entries()) {
    changed = true;
    next.push({ workspaceKey, src, loaded: false });
  }

  return changed ? next : current;
}
