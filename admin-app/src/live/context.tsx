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
import { followSchedulerEvents } from "./stream";
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

/**
 * Safety-net poll. The scheduler's event stream drives most refreshes; this interval only covers
 * changes the stream does not carry (control-plane host data, a dropped stream) and failed connections.
 */
const POLL_MS = 30_000;
/** Retry at a shorter interval after a failed connection, returning online within seconds once the control plane recovers. */
const RETRY_MS = 3_000;
/** Bursts of events from one task transition are folded into a single snapshot fetch. */
const EVENT_SYNC_DEBOUNCE_MS = 250;
/** A reporting agent can post progress every few seconds; keep stream-driven snapshots from outpacing the poll. */
const EVENT_SYNC_MIN_MS = 2_000;

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

  // Sync once when the page opens; normally refresh every 30 seconds, retry after 3 seconds on failure.
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

  // The scheduler announces task and instance changes on its SSE outbox stream; resync on each burst
  // instead of waiting for the poll. A reconnect also resyncs, since notifications may have been missed.
  useEffect(() => {
    let timer: number | undefined;
    let lastRun = 0;
    const schedule = () => {
      if (timer !== undefined) return;
      const wait = Math.max(EVENT_SYNC_DEBOUNCE_MS, lastRun + EVENT_SYNC_MIN_MS - Date.now());
      timer = window.setTimeout(() => {
        timer = undefined;
        lastRun = Date.now();
        void doSync();
      }, wait);
    };
    const stop = followSchedulerEvents(connection, schedule, (state) => {
      if (state === "open") void doSync();
    });
    return () => {
      stop();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connection, doSync]);

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
