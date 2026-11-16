import { t } from "../i18n";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { db } from "../store";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import {
  deleteProfile,
  fetchAuthConfig,
  saveAgentProfile,
  saveApiProfile,
  setProfileEnabled,
  writeApiKey,
} from "../api";
import type { AgentProfile, ApiProfile, Role } from "../types";
import { Button, Callout, Card, Empty, Field, Modal, PageHead, Switch } from "../components/ui";
import { Icon } from "../components/Icon";

type Tab = "agent" | "api";

/**
 * Profile management: Agent Profile and API Profile.
 * Pick from here when deploying builders / schedulers instead of editing environment variables.
 */
export function ProfilesPage() {
  const live = useLive();
  // A deploy dialog that finds no Agent navigates here with `state.createAgent` set. Read it while
  // initializing so the page and the create dialog paint in one commit: opening the dialog from an
  // effect would flash the bare page first, and a query string would need a second navigation to
  // strip itself, both of which read as a hitch.
  const location = useLocation();
  const navigate = useNavigate();
  const createAgent = Boolean((location.state as { createAgent?: boolean } | null)?.createAgent);
  // Snapshot the arrival mode: the page fade would blink beneath a dialog that is already open
  // (the same reason the host page skips its enter animation for ?add=1). Keeping it in state stops
  // the fade from restarting when the arrival state is cleared below.
  const [skipEnter] = useState(createAgent);
  const [tab, setTab] = useState<Tab>("agent");
  const [editAgent, setEditAgent] = useState<AgentProfile | "new" | null>(() =>
    createAgent ? "new" : null,
  );
  const [editApi, setEditApi] = useState<ApiProfile | "new" | null>(null);
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: "agent" | "api"; id: string; name: string } | null
  >(null);
  const [confirmError, setConfirmError] = useState("");
  const [error, setError] = useState("");
  // Whether the control plane has a Secret Store, i.e. whether a key typed here can be stored at all.
  // Optimistic until the hint arrives so the dialog does not flicker.
  const [secretStore, setSecretStore] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetchAuthConfig().then((cfg) => {
      if (alive) setSecretStore(cfg.secret_store);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The deploy dialog opens this page with `state.createAgent`; clear it once the dialog has opened so
  // navigating back and forward (or refreshing) does not resurrect the create dialog.
  useEffect(() => {
    if (!createAgent) return;
    navigate(location.pathname, { replace: true, state: null });
  }, [createAgent, location.pathname, navigate]);

  async function remove(kind: "agent" | "api", id: string) {
    setBusy(id);
    setConfirmError("");
    try {
      await deleteProfile(kind, id, live.refresh);
      setConfirmDelete(null);
    } catch (e) {
      setConfirmError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function toggle(kind: "agent" | "api", id: string, enabled: boolean) {
    setBusy(id);
    setError("");
    try {
      await setProfileEnabled(kind, id, enabled, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={`page${skipEnter ? " page-static" : ""}`}>
      <PageHead
        title={t("配置")}
        meta={
          <>
            <span>{t("{count} 个 Agent", { count: db.agents.length })}</span>
            <span className="sep" />
            <span>{t("{count} 个 API", { count: db.apis.length })}</span>
          </>
        }
        actions={
          <Button
            variant="primary"
            onClick={() => (tab === "agent" ? setEditAgent("new") : setEditApi("new"))}
          >
            <Icon name="plus" size={14} />
            {tab === "agent" ? t("新建 Agent") : t("新建 API")}
          </Button>
        }
      />

      <div className="toolbar">
        <div className="segmented">
          <button className={`segment${tab === "agent" ? " active" : ""}`} onClick={() => setTab("agent")}>
            Agent<em>{db.agents.length}</em>
          </button>
          <button className={`segment${tab === "api" ? " active" : ""}`} onClick={() => setTab("api")}>
            API<em>{db.apis.length}</em>
          </button>
        </div>
      </div>

      {error && <Callout tone="bad">{error}</Callout>}

      {tab === "agent" ? (
        <Card flush>
          {db.agents.length === 0 ? (
            <Empty text={t("还没有 Agent Profile。")} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("名称")}</th>
                  <th>{t("角色")}</th>
                  <th>{t("适配器")}</th>
                  <th>{t("模型 API")}</th>
                  <th>{t("镜像")}</th>
                  <th>{t("启用")}</th>
                </tr>
              </thead>
              <tbody>
                {db.agents.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => setEditAgent(a)}
                    style={{ cursor: "pointer" }}
                    title={t("编辑")}
                  >
                    <td>
                      <b>{a.name}</b>
                      <div className="small" title={a.description}>
                        {a.description ? `${a.description} · v${a.version}` : `v${a.version}`}
                      </div>
                    </td>
                    <td>{a.role === "scheduler" ? t("调度机") : t("构建机")}</td>
                    <td><code>{a.adapter}</code></td>
                    <td>{db.apis.find((x) => x.id === a.model_api_profile_id)?.name ?? "-"}</td>
                    <td className="muted small">{a.artifact_image ? a.artifact_image.slice(0, 24) + "…" : t("实例镜像")}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                        <Switch
                          checked={a.enabled !== false}
                          disabled={busy === a.id}
                          label=""
                          onChange={() => void toggle("agent", a.id, !(a.enabled !== false))}
                        />
                        <Button
                          variant="ghost"
                          disabled={busy === a.id}
                          onClick={() => {
                            setConfirmError("");
                            setConfirmDelete({ kind: "agent", id: a.id, name: a.name });
                          }}
                        >
                          {t("删除")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : (
        <>
        {!secretStore && (
          <Callout tone="warn">
            {t("当前部署未配置 Secret Store：只能保存 secret:// 引用，密钥无法在这里写入。重新执行 scripts/deploy.sh 会启动它。")}
          </Callout>
        )}
        <Card flush>
          {db.apis.length === 0 ? (
            <Empty text={t("还没有 API Profile。")} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("名称")}</th>
                  <th>{t("类型")}</th>
                  <th>{t("地址")}</th>
                  <th>Secret</th>
                  <th>{t("启用")}</th>
                </tr>
              </thead>
              <tbody>
                {db.apis.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => setEditApi(a)}
                    style={{ cursor: "pointer" }}
                    title={t("编辑")}
                  >
                    <td><b>{a.name}</b></td>
                    <td><code>{a.kind}</code></td>
                    <td className="muted small">{a.base_url}</td>
                    <td><code className="small">{a.secret_ref}</code></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                        <Switch
                          checked={a.enabled !== false}
                          disabled={busy === a.id}
                          label=""
                          onChange={() => void toggle("api", a.id, !(a.enabled !== false))}
                        />
                        <Button
                          variant="ghost"
                          disabled={busy === a.id}
                          onClick={() => {
                            setConfirmError("");
                            setConfirmDelete({ kind: "api", id: a.id, name: a.name });
                          }}
                        >
                          {t("删除")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        </>
      )}

      {editAgent && (
        <AgentProfileModal
          value={editAgent === "new" ? null : editAgent}
          onClose={() => setEditAgent(null)}
          onSaved={live.refresh}
        />
      )}
      {editApi && (
        <ApiProfileModal
          value={editApi === "new" ? null : editApi}
          secretStore={secretStore}
          onClose={() => setEditApi(null)}
          onSaved={live.refresh}
        />
      )}
      {confirmDelete && (
        <Modal
          open
          title={t("删除")}
          onClose={() => setConfirmDelete(null)}
          width={400}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>{t("取消")}</Button>
              <Button
                variant="danger"
                disabled={busy === confirmDelete.id}
                onClick={() => void remove(confirmDelete.kind, confirmDelete.id)}
              >
                {busy === confirmDelete.id ? t("删除中…") : t("删除")}
              </Button>
            </>
          }
        >
          <p>{t("确定删除「{name}」？", { name: confirmDelete.name })}</p>
          {confirmError && <Callout tone="bad">{confirmError}</Callout>}
        </Modal>
      )}
    </div>
  );
}

function splitList(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

type AgentKind = "claude" | "codex" | "custom";

const AGENT_PRESETS: Record<
  "claude" | "codex",
  { label: string; adapter: "stdio-jsonrpc" | "http-local"; entrypoint: string[]; args: string[] }
> = {
  claude: {
    label: "Claude Code",
    adapter: "stdio-jsonrpc",
    entrypoint: ["node", "/opt/platform/agents/cli-agent.mjs"],
    args: [
      "--provider", "claude",
      "--extra-arg", "--dangerously-skip-permissions",
      "--pass-env", "ANTHROPIC_API_KEY",
      "--pass-env", "ANTHROPIC_BASE_URL",
    ],
  },
  codex: {
    label: "Codex",
    adapter: "stdio-jsonrpc",
    entrypoint: ["node", "/opt/platform/agents/cli-agent.mjs"],
    args: [
      "--provider", "codex",
      "--extra-arg", "--dangerously-bypass-approvals-and-sandbox",
      "--extra-arg", "--skip-git-repo-check",
      "--pass-env", "DEEPSEEK_API_KEY",
      "--pass-env", "CODEX_HOME",
    ],
  },
};

const ROLE_CAPS: Record<Role, string[]> = {
  builder: ["code.build", "shell", "chat"],
  scheduler: ["queue", "lease", "shell", "chat"],
};


function agentKindOf(value: AgentProfile): AgentKind {
  const args = value.args ?? [];
  const i = args.indexOf("--provider");
  const provider = i >= 0 ? args[i + 1] : "";
  return provider === "claude" || provider === "codex" ? provider : "custom";
}

/** The Profile version is the Agent's real version: take the highest registered version of the same type from the database. */
function agentVersion(kind: AgentKind): string {
  if (kind === "custom") return "latest";
  const hit = db.agents
    .filter((a) => agentKindOf(a) === kind)
    .map((a) => a.version)
    .filter((v) => v && v !== "-" && v !== "latest")
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  return hit ?? "latest";
}

type ApiProvider = "deepseek" | "anthropic" | "openai" | "custom";

// Base URLs are host roots, not `/v1` endpoints: the API adapter joins the path the Agent asks
// for (`/v1/messages`, `/v1/chat/completions`, …). For a model Profile the address must speak the
// Anthropic Messages API, which is what the Claude Code CLI calls.
const API_PRESETS: Record<
  Exclude<ApiProvider, "custom">,
  { label: string; base_url: string; auth_type: string; secret_ref: string }
> = {
  deepseek: {
    label: "DeepSeek",
    base_url: "https://api.deepseek.com/anthropic",
    // DeepSeek's Anthropic-compatible endpoint takes the key as a bearer token (ANTHROPIC_AUTH_TOKEN).
    auth_type: "bearer",
    secret_ref: "secret://apis/deepseek",
  },
  anthropic: {
    label: "Anthropic",
    base_url: "https://api.anthropic.com",
    auth_type: "api_key",
    secret_ref: "secret://apis/anthropic",
  },
  openai: {
    label: "OpenAI",
    base_url: "https://api.openai.com",
    auth_type: "bearer",
    secret_ref: "secret://apis/openai",
  },
};

/**
 * Match the provider by exact hostname. A substring check would classify
 * `https://api.anthropic.com.example.net/` as Anthropic, so parse the URL first
 * and compare the host only.
 */
export function apiProviderOf(baseUrl: string): ApiProvider {
  let hostname: string;
  try {
    hostname = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  if (hostname === "api.deepseek.com") return "deepseek";
  if (hostname === "api.anthropic.com") return "anthropic";
  if (hostname === "api.openai.com") return "openai";
  return "custom";
}

function AgentProfileModal({
  value,
  onClose,
  onSaved,
}: {
  value: AgentProfile | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initialKind = value ? agentKindOf(value) : "claude";
  const preset = initialKind === "custom" ? null : AGENT_PRESETS[initialKind];
  const [kind, setKind] = useState<AgentKind>(initialKind);
  const [name, setName] = useState(value?.name ?? preset?.label ?? "");
  const [role, setRole] = useState<Role>(value?.role ?? "builder");
  const [adapter, setAdapter] = useState(value?.adapter ?? preset?.adapter ?? "stdio-jsonrpc");
  const [image, setImage] = useState(value?.artifact_image ?? "");
  const [entrypoint, setEntrypoint] = useState(
    (value?.entrypoint ?? preset?.entrypoint ?? []).join(" "),
  );
  const [args, setArgs] = useState((value?.args ?? preset?.args ?? []).join(" "));
  const [capabilities, setCapabilities] = useState(
    (value?.capabilities ?? ROLE_CAPS[value?.role ?? "builder"]).join(", "),
  );
  const [description, setDescription] = useState(value?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(value?.system_prompt ?? "");
  // Empty = the host credential file (ANTHROPIC_API_KEY on the host). Selecting an API Profile routes
  // model traffic through the local adapter with a Secret Store credential instead.
  const [modelApi, setModelApi] = useState(value?.model_api_profile_id ?? "");
  // Only enabled llm Profiles can serve as the model; the current value stays listed even if disabled,
  // so editing another field does not silently unbind it.
  const modelApis = db.apis.filter(
    (a) => (a.kind === "llm" && a.enabled !== false) || a.id === modelApi,
  );
  // An empty string means all permissions by default; the runtime treats an empty allowed_tools as unrestricted.
  const [permissions, setPermissions] = useState((value?.allowed_tools ?? []).join(", "));
  const [maxTurns, setMaxTurns] = useState(value?.limits?.max_turns?.toString() ?? "");
  const [maxWall, setMaxWall] = useState(value?.limits?.max_wall_seconds?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function pickKind(next: AgentKind) {
    setKind(next);
    if (next === "custom") return;
    const p = AGENT_PRESETS[next];
    setAdapter(p.adapter);
    setEntrypoint(p.entrypoint.join(" "));
    setArgs(p.args.join(" "));
    const labels = Object.values(AGENT_PRESETS).map((x) => x.label);
    if (!name.trim() || labels.includes(name.trim())) setName(p.label);
  }

  function pickRole(next: Role) {
    setRole(next);
    const current = splitList(capabilities).join(",");
    if (!current || current === ROLE_CAPS[role].join(",")) {
      setCapabilities(ROLE_CAPS[next].join(", "));
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const version =
        value && value.version !== "-" ? value.version : agentVersion(kind);
      const limits: Record<string, number> = {};
      for (const [k, v] of Object.entries(value?.limits ?? {})) {
        if (typeof v === "number") limits[k] = v;
      }
      if (maxTurns.trim()) limits.max_turns = Number(maxTurns);
      else delete limits.max_turns;
      if (maxWall.trim()) limits.max_wall_seconds = Number(maxWall);
      else delete limits.max_wall_seconds;
      await saveAgentProfile(
        value?.id ?? null,
        {
          role_id: role,
          name: name.trim(),
          version,
          adapter: adapter as "stdio-jsonrpc" | "http-local",
          artifact_image: image.trim(),
          entrypoint: entrypoint.trim() ? entrypoint.trim().split(/\s+/) : [],
          args: args.trim() ? args.trim().split(/\s+/) : [],
          capabilities: splitList(capabilities),
          description: description.trim(),
          system_prompt: systemPrompt.trim(),
          // Persona / tone / goals were removed from the panel; clear them on save so invisible stale config is not left behind.
          persona: "",
          tone: "",
          goals: "",
          allowed_tools: splitList(permissions),
          limits,
          // null unbinds the model API; the deployment then needs the host credential file again.
          model_api_profile_id: modelApi || null,
        },
        onSaved,
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
      title={value ? t("编辑 {name}", { name: value.name }) : t("新建 Agent")}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? t("保存中…") : t("保存")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row">
          <Field label={t("名称")}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label={t("角色")}>
            <select
              className="input"
              value={role}
              disabled={!!value}
              onChange={(e) => pickRole(e.target.value as Role)}
            >
              <option value="builder">{t("构建机")}</option>
              <option value="scheduler">{t("调度机")}</option>
            </select>
          </Field>
          <Field label="Agent">
            <select
              className="input"
              value={kind}
              onChange={(e) => pickKind(e.target.value as AgentKind)}
            >
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="custom">{t("自定义")}</option>
            </select>
          </Field>
        </div>

        <Field label={t("模型 API")}>
          <select className="input" value={modelApi} onChange={(e) => setModelApi(e.target.value)}>
            <option value="">{t("使用主机凭据（不经适配器）")}</option>
            {modelApis.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.base_url}
              </option>
            ))}
          </select>
        </Field>
        {modelApi && (
          <p className="muted small" style={{ margin: 0 }}>
            {t("模型请求走本机 API 适配器，密钥来自 Secret Store；部署构建机 / 调度机时要把这个 API 一起选中。")}
          </p>
        )}

        <Field label={t("描述")}>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("一句话说明这个 Agent 的职责")}
          />
        </Field>

        <Field label={t("系统提示词")}>
          <textarea
            className="input"
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t("写给模型的行为准则；留空使用平台默认提示词")}
          />
        </Field>

        <Field label={t("权限")}>
          <input
            className="input"
            value={permissions}
            onChange={(e) => setPermissions(e.target.value)}
            placeholder={t("留空默认全部权限")}
          />
        </Field>

        <div className="row">
          <Field label={t("最大轮次")}>
            <input
              className="input"
              type="number"
              min={1}
              max={200}
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              placeholder={t("不限")}
            />
          </Field>
          <Field label={t("超时（秒）")}>
            <input
              className="input"
              type="number"
              min={1}
              max={86400}
              value={maxWall}
              onChange={(e) => setMaxWall(e.target.value)}
              placeholder="3600"
            />
          </Field>
        </div>

        {kind === "custom" && (
          <>
            <div className="row">
              <Field label={t("适配器")}>
                <select className="input" value={adapter} onChange={(e) => setAdapter(e.target.value)}>
                  <option value="stdio-jsonrpc">stdio-jsonrpc</option>
                  <option value="http-local">http-local</option>
                </select>
              </Field>
              <Field label={t("镜像")}>
                <input
                  className="input"
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                  placeholder="repo@sha256:<64hex>"
                />
              </Field>
            </div>

            <Field label={t("入口")}>
              <input
                className="input"
                value={entrypoint}
                onChange={(e) => setEntrypoint(e.target.value)}
                placeholder={adapter === "http-local" ? "http://127.0.0.1:18090" : "node /opt/agents/agent.mjs"}
              />
            </Field>

            <Field label={t("参数")}>
              <input
                className="input"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="--provider custom --command /usr/local/bin/agent"
              />
            </Field>

            <Field label={t("能力")}>
              <input
                className="input"
                value={capabilities}
                onChange={(e) => setCapabilities(e.target.value)}
                placeholder="build, test"
              />
            </Field>
          </>
        )}

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

function ApiProfileModal({
  value,
  secretStore,
  onClose,
  onSaved,
}: {
  value: ApiProfile | null;
  /** False when the control plane has no Secret Store: the key field is then disabled and only refs can be saved. */
  secretStore: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initialProvider = value ? apiProviderOf(value.base_url) : "deepseek";
  const preset = initialProvider === "custom" ? null : API_PRESETS[initialProvider];
  const [provider, setProvider] = useState<ApiProvider>(initialProvider);
  const [name, setName] = useState(value?.name ?? preset?.label ?? "");
  const [kind, setKind] = useState(value?.kind ?? "llm");
  const [baseUrl, setBaseUrl] = useState(value?.base_url ?? preset?.base_url ?? "");
  const [authType, setAuthType] = useState(value?.auth_type ?? preset?.auth_type ?? "bearer");
  const [secretRef, setSecretRef] = useState(value?.secret_ref ?? preset?.secret_ref ?? "");
  const [egress, setEgress] = useState(value?.egress && value.egress !== "-" ? value.egress : "");
  const [timeout, setTimeoutSec] = useState(value?.timeout_seconds ?? 60);
  const [apiKey, setApiKey] = useState("");
  const [createdId, setCreatedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function pickProvider(next: ApiProvider) {
    setProvider(next);
    if (next === "custom") return;
    const p = API_PRESETS[next];
    setKind("llm");
    setBaseUrl(p.base_url);
    setAuthType(p.auth_type);
    setSecretRef(p.secret_ref);
    const labels = Object.values(API_PRESETS).map((x) => x.label);
    if (!name.trim() || labels.includes(name.trim())) setName(p.label);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const id = await saveApiProfile(
        value?.id ?? (createdId || null),
        {
          name: name.trim(),
          kind,
          base_url: baseUrl.trim(),
          auth_type: authType,
          secret_ref: secretRef.trim(),
          egress: egress.trim() || undefined,
          timeout_seconds: timeout,
        },
        onSaved,
      );
      if (apiKey.trim() && secretStore) {
        // The key is written only to the Secret Store; on failure keep the dialog and the already-created Profile so a retry does not create another one.
        setCreatedId(id);
        await writeApiKey(id, apiKey.trim());
        setApiKey("");
      }
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
      title={value ? t("编辑 {name}", { name: value.name }) : t("新建 API")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || !name.trim() || !baseUrl.trim() || !secretRef.trim()}
          >
            {busy ? t("保存中…") : t("保存")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row">
          <Field label={t("服务商")}>
            <select
              className="input"
              value={provider}
              onChange={(e) => pickProvider(e.target.value as ApiProvider)}
            >
              <option value="deepseek">DeepSeek</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="custom">{t("自定义")}</option>
            </select>
          </Field>
          <Field label={t("名称")}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
        </div>

        <Field label="Base URL">
          <input
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              kind === "llm" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com"
            }
          />
        </Field>
        {kind === "llm" && (
          <p className="muted small" style={{ margin: 0 }}>
            {t("模型请求经构建机内的 API 适配器转发，地址只写到主机根路径；必须提供 Anthropic Messages 接口（DeepSeek 用 https://api.deepseek.com/anthropic）。")}
          </p>
        )}

        <div className="row">
          <Field label="API Key">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              disabled={!secretStore}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                !secretStore ? t("未配置 Secret Store") : value ? t("留空不修改") : "sk-…"
              }
            />
          </Field>
          <Field label={t("超时（秒）")}>
            <input
              className="input"
              type="number"
              min={1}
              max={600}
              value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
            />
          </Field>
        </div>

        {provider === "custom" && (
          <>
            <Field label={t("密钥引用")}>
              <input
                className="input"
                value={secretRef}
                onChange={(e) => setSecretRef(e.target.value)}
                placeholder="secret://apis/deepseek"
              />
            </Field>
            <div className="row">
              <Field label={t("类型")}>
                <select className="input" value={kind} disabled={!!value} onChange={(e) => setKind(e.target.value as ApiProfile["kind"])}>
                  <option value="llm">{t("大模型")}</option>
                  <option value="tool">{t("工具")}</option>
                  <option value="http">HTTP</option>
                  <option value="storage">{t("存储")}</option>
                </select>
              </Field>
              <Field label={t("认证")}>
                <select className="input" value={authType} onChange={(e) => setAuthType(e.target.value)}>
                  <option value="bearer">Bearer</option>
                  <option value="api_key">API Key</option>
                  <option value="oauth2_client">OAuth2</option>
                  <option value="mtls">mTLS</option>
                </select>
              </Field>
              <Field label="Egress">
                <input
                  className="input"
                  value={egress}
                  onChange={(e) => setEgress(e.target.value)}
                  placeholder="default"
                />
              </Field>
            </div>
          </>
        )}

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
