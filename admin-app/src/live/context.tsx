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
  /** 至少成功同步过一次。 */
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
/** 连接失败时用更短的间隔重试，控制面恢复后几秒内自动回到在线。 */
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

  // 打开页面即同步一次；正常每 15 秒刷新，失败时 3 秒后重试。
  // 窗口重新聚焦时补一次，这样控制面重启后无需手动点刷新。
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
