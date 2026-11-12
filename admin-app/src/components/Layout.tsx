import { t, useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { Icon } from "./Icon";

// Copy is translated at render time: module-level constants are evaluated once, so calling t() here would freeze the startup language.
const NAV: { to: string; label: string; icon: string }[] = [
  { to: "/", label: "总览", icon: "grid" },
  { to: "/builders", label: "构建机", icon: "box" },
  { to: "/scheduler", label: "调度机", icon: "clock" },
  { to: "/profiles", label: "配置", icon: "layers" },
  { to: "/tasks", label: "任务", icon: "tasks" },
  { to: "/terminal", label: "终端", icon: "terminal" },
  { to: "/chat", label: "对话", icon: "chat" },
  { to: "/logs", label: "日志", icon: "logs" },
];

function transportLabel(host: { transport?: string; address?: string }): string {
  if (host.transport === "local") return t("本地");
  return host.address || "SSH";
}

export function Layout() {
  const [theme, setTheme] = useState(() => localStorage.getItem("app-theme") ?? "light");
  const [hostOpen, setHostOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const { hosts, host, setHostId } = useHostScope();
  const { lang, setLang } = useI18n();
  const live = useLive();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("app-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!hostOpen) return;
    const close = (event: MouseEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setHostOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [hostOpen]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="bot" size={16} />
          </span>
          <span className="brand-name">Build Bots</span>
        </div>

        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
              title={t(item.label)}
            >
              <Icon name={item.icon} size={15} />
              <span>{t(item.label)}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot" ref={hostRef}>
          {hostOpen && (
            <div className="host-menu" role="menu">
              {hosts.map((item) => (
                <button
                  key={item.id}
                  className={`host-menu-item${item.id === host?.id ? " active" : ""}`}
                  onClick={() => {
                    setHostId(item.id);
                    setHostOpen(false);
                  }}
                >
                  <i className={`dot dot-${item.state === "ONLINE" ? "ok" : item.state === "REVOKED" ? "bad" : "idle"}`} />
                  <span>
                    <b>{item.name}</b>
                    <small>{transportLabel(item)}</small>
                  </span>
                  {item.id === host?.id && <Icon name="check" size={13} />}
                </button>
              ))}
              {hosts.length === 0 && <p className="host-menu-empty">{t("还没有主机")}</p>}
              <NavLink className="host-menu-link" to="/hosts" onClick={() => setHostOpen(false)}>
                {t("管理主机")}
              </NavLink>
            </div>
          )}

          <button className="host-switch" title={host?.name ?? t("选择主机")} onClick={() => setHostOpen((v) => !v)}>
            <i className={`dot ${host?.state === "ONLINE" ? "dot-ok" : "dot-idle"}`} />
            <span className="host-switch-text">
              <b>{host?.name ?? t("选择主机")}</b>
              <small>{host ? transportLabel(host) : t("添加主机")}</small>
            </span>
            <Icon name="server" size={14} className="host-switch-mobile" />
            <Icon name="chevron" size={13} />
          </button>

          <div className="side-row">
            <button
              className="conn"
              onClick={() => void live.refresh()}
              disabled={live.syncing}
              title={
                !host
                  ? t("还没有接入主机，点击重新同步")
                  : live.error || t("重新同步实时数据")
              }
            >
              <i className={`dot ${!host ? "dot-idle" : live.error ? "dot-warn" : live.connected ? "dot-ok" : "dot-idle"}`} />
              <span>{!host ? t("未连接") : live.error ? t("连接失败") : live.connected ? t("实时") : t("连接中…")}</span>
              <Icon name="refresh" size={13} />
            </button>
            <button
              className="icon-btn lang-switch"
              title={lang === "zh" ? "English" : "中文"}
              aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            >
              <Icon name="globe" size={14} />
              <span className="lang-switch-label">{lang === "zh" ? "EN" : "中"}</span>
            </button>
            <button
              className="icon-btn"
              title={theme === "light" ? t("深色") : t("浅色")}
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              <Icon name={theme === "light" ? "moon" : "sun"} size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="content">
          <Outlet />
        </div>
      </main>

    </div>
  );
}
