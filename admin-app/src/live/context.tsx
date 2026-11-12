import { t } from "../i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { errorMessage } from "./client";
import { getLiveConnection, type LiveConnection } from "./config";
import { syncLive, type SyncSummary } from "./sync";

type LiveState = {
  /** At least one successful sync has happened. */
  connected: boolean;
  syncing: boolean;
  version: number;
  error: string;
  lastSync: string | null;
  summary: SyncSummary | null;
  refresh: () => Promise<void>;
};

const LiveContext = createContext<LiveState | null>(null);

const POLL_MS = 15_000;
/** Retry at a shorter interval after a failed connection, returning online within seconds once the control plane recovers. */
const RETRY_MS = 3_000;

export function LiveProvider({ children }: { children: ReactNode }) {
  const connection = useRef<LiveConnection>(getLiveConnection()).current;
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const inFlight = useRef(false);

  const doSync = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSyncing(true);
    try {
      const result = await syncLive(connection);
      setSummary(result);
      setLastSync(result.at);
      setError("");
      setConnected(true);
      setVersion((v) => v + 1);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSyncing(false);
      inFlight.current = false;
    }
  }, [connection]);

  // Sync once when the page opens; normally refresh every 15 seconds, retry after 3 seconds on failure.
  // Sync once more when the window regains focus, so no manual refresh is needed after a control plane restart.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const run = async () => {
      const ok = await doSync();
      if (stopped) return;
      timer = window.setTimeout(() => void run(), ok ? POLL_MS : RETRY_MS);
    };
    void run();
    const onFocus = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void run();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [doSync]);

  return (
    <LiveContext.Provider
      value={{
        connected,
        syncing,
        version,
        error,
        lastSync,
        summary,
        refresh: async () => {
          await doSync();
        },
      }}
    >
      {children}
    </LiveContext.Provider>
  );
}

export function useLive(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error(t("useLive 必须在 LiveProvider 内使用"));
  return ctx;
}
