import { t } from "../i18n";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

export function PageHead({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Card({
  children,
  className = "",
  flush = false,
  style,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
  style?: CSSProperties;
}) {
  return <section className={`card${flush ? " card-flush" : ""} ${className}`} style={style}>{children}</section>;
}

export function CardTitle({
  children,
  extra,
  sub,
}: {
  children: ReactNode;
  extra?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="card-title">
      <div>
        <h2>{children}</h2>
        {sub && <p className="card-sub">{sub}</p>}
      </div>
      {extra}
    </div>
  );
}

const TONES: Record<string, string> = {
  ONLINE: "ok",
  SUCCEEDED: "ok",
  HEALTHY: "ok",
  APPROVED: "ok",
  NORMAL: "ok",
  COMPLETED: "ok",
  RUNNING: "info",
  ASSIGNED: "info",
  STARTING: "info",
  PROVISIONING: "info",
  SYNCING: "info",
  QUEUED: "muted",
  PENDING: "warn",
  WARNING: "warn",
  SUSPECT: "warn",
  WAITING_APPROVAL: "warn",
  DRAINING: "warn",
  MEDIUM: "warn",
  THROTTLED: "warn",
  FAILED: "bad",
  OFFLINE: "bad",
  PROTECTING: "bad",
  BLOCKED: "bad",
  REJECTED: "bad",
  EXPIRED: "bad",
  HIGH: "bad",
  DENIED: "bad",
  LOW: "muted",
  CANCELLED: "muted",
};

// The value is still the Chinese original: pass it to t() at render time so it follows language switches.
const LABELS: Record<string, string> = {
  ONLINE: "在线",
  OFFLINE: "离线",
  PENDING: "等待中",
  PROVISIONING: "部署中",
  SYNCING: "同步镜像",
  STARTING: "启动中",
  HEALTHY: "健康",
  MISSING: "缺失",
  WARNING: "告警",
  SUSPECT: "异常",
  THROTTLED: "限流",
  PROTECTING: "保护中",
  DEGRADED: "降级",
  DRAINING: "排空中",
  NORMAL: "正常",
  QUEUED: "排队中",
  RUNNING: "执行中",
  ASSIGNED: "已分配",
  SUCCEEDED: "成功",
  COMPLETED: "已完成",
  FAILED: "失败",
  BLOCKED: "阻塞",
  CANCELLED: "已取消",
  REVOKED: "已移除",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
  EXPIRED: "已过期",
  WAITING_APPROVAL: "等待审批",
};

export function Badge({ value, text }: { value: string; text?: string }) {
  const tone = TONES[value] ?? "muted";
  const label = LABELS[value];
  return (
    <span className={`status status-${tone}`}>
      <i />
      {text ?? (label ? t(label) : value)}
    </span>
  );
}

export function Tag({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "bad" | "ok"; title?: string }) {
  return <span className={`tag tag-${tone}`} title={title}>{children}</span>;
}

export function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "muted" }) {
  return <i className={`dot dot-${tone}`} />;
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  size,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  size?: "sm";
  title?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}${size === "sm" ? " btn-sm" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Meter({ value, warn = 70, bad = 85 }: { value: number; warn?: number; bad?: number }) {
  const tone = value >= bad ? "bad" : value >= warn ? "warn" : "ok";
  return (
    <div className="meter" title={`${Math.round(value)}%`}>
      <div className={`meter-fill meter-${tone}`} style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "bad" | "warn" | "ok" }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong className={tone ? `text-${tone}` : undefined}>{value}</strong>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 640,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  if (!open) return null;
  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t("关闭")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function KeyVal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

export function Digest({ value }: { value: string }) {
  return <code className="digest" title={value}>{value}</code>;
}

export function Callout({ tone = "info", children }: { tone?: "info" | "warn" | "bad"; children: ReactNode }) {
  return <div className={`callout callout-${tone}`}>{children}</div>;
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className={`switch${disabled ? " is-disabled" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      {label}
    </label>
  );
}
