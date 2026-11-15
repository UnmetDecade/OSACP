import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { t } from "../i18n";
import { useAuth } from "../auth";
import { getLiveConnection } from "../live/config";
import { errorMessage } from "../live/client";
import { AuthLayout } from "../components/AuthLayout";
import { Button, Callout, Field, Modal } from "../components/ui";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const [firstRun, setFirstRun] = useState(false);

  // The demo seeds admin/admin and prefills it here; a normal deployment with no
  // accounts yet opens the first-run hint and points at registration.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${getLiveConnection().pcsUrl}/api/v1/auth/config`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) return;
        const out = (await res.json()) as { demo?: boolean; has_accounts?: boolean };
        if (cancelled) return;
        if (out.demo) {
          setUsername("admin");
          setPassword("admin");
          setDemo(true);
          return;
        }
        if (out.has_accounts === false) setFirstRun(true);
      } catch {
        // No config endpoint (older PCS) or offline: keep the form empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    <>
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
          {demo && <Callout tone="info">{t("演示模式已填入默认账号 admin / admin。")}</Callout>}
          {error && <Callout tone="bad">{error}</Callout>}
          <Button type="submit" variant="primary" disabled={busy || !username.trim() || !password}>
            {busy ? t("登录中…") : t("登录")}
          </Button>
        </form>
      </AuthLayout>

      <Modal
        open={firstRun}
        title={t("首次使用")}
        onClose={() => setFirstRun(false)}
        width={460}
        footer={
          <>
            <Button onClick={() => setFirstRun(false)}>{t("稍后")}</Button>
            <Button variant="primary" onClick={() => navigate("/register")}>{t("去注册")}</Button>
          </>
        }
      >
        <div className="stack">
          <p>{t("这台部署还没有任何账号。")}</p>
          <p>{t("点登录页底部的 Register 注册第一个账号；它会立即成为管理员并自动登录。")}</p>
          <p>{t("之后的注册会进入待审批状态，由管理员批准后才能登录。")}</p>
          <div className="muted">{t("密码需长度大于 8，并包含大写字母、小写字母和符号。")}</div>
        </div>
      </Modal>
    </>
  );
}
