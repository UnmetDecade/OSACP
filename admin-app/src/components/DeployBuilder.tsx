import { useState } from "react";
import { t } from "../i18n";
import { editHost } from "../api";
import { errorMessage } from "../live/client";
import { useLive } from "../live/context";
import type { Host } from "../types";
import { Button, Callout, Modal } from "./ui";

/**
 * Deploy builder: first explain the trade-off between container and bare-metal builders, then pick one.
 *
 * A container builder uses the existing CreateBuilderModal; a bare-metal builder switches the host role to builder,
 * and the control plane automatically creates and starts a native builder process on the host.
 */
export function DeployBuilderModal({
  host,
  onClose,
  onDone,
}: {
  host: Host;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const live = useLive();
  const [busy, setBusy] = useState<"container" | "native" | null>(null);
  const [notice, setNotice] = useState<{ tone: "warn" | "bad"; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function deployNative() {
    setBusy("native");
    setNotice(null);
    try {
      const out = await editHost(host.id, { role_mode: "builder" }, async () => {
        if (live.connected) await live.refresh();
      });
      if (out.warning) {
        setNotice({
          tone: "warn",
          text: t("主机角色已切换，但裸机构建机没有启动：{reason}", { reason: out.warning }),
        });
        return;
      }
      if (out.native_builder) {
        setDone(
          t("裸机构建机已创建（{status}），主机上报后即可接任务。", {
            status: out.native_builder.status,
          }),
        );
        return;
      }
      setDone(t("这台主机已经是裸机构建机。"));
    } catch (e) {
      setNotice({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open
      title={t("部署构建机")}
      onClose={onClose}
      width={720}
      footer={
        done ? (
          <Button
            variant="primary"
            onClick={() => {
              void onDone();
              onClose();
            }}
          >
            {t("完成")}
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy !== null}>
              {t("取消")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void deployNative()}
              disabled={busy !== null}
            >
              {busy === "native" ? t("部署中…") : t("部署裸机构建机")}
            </Button>
          </>
        )
      }
    >
      <div className="builder-choice">
        <section className="builder-choice-card">
          <header>
            <b>{t("容器构建机")}</b>
          </header>
          <p>{t("Agent 跑在 Docker 容器里，和主机系统隔离。")}</p>
          <ul className="builder-points">
            <li className="is-pro">{t("一台主机可以跑多台，容量按需分配")}</li>
            <li className="is-pro">{t("镜像固定，依赖干净，坏了删掉重建即可")}</li>
            <li className="is-pro">{t("任务之间互不影响，适合标准构建")}</li>
            <li className="is-con">{t("需要 Docker，主机内核和设备能力受限")}</li>
            <li className="is-con">{t("启动和磁盘有额外开销")}</li>
            <li className="is-con">{t("容器里看不到主机上的进程和设备")}</li>
          </ul>
        </section>

        <section className="builder-choice-card">
          <header>
            <b>{t("裸机构建机")}</b>
          </header>
          <p>{t("Agent 直接跑在主机上，不经 Docker。")}</p>
          <ul className="builder-points">
            <li className="is-pro">{t("直接使用主机 CPU、GPU、网络和设备")}</li>
            <li className="is-pro">{t("没有容器开销，能跑 Docker 里跑不了的命令")}</li>
            <li className="is-pro">{t("终端直接登录主机，排查问题方便")}</li>
            <li className="is-con">{t("一台主机只能当构建机，不能再跑容器角色")}</li>
            <li className="is-con">{t("没有 CPU / 内存隔离，任务会争抢资源")}</li>
            <li className="is-con">{t("依赖主机已装好的环境，迁移和回滚更重")}</li>
          </ul>
        </section>
      </div>

      {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
      {done && <Callout tone="info">{done}</Callout>}
    </Modal>
  );
}
