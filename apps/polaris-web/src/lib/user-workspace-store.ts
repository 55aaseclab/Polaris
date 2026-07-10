import { useEffect, useRef, useState } from "react";
import {
  listWorkspaceStaticSummaries,
  subscribeWorkspaceLiveStream,
  type PortalWorkspaceLiveSummary,
  type PortalWorkspaceStaticSummary,
  type PortalWorkspaceStreamEvent,
} from "./api";

export interface UserWorkspaceStoreConnectionState {
  state: "connecting" | "open" | "reconnecting" | "closed" | "error";
  error: string | null;
  lastEventAt: number | null;
}

export interface UserWorkspaceStoreState {
  staticWorkspaces: PortalWorkspaceStaticSummary[];
  staticLoading: boolean;
  staticError: string | null;
  liveByWorkspace: Record<string, PortalWorkspaceLiveSummary | undefined>;
  liveConnection: UserWorkspaceStoreConnectionState;
}

const CLOSED_CONNECTION_STATE: UserWorkspaceStoreConnectionState = {
  state: "closed",
  error: null,
  lastEventAt: null,
};

function sortStaticWorkspaces(
  workspaces: PortalWorkspaceStaticSummary[],
): PortalWorkspaceStaticSummary[] {
  return [...workspaces].sort((left, right) => left.name.localeCompare(right.name));
}

export function applyWorkspaceStreamEvent(
  current: Pick<UserWorkspaceStoreState, "staticWorkspaces" | "liveByWorkspace">,
  event: PortalWorkspaceStreamEvent,
): Pick<UserWorkspaceStoreState, "staticWorkspaces" | "liveByWorkspace"> {
  if (event.type === "snapshot") {
    return {
      staticWorkspaces: sortStaticWorkspaces(event.staticWorkspaces),
      liveByWorkspace: Object.fromEntries(
        event.liveWorkspaces.map((workspace) => [workspace.name, workspace] as const),
      ),
    };
  }
  if (event.type === "static-upsert") {
    const filtered = current.staticWorkspaces.filter(
      (workspace) => workspace.name !== event.workspace.name,
    );
    return {
      ...current,
      staticWorkspaces: sortStaticWorkspaces([...filtered, event.workspace]),
    };
  }
  if (event.type === "static-remove") {
    return {
      staticWorkspaces: current.staticWorkspaces.filter(
        (workspace) => workspace.name !== event.workspace,
      ),
      liveByWorkspace: Object.fromEntries(
        Object.entries(current.liveByWorkspace).filter(([workspaceName]) => workspaceName !== event.workspace),
      ),
    };
  }
  if (event.type === "live-upsert") {
    return {
      ...current,
      liveByWorkspace: {
        ...current.liveByWorkspace,
        [event.workspace.name]: event.workspace,
      },
    };
  }
  if (event.type === "live-remove") {
    return {
      ...current,
      liveByWorkspace: Object.fromEntries(
        Object.entries(current.liveByWorkspace).filter(([workspaceName]) => workspaceName !== event.workspace),
      ),
    };
  }
  return current;
}

export function useUserWorkspaceStore(userId: string): UserWorkspaceStoreState & {
  refreshStatic: () => void;
} {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<UserWorkspaceStoreState>({
    staticWorkspaces: [],
    staticLoading: false,
    staticError: null,
    liveByWorkspace: {},
    liveConnection: CLOSED_CONNECTION_STATE,
  });
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!userId) {
      setState({
        staticWorkspaces: [],
        staticLoading: false,
        staticError: null,
        liveByWorkspace: {},
        liveConnection: CLOSED_CONNECTION_STATE,
      });
      return;
    }
    let cancelled = false;
    setState((current) => ({
      ...current,
      staticLoading: true,
      staticError: null,
    }));
    void listWorkspaceStaticSummaries(userId)
      .then((staticWorkspaces) => {
        if (cancelled) {
          return;
        }
        setState((current) => ({
          ...current,
          staticWorkspaces: sortStaticWorkspaces(staticWorkspaces),
          staticLoading: false,
          staticError: null,
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setState((current) => ({
          ...current,
          staticLoading: false,
          staticError: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, userId]);

  useEffect(() => {
    if (!userId) {
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimerRef.current !== null) {
        return;
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect(true);
      }, 1000);
    };

    const connect = async (reconnecting: boolean) => {
      setState((current) => ({
        ...current,
        liveConnection: {
          state: reconnecting ? "reconnecting" : "connecting",
          error: null,
          lastEventAt: current.liveConnection.lastEventAt,
        },
      }));
      try {
        unsubscribe = await subscribeWorkspaceLiveStream(userId, {
          onOpen: () => {
            if (cancelled) {
              return;
            }
            setState((current) => ({
              ...current,
              liveConnection: {
                state: "open",
                error: null,
                lastEventAt: Date.now(),
              },
            }));
          },
          onEvent: (event) => {
            if (cancelled) {
              return;
            }
            setState((current) => ({
              ...current,
              ...applyWorkspaceStreamEvent(current, event),
              liveConnection: {
                state: current.liveConnection.state === "closed"
                  ? "open"
                  : current.liveConnection.state,
                error: null,
                lastEventAt: Date.now(),
              },
            }));
          },
          onError: (message) => {
            if (cancelled) {
              return;
            }
            setState((current) => ({
              ...current,
              liveConnection: {
                state: "error",
                error: message,
                lastEventAt: current.liveConnection.lastEventAt,
              },
            }));
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }
            scheduleReconnect();
          },
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState((current) => ({
          ...current,
          liveConnection: {
            state: "error",
            error: error instanceof Error ? error.message : String(error),
            lastEventAt: current.liveConnection.lastEventAt,
          },
        }));
        scheduleReconnect();
      }
    };

    void connect(false);

    return () => {
      cancelled = true;
      clearReconnectTimer();
      if (unsubscribe) {
        unsubscribe();
      }
      setState((current) => ({
        ...current,
        liveConnection: CLOSED_CONNECTION_STATE,
      }));
    };
  }, [userId]);

  return {
    ...state,
    refreshStatic: () => {
      setReloadKey((current) => current + 1);
    },
  };
}
