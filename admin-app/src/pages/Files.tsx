import { t } from "../i18n";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { db } from "../store";
import { errorMessage } from "../live/client";
import {
  deleteWorkspaceEntry,
  downloadWorkspaceEntry,
  listWorkspace,
  PREVIEW_LIMIT_BYTES,
  readWorkspaceFile,
  type WorkspaceEntry,
  type WorkspaceListing,
} from "../live/workspace";
import { Button, Callout, Card, Empty, Modal, PageHead } from "../components/ui";
import { Icon } from "../components/Icon";

/**
 * Workspace browser for one builder.
 *
 * The listing is a plain directory read on the instance (docker exec / ssh), so it reflects what the
 * task actually sees. Paths stay relative to the workspace root; the page keeps its location in state
 * rather than the URL because the root differs between containers and bare-metal builders.
 */
export function FilesPage() {
  const { id = "" } = useParams();
  const instance = db.instances.find((i) => i.id === id);
  const hostId = instance?.host_id ?? "";
  const instanceId = instance?.id ?? "";
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);

  useEffect(() => {
    if (!hostId || !instanceId) return;
    let alive = true;
    setLoading(true);
    setError("");
    listWorkspace(hostId, instanceId, path)
      .then((out) => {
        if (alive) setListing(out);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [hostId, instanceId, path, nonce]);

  if (!instance) {
    return (
      <div className="page">
        <Card><Empty text={t("构建机不存在或已被删除。")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/builders">{t("返回构建机列表")}</Link></p>
      </div>
    );
  }

  const crumbs = path ? path.split("/") : [];

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  function download(entry: WorkspaceEntry) {
    const target = path ? `${path}/${entry.name}` : entry.name;
    void run(`download:${entry.name}`, () => downloadWorkspaceEntry(hostId, instanceId, target));
  }

  async function downloadCurrent() {
    await run("download:current", () => downloadWorkspaceEntry(hostId, instanceId, path));
  }

  function view(entry: WorkspaceEntry) {
    const target = path ? `${path}/${entry.name}` : entry.name;
    void run(`view:${entry.name}`, async () => {
      const text = await readWorkspaceFile(hostId, instanceId, target);
      setPreview({ name: entry.name, text });
    });
  }

  function remove(entry: WorkspaceEntry) {
    if (!window.confirm(t("删除 {name}？此操作不可恢复。", { name: entry.name }))) return;
    const target = path ? `${path}/${entry.name}` : entry.name;
    void run(`delete:${entry.name}`, async () => {
      await deleteWorkspaceEntry(hostId, instanceId, target);
      setNonce((n) => n + 1);
    });
  }

  const root = listing?.root ?? instance.workspace ?? "/opt/platform/workspace";

  return (
    <div className="page">
      <Link className="back" to={`/builders/${instance.id}`}>
        <Icon name="back" size={13} />
        {instance.name}
      </Link>
      <PageHead
        title={t("工作目录")}
        meta={
          <>
            <code>{root}</code>
            <span className="sep" />
            <span>{t("共 {count} 项", { count: listing?.entries.length ?? 0 })}</span>
            {loading && <span className="sep" />}
            {loading && <span>{t("加载中…")}</span>}
          </>
        }
        actions={
          <>
            {path && (
              <Button
                onClick={() => setPath(crumbs.slice(0, -1).join("/"))}
                disabled={loading}
              >
                <Icon name="up" size={13} />
                {t("上级目录")}
              </Button>
            )}
            <Button onClick={() => setNonce((n) => n + 1)} disabled={loading}>
              <Icon name="refresh" size={13} />
              {t("刷新")}
            </Button>
            <Button onClick={() => void downloadCurrent()} disabled={busy === "download:current" || loading}>
              <Icon name="download" size={13} />
              {t("下载当前文件夹")}
            </Button>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      <div className="crumbs" aria-label={t("路径")}>
        <button type="button" className="link" onClick={() => setPath("")}>{root}</button>
        {crumbs.map((segment, index) => (
          <span key={`${segment}-${index}`}>
            <span className="crumb-sep">/</span>
            <button
              type="button"
              className="link"
              onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      <Card flush>
        {listing?.entries.length ? (
          <table className="table file-table">
            <thead>
              <tr>
                <th>{t("名称")}</th>
                <th>{t("大小")}</th>
                <th>{t("修改时间")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {listing.entries.map((entry) => (
                <tr key={entry.name}>
                  <td>
                    <div className="file-name">
                      <Icon name={entry.type === "dir" ? "folder" : "file"} size={15} />
                      {entry.type === "dir" ? (
                        <button
                          type="button"
                          className="link"
                          onClick={() => setPath(path ? `${path}/${entry.name}` : entry.name)}
                        >
                          {entry.name}
                        </button>
                      ) : (
                        <span>{entry.name}</span>
                      )}
                      {entry.type === "symlink" && <small className="muted">{t("符号链接")}</small>}
                    </div>
                  </td>
                  <td className="muted small">{entry.type === "dir" ? "-" : formatSize(entry.size)}</td>
                  <td className="muted small">
                    {entry.modified_at ? new Date(entry.modified_at).toLocaleString("zh-CN") : "-"}
                  </td>
                  <td>
                    <div className="row-actions">
                      {entry.type === "file" && entry.size !== null && entry.size <= PREVIEW_LIMIT_BYTES && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t("查看")}
                          onClick={() => view(entry)}
                          disabled={busy === `view:${entry.name}`}
                        >
                          <Icon name="file" size={13} />
                          {t("查看")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        title={entry.type === "dir" ? t("下载文件夹（tar.gz）") : t("下载")}
                        onClick={() => download(entry)}
                        disabled={busy === `download:${entry.name}`}
                      >
                        <Icon name="download" size={13} />
                        {t("下载")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t("删除")}
                        onClick={() => remove(entry)}
                        disabled={busy === `delete:${entry.name}`}
                      >
                        <Icon name="trash" size={13} />
                        {t("删除")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text={loading ? t("加载中…") : t("空目录")} />
        )}
      </Card>

      {listing?.truncated && (
        <p className="footnote" style={{ marginTop: 8 }}>
          {t("条目过多，只显示前 {count} 项。", { count: listing.entries.length })}
        </p>
      )}

      {preview && (
        <Modal
          open
          title={t("预览 {name}", { name: preview.name })}
          onClose={() => setPreview(null)}
          width={860}
        >
          <pre className="code-block" style={{ maxHeight: "60vh", overflow: "auto", whiteSpace: "pre-wrap" }}>
            {preview.text}
          </pre>
        </Modal>
      )}
    </div>
  );
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
