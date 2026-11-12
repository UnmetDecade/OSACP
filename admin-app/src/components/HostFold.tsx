import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Collapsible group for folded hosts in the list: collapsed by host name, closed by default.
 * With many hosts, this shows only the current host's resources at a glance; expand a folded host when needed.
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
    // Storage unavailable: keep state within the current page only.
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
  /** One key per host and page; the collapsed state is stored locally, so switching pages and back preserves it. */
  foldKey: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    const stored = readFolds()[foldKey];
    // If the user has toggled it, honor that; the first time it appears, expand the current host (or the host of the selected item) by default.
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
