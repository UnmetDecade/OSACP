import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { getLiveConnection } from "../live/config";
import { errorMessage, pcs } from "../live/client";
import { useAuth, strongPassword, type Account, type AccountRole } from "../auth";
import { Badge, Button, Callout, Card, Empty, Field, Modal, PageHead, Tag } from "../components/ui";

/** Every permission an account can carry; keep in sync with pcs-issuer/src/jwt.ts. */
const SCOPE_INFO: Array<{ scope: string; label: string; desc: string }> = [
  { scope: "host:read", label: "查看主机", desc: "读取主机、资源与联邦树" },
  { scope: "host:admin", label: "管理主机", desc: "接入、探测、引导、删除主机" },
  { scope: "deployment:read", label: "查看部署", desc: "读取部署、计划与实例" },
  { scope: "deployment:write", label: "部署与启停", desc: "创建部署，启停、重启或删除容器" },
  { scope: "profile:read", label: "查看配置", desc: "读取 Agent / API Profile 与绑定" },
  { scope: "profile:write", label: "管理配置", desc: "创建、修改、删除 Profile 与绑定" },
  { scope: "approval:issue", label: "签发审批", desc: "为审批流程签发一次性令牌" },
  { scope: "audit:read", label: "查看操作记录", desc: "读取审计日志（非管理员仅限本人）" },
  { scope: "account:read", label: "查看账号", desc: "列出账号及其权限" },
  { scope: "account:write", label: "管理账号", desc: "创建、审批、禁用账号，修改权限" },
];

const ROLE_PRESETS: Record<Exclude<AccountRole, "custom">, string[]> = {
  admin: SCOPE_INFO.map((s) => s.scope),
  operator: ["host:read", "deployment:read", "deployment:write", "profile:read", "profile:write", "audit:read"],
  viewer: ["host:read", "deployment:read", "profile:read", "audit:read"],
};

const ROLE_LABEL: Record<AccountRole, string> = {
  admin: "管理员",
  operator: "操作员",
  viewer: "只读",
  custom: "自定义",
};

type AuditRow = {
  audit_id?: number;
  action?: string;
  operator_id?: string;
  subject?: string;
  actor_ip?: string | null;
  detail?: Record<string, unknown>;
  created_at?: string;
};

