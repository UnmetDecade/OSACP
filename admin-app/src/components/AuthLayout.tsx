import type { ReactNode } from "react";
import { t } from "../i18n";
import { Icon } from "./Icon";

/** Centered card used by the login and registration pages. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Icon name="shield" size={22} />
          <div>
            <b>OSACP</b>
            <small>{t("AI Agent 算力底座")}</small>
          </div>
        </div>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </div>
    </div>
  );
}
