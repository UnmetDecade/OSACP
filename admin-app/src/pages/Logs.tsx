import { t } from "../i18n";
import { db } from "../store";
import { Badge, Card, Empty, PageHead } from "../components/ui";

/**
 * 日志：调度机与控制面的操作记录。
 * 数据来自控制面审计日志。
 */
export function LogsPage() {
  const logs = db.logs;
  return (
    <div className="page">
      <PageHead
        title={t("日志")}
        meta={
          <>
            <span>{t("{count} 条", { count: logs.length })}</span>
            <span className="sep" />
            <span>{t("调度机与控制面")}</span>
          </>
        }
      />

      <Card flush>
        {logs.length === 0 ? (
          <Empty text={t("还没有日志。")} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("时间")}</th>
                <th>{t("动作")}</th>
                <th>{t("对象")}</th>
                <th>{t("结果")}</th>
                <th>{t("详情")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="muted small">{new Date(l.at).toLocaleString("zh-CN")}</td>
                  <td><code>{l.action}</code></td>
                  <td>{l.object}</td>
                  <td><Badge value={l.result === "OK" ? "SUCCEEDED" : "FAILED"} /></td>
                  <td className="muted small">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
