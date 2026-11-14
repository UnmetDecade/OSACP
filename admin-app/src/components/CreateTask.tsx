import { t } from "../i18n";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { submitBuild } from "../api";
import { zipFiles } from "../zip";
import type { ApprovalMode, TaskAttachment } from "../types";
import { Button, Callout, Field, Modal, Tag } from "./ui";

/**
 * Create task dialog.
 *
 * Tasks go only to the local root scheduler, which dispatches them by the scheduling algorithm; so no builder is chosen and no difficulty is entered here.
 * Attachments (screenshots, md, txt, code folders, etc.) are uploaded to the control plane first, and the task carries only a one-time URL;
 * when the builder runs, it unpacks the content into the workspace's attachments/ directory and passes the paths to the Agent.
 *
 * Folders are zipped in the browser, skipping node_modules / .git / build output and other
 * such directories, so a frontend project does not upload all its dependencies.
 */

/** Per-attachment (compressed) limit; the control plane caps a single request at 32MiB, leaving room for base64 expansion. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Limit for a packed folder; above it, ask the user to exclude dependencies or use a Git repository. */
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
/** Read limit for an unfolded folder, to prevent accidentally selecting the entire home directory. */
const MAX_FOLDER_RAW = 120 * 1024 * 1024;
const MAX_FOLDER_FILES = 6000;
const MAX_FILES = 32;

/** Dependency directories and build output are not uploaded with the task. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".cache", ".next", ".nuxt", ".turbo",
  "dist", "build", "out", "target", "coverage", "__pycache__", ".venv", "venv",
  ".idea", ".vscode", ".gradle", ".mvn", ".terraform", "Pods", "DerivedData",
  "vendor",
]);
const SKIP_FILE = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const SKIP_EXT = /\.(pyc|pyo|class|o|obj|so|dylib|dll|exe)$/i;

/** Image types safe to render from a data URL; everything else keeps the generic file chip. */
const PREVIEW_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Build an `img` source only for allow-listed raster types and valid base64.
 * Media types come from the attachment payload, so never interpolate an
 * arbitrary `image/*` (or `image/svg+xml`) value into a data URL.
 */
export function attachmentPreviewSrc(mediaType: string, dataBase64: string): string | null {
  if (!PREVIEW_IMAGE_TYPES.has(mediaType)) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) return null;
  return `data:${mediaType};base64,${dataBase64}`;
}

interface PickedEntry {
  /** Path relative to the folder root. */
  path: string;
  file: File;
}

function isSkipped(relPath: string): boolean {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] ?? "";
  return SKIP_FILE.test(base) || SKIP_EXT.test(base);
}

function relativeFromWebkit(file: File): { root: string; path: string } {
  const full =
    (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const parts = full.split("/").filter(Boolean);
  return { root: parts[0] ?? "folder", path: parts.slice(1).join("/") };
}

/** Dropped directories are expanded recursively; readEntries returns one batch at a time, so read until it is empty. */
async function walkDirectory(
  dir: FileSystemDirectoryEntry,
  prefix: string,
  out: PickedEntry[],
): Promise<void> {
  const reader = dir.createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) break;
    for (const entry of batch) {
      if (out.length >= MAX_FOLDER_FILES) return;
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        );
        out.push({ path: `${prefix}${entry.name}`, file });
      } else if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walkDirectory(entry as FileSystemDirectoryEntry, `${prefix}${entry.name}/`, out);
      }
    }
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Large images are scaled below 1600px and converted to JPEG; small ones are kept as-is so text in screenshots stays sharp. */
async function imagePayload(file: File): Promise<{ blob: Blob; name: string; mediaType: string }> {
  const keep = { blob: file, name: file.name || "image", mediaType: file.type || "image/png" };
  if (file.size <= 500_000) return keep;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return keep;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) return keep;
    const stem = (file.name || "image").replace(/\.[^.]+$/, "");
    return { blob, name: `${stem}.jpg`, mediaType: "image/jpeg" };
  } catch {
    return keep;
  }
}

async function readFile(file: File): Promise<TaskAttachment> {
  const payload = file.type.startsWith("image/")
    ? await imagePayload(file)
    : { blob: file as Blob, name: file.name || "attachment", mediaType: file.type || "application/octet-stream" };
  if (payload.blob.size > MAX_FILE_BYTES) {
    throw new Error(
      t("附件「{name}」太大（{size}），单个不能超过 {max}", {
        name: payload.name,
        size: sizeLabel(payload.blob.size),
        max: sizeLabel(MAX_FILE_BYTES),
      }),
    );
  }
  return {
    name: payload.name,
    media_type: payload.mediaType,
    size: payload.blob.size,
    data_base64: toBase64(await payload.blob.arrayBuffer()),
  };
}

