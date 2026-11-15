import { useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../i18n";
import { useAuth } from "../auth";
import { errorMessage } from "../live/client";
import { AuthLayout } from "../components/AuthLayout";
import { Button, Callout, Field } from "../components/ui";

export function RegisterPage() {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const valid =
    /^[a-zA-Z0-9._-]{3,32}$/.test(username.trim()) &&
    password.length >= 10 &&
    password === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      const out = await auth.register({
        username: username.trim(),
        password,
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      });
      if (out.pending) setPending(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <AuthLayout
        title={t("注册已提交")}
        subtitle={t("账号正在等待管理员审批。审批通过后即可登录。")}
        footer={<Link className="link" to="/login">{t("返回登录")}</Link>}
      >
        <Callout tone="info">{t("管理员在「账号」页面启用后，这个账号才能使用。")}</Callout>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("注册账号")}
      subtitle={t("第一个注册的账号会成为管理员；之后的账号需要管理员审批，默认只读。")}
      footer={
        <span>
          {t("已有账号？")}{" "}
          <Link className="link" to="/login">{t("登录")}</Link>
        </span>
      }
    >
      <form className="stack" onSubmit={submit}>
        <Field label={t("用户名")} hint={t("3–32 位，字母、数字、点、下划线和短横线")}>
          <input
            className="input"
            value={username}
            autoComplete="username"
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label={t("显示名")} hint={t("可选；默认与用户名相同")}>
          <input
            className="input"
            value={displayName}
            autoComplete="nickname"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label={t("密码")} hint={t("至少 10 位")}>
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t("确认密码")}>
          <input
            className="input"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {confirm && password !== confirm && <Callout tone="warn">{t("两次输入的密码不一致。")}</Callout>}
        {error && <Callout tone="bad">{error}</Callout>}
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? t("提交中…") : t("注册")}
        </Button>
      </form>
    </AuthLayout>
  );
}
