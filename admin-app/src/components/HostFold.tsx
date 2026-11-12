import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * 并入主机在列表里的折叠分组：按主机名收起，默认折叠。
 * 主机多了以后，一眼只看当前主机的资源；要看某台并入主机再展开。
 */

const FOLD_KEY = "platform.host-fold.v1";

function readFolds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLD_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function writeFold(key: string, open: boolean) {
  try {
    const all = readFolds();
    all[key] = open;
    localStorage.setItem(FOLD_KEY, JSON.stringify(all));
  } catch {
    // 存储不可用：只保留当前页面内的状态。
  }
}

export function HostFold({
  name,
  label,
  foldKey,
  defaultOpen = false,
  forceOpen = false,
  children,
}: {
  name: string;
  label: string;
  /** 每台主机、每个页面一个键，折叠状态记在本机，切页面回来还是原样。 */
  foldKey: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    const stored = readFolds()[foldKey];
    // 用户折叠过就听用户的；第一次出现时，当前主机（或选中项所在主机）默认展开。
    return typeof stored === "boolean" ? stored : defaultOpen || forceOpen;
  });

  function toggle() {
    setOpen((v) => {
      writeFold(foldKey, !v);
      return !v;
    });
  }

  return (
    <div className={`host-fold${open ? " open" : ""}`}>
      <button type="button" className="host-fold-head" aria-expanded={open} onClick={toggle}>
        <Icon name="chevron" size={13} />
        <b>{name}</b>
        <small>{label}</small>
      </button>
      {open && <div className="host-fold-body">{children}</div>}
    </div>
  );
}