export function CreateTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const live = useLive();
  const { host } = useHostScope();
  // Tasks are always handed to the local root scheduler, which dispatches them to a builder or node scheduler by the scheduling algorithm.
  const rootScheduler = db.instances.find(
    (i) =>
      i.role === "scheduler" &&
      (!host || i.host_id === host.id) &&
      (i.scheduler_role ?? "root") === "root",
  );
  // The title is the human-readable row in the task list; the description carries the full instruction.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(2);
  // The default matches scheduler_config.default_approval_mode; a stricter level makes the
  // agent stop and ask instead of acting, which is what most exploratory work wants.
  const [approval, setApproval] = useState<ApprovalMode>("full");
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [reading, setReading] = useState(false);
  const [packing, setPacking] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setPriority(2);
      setApproval("full");
      setAttachments([]);
      setError("");
      setDragging(false);
      setPacking("");
      setMenuOpen(false);
    }
  }, [open]);

  // Clicking outside the menu collapses the file / folder picker.
  // Use the capture phase: the dialog stops bubbling, so a document listener in the bubble phase misses clicks inside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!addMenu.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [menuOpen]);

  async function addFiles(files: File[]) {
    if (!files.length) return;
    setReading(true);
    setError("");
    try {
      const room = MAX_FILES - attachments.length;
      if (room <= 0) throw new Error(t("最多添加 {count} 个附件", { count: MAX_FILES }));
      const next = [...attachments];
      for (const file of files.slice(0, room)) next.push(await readFile(file));
      setAttachments(next);
      if (files.length > room) {
        setError(t("最多添加 {count} 个附件，超出的已忽略", { count: MAX_FILES }));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  }

  /** Pack the folder into one zip and upload it as a single attachment. */
  async function addFolder(root: string, entries: PickedEntry[]) {
    setReading(true);
    setError("");
    try {
      if (attachments.length >= MAX_FILES) {
        throw new Error(t("最多添加 {count} 个附件", { count: MAX_FILES }));
      }
      const kept = entries.filter((e) => e.path && !isSkipped(e.path) && e.file.size > 0);
      if (!kept.length) {
        throw new Error(t("没有可添加的文件（已跳过依赖目录和构建产物）"));
      }
      const raw = kept.reduce((sum, e) => sum + e.file.size, 0);
      if (raw > MAX_FOLDER_RAW) {
        throw new Error(
          t("文件夹太大（{size}），请先排除依赖目录或改用 Git 仓库让 Agent 自己拉取", {
            size: sizeLabel(raw),
          }),
        );
      }
      const zip = await zipFiles(root || "folder", kept, (done, total) => {
        setPacking(t("打包中… {done}/{total}", { done, total }));
      });
      if (zip.size > MAX_ZIP_BYTES) {
        throw new Error(
          t("打包后仍有 {size}，超过单个附件上限 {max}；请先排除依赖目录或改用 Git 仓库", {
            size: sizeLabel(zip.size),
            max: sizeLabel(MAX_ZIP_BYTES),
          }),
        );
      }
      const item = await readFile(zip);
      setAttachments((prev) => [...prev, item]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPacking("");
      setReading(false);
    }
  }

  async function addFolderFiles(files: File[]) {
    if (!files.length) return;
    const parsed = files.map((file) => ({ ...relativeFromWebkit(file), file }));
    const root = parsed[0]?.root ?? "folder";
    await addFolder(
      root,
      parsed.map((p) => ({ path: p.path || p.file.name, file: p.file })),
    );
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    const fromItems = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => Boolean(f));
    const all = files.length ? files : fromItems;
    if (all.length) {
      e.preventDefault();
      void addFiles(all);
    }
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const items = Array.from(e.dataTransfer.items ?? []);
    const entries: PickedEntry[] = [];
    let root = "";
    try {
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (!entry) continue;
        if (!root) root = entry.name;
        if (entry.isDirectory) {
          await walkDirectory(entry as FileSystemDirectoryEntry, "", entries);
        } else if (entry.isFile) {
          const file = item.getAsFile();
          if (file) entries.push({ path: entry.name, file });
        }
      }
    } catch {
      // Fall back to a plain file list when the browser does not support dropping directories.
    }
    if (entries.length) {
      await addFolder(root || "folder", entries);
      return;
    }
    await addFiles(Array.from(e.dataTransfer.files));
  }

  async function submit() {
    if (!description.trim() && attachments.length === 0) {
      setError(t("先描述要完成的任务，或添加附件"));
      return;
    }
    if (!rootScheduler) {
      setError(t("当前主机没有根调度机，先部署根调度机"));
      return;
    }
    if (rootScheduler.state !== "ONLINE") {
      setError(t("根调度机不在线，暂时不能接任务"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await submitBuild(
        {
          title: title.trim(),
          description: description.trim() || attachments.map((a) => a.name).join("、"),
          priority,
          approval_mode: approval,
          scheduler_deployment_id: rootScheduler.deployment_id,
          attachments,
        },
        async () => {
          if (live.connected) await live.refresh();
        },
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("创建任务")}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || reading || !rootScheduler || rootScheduler.state !== "ONLINE"}
          >
            {busy ? t("提交中…") : t("进入队列")}
          </Button>
        </>
      }
    >
      <div
        className={`stack create-task${dragging ? " is-dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={onDrop}
      >
        <Field label={t("标题")} hint={t("列表里显示这一行，留空则取任务内容的第一行")}>
          <input
            className="input"
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("例如：像素风网页游戏 Demo")}
          />
        </Field>

        <Field label={t("任务内容")}>
          <textarea
            className="input"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onPaste={onPaste}
            placeholder={t("例如：用 C++ 打印 Hello World，并编译运行。")}
          />
        </Field>

        <div className="attach-box">
          <div className="attach-head">
            <span className="field-label">{t("附件")}</span>
            {packing && <span className="attach-size">{packing}</span>}
            <div className="attach-add" ref={addMenu}>
              <Button
                size="sm"
                onClick={() => setMenuOpen((v) => !v)}
                disabled={reading || attachments.length >= MAX_FILES}
              >
                {reading && !packing ? t("读取中…") : t("添加附件")}
              </Button>
              {menuOpen && (
                <div className="attach-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      picker.current?.click();
                    }}
                  >
                    {t("文件")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      folderPicker.current?.click();
                    }}
                  >
                    {t("文件夹")}
                  </button>
                </div>
              )}
            </div>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept="image/*,.md,.markdown,.txt,.json,.csv,.log,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.sh,.pdf,.zip"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <input
              ref={folderPicker}
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => {
                void addFolderFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
          {attachments.length > 0 && (
            <div className="attach-list">
              {attachments.map((a, i) => {
                const preview = attachmentPreviewSrc(a.media_type, a.data_base64);
                return (
                  <div className="attach-row" key={`${a.name}-${i}`}>
                    {preview ? (
                      <img className="attach-thumb" src={preview} alt={a.name} />
                    ) : (
                      <Tag tone="accent">{t("文件")}</Tag>
                    )}
                    <span className="attach-name" title={a.name}>{a.name}</span>
                    <span className="attach-size">{sizeLabel(a.size)}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      title={t("移除")}
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Field label={t("优先级")}>
          <div className="segmented">
            {[0, 1, 2, 3].map((p) => (
              <button key={p} className={`segment${priority === p ? " active" : ""}`} onClick={() => setPriority(p)}>
                P{p}
                <em>{[t("最高"), t("高"), t("普通"), t("低")][p]}</em>
              </button>
            ))}
          </div>
        </Field>

        {/* The agent parks with a question when the level forbids an action, so a stricter level is
            a way to review the plan before anything runs. */}
        <Field label={t("自主程度")} hint={t("从低到高：只读并提问、可改文件、可执行命令、完全自主")}>
          <div className="segmented">
            {(["ask", "edits", "auto", "full"] as const).map((mode) => (
              <button key={mode} className={`segment${approval === mode ? " active" : ""}`} onClick={() => setApproval(mode)}>
                {t({ ask: "只读并提问", edits: "可改文件", auto: "可执行命令", full: "完全自主" }[mode])}
              </button>
            ))}
          </div>
        </Field>
        {rootScheduler ? (
          <div className="small muted">
            {t("任务将由本机根调度机「{name}」按负载与能力自动派发。", { name: rootScheduler.name })}
          </div>
        ) : (
          <Callout tone="warn">
            {t("当前主机没有根调度机，先部署根调度机。")}
            <Link className="link" to="/?add=scheduler" onClick={onClose}>{t("去 AI Agent 工作室部署调度机")}</Link>
          </Callout>
        )}
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
