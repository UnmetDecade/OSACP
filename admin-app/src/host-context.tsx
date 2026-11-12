import { t } from "./i18n";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { db } from "./store";
import { useLive } from "./live/context";
import type { Host } from "./types";

/**
 * Current host: switched at the bottom of the sidebar; pages filter schedulers and builders by it.
 * The selection is kept only in the current tab; when the host disappears, fall back to the local host or the first one.
 */
type HostScopeValue = {
  hosts: Host[];
  host: Host | undefined;
  setHostId: (id: string) => void;
};

const STORAGE_KEY = "current-host";
const HostScope = createContext<HostScopeValue | null>(null);

function fallbackHost(): Host | undefined {
  return db.hosts.find((h) => h.transport === "local") ?? db.hosts[0];
}

export function HostScopeProvider({ children }: { children: ReactNode }) {
  // Live sync replaces db.hosts; subscribe so the current host is recomputed when the host list changes.
  const live = useLive();
  // On first paint db.hosts has not synced back yet, so it cannot validate the saved selection: trust the saved value first,
  // and let the effect below validate or fall back once the host list arrives. Otherwise one refresh jumps back to the default host.
  const [hostId, setId] = useState(
    () => sessionStorage.getItem(STORAGE_KEY) ?? fallbackHost()?.id ?? "",
  );

  const hostIds = db.hosts.map((h) => h.id).join(",");
  useEffect(() => {
    // Do nothing until the host list syncs back, or the saved selection would be overwritten with empty.
    if (!db.hosts.length) return;
    if (db.hosts.some((h) => h.id === hostId)) return;
    const next = fallbackHost()?.id ?? "";
    setId(next);
    if (next) sessionStorage.setItem(STORAGE_KEY, next);
  }, [hostIds, hostId, live.lastSync, live.connected]);

  function setHostId(id: string) {
    setId(id);
    sessionStorage.setItem(STORAGE_KEY, id);
  }

  const value: HostScopeValue = {
    hosts: db.hosts,
    host: db.hosts.find((h) => h.id === hostId) ?? fallbackHost(),
    setHostId,
  };
  return <HostScope.Provider value={value}>{children}</HostScope.Provider>;
}

export function useHostScope(): HostScopeValue {
  const value = useContext(HostScope);
  if (!value) throw new Error(t("useHostScope 必须在 HostScopeProvider 内使用"));
  return value;
}
