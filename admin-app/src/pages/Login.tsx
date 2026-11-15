import { useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../i18n";
import { useAuth } from "../auth";
import { errorMessage } from "../live/client";
import { AuthLayout } from "../components/AuthLayout";
import { Button, Callout, Field } from "../components/ui";

export function LoginPage() {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      await auth.login(username.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t("登录")}
      subtitle={t("管理端只应在内网或 VPN 中访问；公网访问请使用侧载令牌。")}
      footer={
        <span>
          {t("还没有账号？")}{" "}
          <Link className="link" to="/register">{t("注册")}</Link>
        </span>
      }
    >
      <form className="stack" onSubmit={submit}>
        <Field label={t("用户名")}>
          <input
            className="input"
            value={username}
            autoComplete="username"
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label={t("密码")}>
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
        <Button type="submit" variant="primary" disabled={busy || !username.trim() || !password}>
          {busy ? t("登录中…") : t("登录")}
        </Button>
      </form>
    </AuthLayout>
  );
}
