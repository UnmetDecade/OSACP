import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../i18n";
import { useAuth } from "../auth";
import { getLiveConnection } from "../live/config";
import { errorMessage, pcs } from "../live/client";
import type { Mandate, PolicyDocument } from "../types";
import { Callout, Card, CardTitle, Empty, PageHead, Tag } from "../components/ui";

/**
 * Admission policy and the mandates issued under it.
 *
 * The policy is versioned in the control plane; each task carries an immutable mandate
 * (source, actor, policy version, strength) that explains why it was authorized.
 */
export function PolicyPage() {
  const auth = useAuth();
  const [policy, setPolicy] = useState<{ version: string; document: PolicyDocument } | null>(null);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [policyOut, mandatesOut] = await Promise.all([
        pcs<{ version: string; document: PolicyDocument }>(getLiveConnection(), "/api/v1/platform/policy"),
        pcs<{ mandates: Mandate[] }>(getLiveConnection(), "/api/v1/platform/mandates?limit=100"),
      ]);
      setPolicy(policyOut);
      setMandates(mandatesOut.mandates ?? []);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const canRead = auth.hasScope("audit:read");

  useEffect(() => {
    if (canRead) void load();
    else setLoading(false);
  }, [canRead, load]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHead title={t("策略")} />
        <Callout tone="warn">{t("当前账号没有查看策略的权限。")}</Callout>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead
        title={t("策略")}
        meta={
          <>
            {policy ? <Tag>{t("策略 v{version}", { version: policy.version })}</Tag> : null}
            <span className="sep" />
            <span>{t("{count} 条授权记录", { count: mandates.length })}</span>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      <Card>
        <CardTitle>{t("策略与授权")}</CardTitle>
        <div className="muted" style={{ marginBottom: 10 }}>
          {t("来源准入规则与最近的授权记录。")}
        </div>
        {loading ? (
          <Empty text={t("加载中…")} />
        ) : mandates.length === 0 ? (
          <Empty text={t("还没有授权记录。")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("时间")}</th>
                  <th>{t("操作人")}</th>
                  <th>{t("来源")}</th>
                  <th>{t("强度")}</th>
                  <th>{t("任务")}</th>
                  <th>{t("策略")}</th>
                </tr>
              </thead>
              <tbody>
                {mandates.map((m) => (
                  <tr key={m.mandate_id}>
                    <td className="muted small">{new Date(m.issued_at).toLocaleString("zh-CN")}</td>
                    <td>{m.actor}</td>
                    <td><Tag>{m.source}</Tag></td>
                    <td>{m.strength === "explicit" ? t("显式") : t("推断")}</td>
                    <td>
                      {m.task_id ? (
                        <Link className="link" to={`/tasks/${m.task_id}`}>{m.task_id}</Link>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>v{m.policy_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