export function AccountsPage() {
  const auth = useAuth();
  const canWrite = auth.hasScope("account:write");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [historyOf, setHistoryOf] = useState<Account | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const out = await pcs<{ accounts: Account[] }>(getLiveConnection(), "/api/v1/platform/accounts");
      setAccounts(out.accounts ?? []);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(account: Account, status: "ACTIVE" | "DISABLED") {
    setError("");
    try {
      await pcs(getLiveConnection(), `/api/v1/platform/accounts/${encodeURIComponent(account.account_id)}`, {
        method: "PATCH",
        body: { status },
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!auth.hasScope("account:read")) {
    return (
      <div className="page">
        <PageHead title={t("账号")} />
        <Callout tone="warn">{t("当前账号没有查看账号的权限。")}</Callout>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead
        title={t("账号")}
        meta={
          <>
            <span>{t("{count} 个账号", { count: accounts.length })}</span>
            <span className="sep" />
            <span>{t("注册策略：后续账号需要管理员审批")}</span>
          </>
        }
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              {t("新建账号")}
            </Button>
          ) : undefined
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      <Card flush>
        {loading ? (
          <Empty text={t("加载中…")} />
        ) : accounts.length === 0 ? (
          <Empty text={t("还没有账号。")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("用户名")}</th>
                  <th>{t("显示名")}</th>
                  <th>{t("角色")}</th>
                  <th>{t("状态")}</th>
                  <th>{t("权限")}</th>
                  <th>{t("最近登录")}</th>
                  <th>{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.account_id}>
                    <td><code>{a.username}</code></td>
                    <td>{a.display_name}</td>
                    <td><Tag tone={a.role === "admin" ? "accent" : "neutral"}>{t(ROLE_LABEL[a.role])}</Tag></td>
                    <td><Badge value={a.status} /></td>
                    <td>{t("{count} 项", { count: a.scopes.length })}</td>
                    <td>{a.last_login_at ? new Date(a.last_login_at).toLocaleString("zh-CN") : "-"}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <Button size="sm" onClick={() => setHistoryOf(a)}>{t("记录")}</Button>
                        {canWrite && (
                          <Button size="sm" onClick={() => setEditing(a)}>{t("编辑")}</Button>
                        )}
                        {canWrite && a.status === "PENDING" && (
                          <Button size="sm" variant="primary" onClick={() => void setStatus(a, "ACTIVE")}>
                            {t("批准")}
                          </Button>
                        )}
                        {canWrite && a.status === "ACTIVE" && a.account_id !== auth.account?.account_id && (
                          <Button size="sm" variant="danger" onClick={() => void setStatus(a, "DISABLED")}>
                            {t("禁用")}
                          </Button>
                        )}
                        {canWrite && a.status === "DISABLED" && (
                          <Button size="sm" onClick={() => void setStatus(a, "ACTIVE")}>{t("启用")}</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <AccountModal
          value={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {historyOf && <AccountHistoryModal account={historyOf} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

function AccountModal({
  value,
  onClose,
  onSaved,
}: {
  value: Account | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [username, setUsername] = useState(value?.username ?? "");
  const [displayName, setDisplayName] = useState(value?.display_name ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AccountRole>(value?.role ?? "viewer");
  const [scopes, setScopes] = useState<string[]>(value?.scopes ?? ROLE_PRESETS.viewer);
  const [status, setStatus] = useState<"PENDING" | "ACTIVE" | "DISABLED">(value?.status ?? "ACTIVE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function chooseRole(next: AccountRole) {
    setRole(next);
    if (next !== "custom") setScopes([...ROLE_PRESETS[next]]);
  }

  function toggleScope(scope: string) {
    setRole("custom");
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (value) {
        await pcs(getLiveConnection(), `/api/v1/platform/accounts/${encodeURIComponent(value.account_id)}`, {
          method: "PATCH",
          body: {
            display_name: displayName.trim() || value.username,
            role,
            scopes,
            status,
            ...(password ? { password } : {}),
          },
        });
      } else {
        await pcs(getLiveConnection(), "/api/v1/platform/accounts", {
          method: "POST",
          body: {
            username: username.trim(),
            password,
            display_name: displayName.trim() || undefined,
            role,
            scopes,
          },
        });
      }
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const valid = value
    ? displayName.trim().length <= 64 && (!password || strongPassword(password))
    : /^[a-zA-Z0-9._-]{3,32}$/.test(username.trim()) && strongPassword(password);

  return (
    <Modal
      open
      title={value ? t("编辑账号") : t("新建账号")}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !valid}>
            {busy ? t("保存中…") : t("保存")}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!value && (
          <Field label={t("用户名")} hint={t("3–32 位，字母、数字、点、下划线和短横线")}>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
        )}
        <Field label={t("显示名")}>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field
          label={value ? t("重置密码") : t("初始密码")}
          hint={
            value
              ? t("留空则不修改；修改后这个账号的所有会话会失效，且需满足复杂度")
              : t("长度大于 8，包含大小写字母和符号")
          }
        >
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t("角色")}>
          <select className="input" value={role} onChange={(e) => chooseRole(e.target.value as AccountRole)}>
            {(["admin", "operator", "viewer", "custom"] as const).map((r) => (
              <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>
            ))}
          </select>
        </Field>
        {value && (
          <Field label={t("状态")}>
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as "PENDING" | "ACTIVE" | "DISABLED")}
            >
              <option value="PENDING">{t("待审批")}</option>
              <option value="ACTIVE">{t("启用")}</option>
              <option value="DISABLED">{t("禁用")}</option>
            </select>
          </Field>
        )}
        <Field label={t("权限")} hint={t("勾选即自定义角色；管理员拥有全部权限")}>
          <div className="stack">
            {SCOPE_INFO.map((info) => (
              <label className="check-row" key={info.scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(info.scope)}
                  onChange={() => toggleScope(info.scope)}
                />
                <span>
                  <b>{t(info.label)}</b>
                  <small>{t(info.desc)}</small>
                </span>
                <Tag>{info.scope}</Tag>
              </label>
            ))}
          </div>
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

function AccountHistoryModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const out = await pcs<{ audit_logs: AuditRow[] }>(
          getLiveConnection(),
          `/api/v1/platform/audit-logs?account_id=${encodeURIComponent(account.account_id)}&limit=200`,
        );
        if (!cancelled) setRows(out.audit_logs ?? []);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.account_id]);

  return (
    <Modal open title={t("{name} 的操作记录", { name: account.username })} onClose={onClose} width={760}>
      {error && <Callout tone="bad">{error}</Callout>}
      {loading ? (
        <Empty text={t("加载中…")} />
      ) : rows.length === 0 ? (
        <Empty text={t("还没有操作记录。")} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("时间")}</th>
                <th>{t("动作")}</th>
                <th>{t("对象")}</th>
                <th>IP</th>
                <th>{t("详情")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.audit_id)}>
                  <td>{r.created_at ? new Date(r.created_at).toLocaleString("zh-CN") : "-"}</td>
                  <td><code>{r.action ?? "-"}</code></td>
                  <td>{r.subject ?? "-"}</td>
                  <td>{r.actor_ip ?? "-"}</td>
                  <td>
                    <span className="muted">
                      {r.detail && Object.keys(r.detail).length ? JSON.stringify(r.detail) : "-"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
