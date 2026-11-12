import { t } from "../i18n";
import { useState } from "react";
import { db } from "../store";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { setInstanceProfiles } from "../api";
import type { Instance, Role } from "../types";
import { Button, Callout, Field, Modal, Tag } from "../components/ui";

/**
 * Choose which Agent and APIs an instance uses.
 * Only the control plane bindings are written; the instance loads Profiles from the new bindings after a restart.
 */
export function InstanceProfilesModal({
  instance,
  role,
  onClose,
}: {
  instance: Instance;
  role: Role;
  onClose: () => void;
}) {
  const live = useLive();
  const agents = db.agents.filter((a) => a.enabled !== false && a.role === role);
  const apis = db.apis.filter((a) => a.enabled !== false);
  const [agent, setAgent] = useState(instance.agent_profile_id);
  const [apiIds, setApiIds] = useState<string[]>(instance.api_profile_ids);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const changed =
    agent !== instance.agent_profile_id ||
    apiIds.length !== instance.api_profile_ids.length ||
    apiIds.some((id) => !instance.api_profile_ids.includes(id));

  function toggleApi(id: string) {
    setApiIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit() {
    if (!agent) {
      setError(t("先选择一个 Agent Profile"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await setInstanceProfiles(
        instance.host_id,
        instance.id,
        agent,
        role,
        apiIds,
        instance.api_profile_ids,
        live.refresh,
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
      open
      title={t("配置 · {name}", { name: instance.name })}
      onClose={onClose}
      width={580}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !changed}>
            {busy ? t("保存中…") : t("保存")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Agent">
          <div className="role-grid">
            {agents.map((a) => (
              <button
                key={a.id}
                className={`select-card${agent === a.id ? " selected" : ""}`}
                onClick={() => setAgent(a.id)}
              >
                <span className="select-head"><b>{a.name}</b><Tag>v{a.version}</Tag></span>
                <code>{a.adapter}</code>
                <small className="footnote">{a.capabilities.join(" · ")}</small>
              </button>
            ))}
          </div>
          {agents.length === 0 && (
            <p className="footnote">还没有{role === "scheduler" ? t("调度机") : t("构建机")} Agent，先到「配置」页新建。</p>
          )}
        </Field>

        <Field label="API">
          <div className="chips">
            {apis.map((a) => {
              const checked = apiIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  className={`chip${checked ? " tag-accent" : ""}`}
                  style={{ cursor: "pointer", height: 24 }}
                  onClick={() => toggleApi(a.id)}
                >
                  {a.name}
                </button>
              );
            })}
          </div>
        </Field>

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
