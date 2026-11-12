import { t } from "./i18n";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { db } from "./store";
import { useLive } from "./live/context";
import type { Host } from "./types";

/**
 * 当前主机：侧栏底部切换，页面按它过滤调度机与构建机。
 * 选择只保存在当前标签页；主机消失时自动回退到本地主机或第一台。
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
  // 实时同步会替换 db.hosts；订阅一下，主机列表变化时重新计算当前主机。
  const live = useLive();
  // 首屏时 db.hosts 还没同步回来，不能拿它校验保存的选择：先信保存值，
  // 等主机列表到达后再由下面的 effect 校验或回退。否则刷新一次就跳回默认主机。
  const [hostId, setId] = useState(
    () => sessionStorage.getItem(STORAGE_KEY) ?? fallbackHost()?.id ?? "",
  );

  const hostIds = db.hosts.map((h) => h.id).join(",");
  useEffect(() => {
    // 主机列表还没同步回来时先不动，否则会把保存的选择覆盖成空。
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
