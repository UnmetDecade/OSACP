# secret-store · Secret Store 参考实现

> [English](README.md) · 简体中文

对应 [../docs/admin-app.zh-CN.md](../docs/admin-app.zh-CN.md) 的 Agent/API 档案与 Secret Store 一节。PCS 的 Profile 只保存
`secret://...` 引用；本进程按**实例身份**把引用换成短期凭据，值只在内存里交给 API Adapter。

**不是 Vault/KMS**：文件后端用于本地与验收环境。生产替换时保持同样的契约：
按实例身份解析、只存引用、可吊销、审计不记录值。

## 安全属性

- **实例级隔离**：解析请求必须带 PCS 签发的 ES256 实例 JWT；`sub` 决定能读哪些引用。
  Worker A 拿自己的令牌也读不到 Worker B 的 `secret_ref`（`SECRET_NOT_ALLOWED`）。
  例外是 policy 的 `"*"`：平台级密钥（控制台为 API Profile 写入的服务商密钥）对所有实例开放。
- **短期凭据**：每次解析返回新的过期时间（默认 300s，上限 1h）。
- **轮换**：每次解析都重读 secrets 文件，替换后下一次调用立即生效。
- **吊销**：`/v1/secrets/revoke` 后该实例立即 `INSTANCE_REVOKED`。
- **文件权限**：secrets 与 policy 文件必须 0600 或更严格，否则拒绝启动。
- **审计**：记录动作、实例、引用、判定与错误码；**永不记录凭据值**。
- 只监听回环，不暴露到 WAN；不持有 JWT 私钥（只有 PCS 公钥）。

## 运行

```bash
npm install
SECRET_STORE_SECRETS_FILE=/secure/secrets.json \
SECRET_STORE_POLICY_FILE=/secure/policy.json \
SECRET_STORE_AUDIT_FILE=/secure/audit.jsonl \
SECRET_STORE_ADMIN_TOKEN=... \
PCS_PUBLIC_KEY_FILE=../pcs-issuer/keys/public.pem \
npm start
```

数据文件格式（两者都必须 0600）：

```json
// secrets.json：引用 -> 值
{ "secret://apis/mock": "<credential>" }

// policy.json：instance_id -> 允许的引用
// "*" 是平台级密钥：所有已入网实例都可读取（控制台写入的 API 服务商密钥）
{ "worker-a": ["secret://apis/mock"], "worker-b": ["secret://apis/worker-b-only"] }
```

### 写入（管理面）

```bash
curl -X PUT http://127.0.0.1:7902/v1/secrets \
  -H "authorization: Bearer $SECRET_STORE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"secret_ref":"secret://apis/deepseek","value":"sk-..."}'
```

需要管理员令牌；原子写入 `secrets.json`（0600），并把引用加进 policy 的 `"*"`，
实例继续用自己的 JWT 解析。审计只记动作与引用，永不记录值。
管理应用填 API Key 时由 PCS 代调这个接口，值不进 PCS。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SECRET_STORE_HOST` | `127.0.0.1` | 只监听回环 |
| `SECRET_STORE_PORT` | `7902` | |
| `SECRET_STORE_SECRETS_FILE` | 必填 | 引用到值的映射，0600 |
| `SECRET_STORE_POLICY_FILE` | 必填 | 实例到引用的授权，0600 |
| `SECRET_STORE_AUDIT_FILE` | 未设置 | JSONL 审计，0600 |
| `SECRET_STORE_TTL_SECONDS` | `300` | 凭据有效期，1–3600 |
| `SECRET_STORE_AUDIENCE` | `scheduler` | 实例 JWT 的受众（与调度机一致） |
| `SECRET_STORE_ADMIN_TOKEN` | 未设置 | 写入与吊销接口的 Bearer；未设置则两个接口一律 401 |
| `PCS_PUBLIC_KEY_FILE` | `../pcs-issuer/keys/public.pem` | 验签公钥 |
| `SECRET_STORE_TLS_CERT_FILE` | 未设置 | 服务端证书；与 `SECRET_STORE_TLS_KEY_FILE` 必须同时配置 |
| `SECRET_STORE_TLS_KEY_FILE` | 未设置 | 服务端私钥 |
| `SECRET_STORE_TLS_CA_FILE` | 未设置 | 客户端证书校验 CA；启用 mTLS 时必填 |
| `SECRET_STORE_MTLS` | 未设置 | 设 `1` 要求客户端证书 |

TLS / mTLS 与 PCS、调度机使用同一套内部 CA：

```bash
../scripts/pki.sh /secure/pki
SECRET_STORE_TLS_CERT_FILE=/secure/pki/secret-store.crt \
SECRET_STORE_TLS_KEY_FILE=/secure/pki/secret-store.key \
SECRET_STORE_TLS_CA_FILE=/secure/pki/ca.crt \
SECRET_STORE_MTLS=1 \
npm start
```

> 客户端（角色容器内的 API Adapter）目前用 `fetch`，只信任系统 CA。若 Secret Store
> 使用内部 CA，需要给该进程设置 `NODE_EXTRA_CA_CERTS=/secure/pki/ca.crt`，或把 CA
> 安装进容器的系统信任库；mTLS 客户端证书也尚未接到这条客户端路径上。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 无 | 存活与 TTL |
| POST | `/v1/secrets/resolve` | 实例 JWT | body `{secret_ref}` → `{credential, expires_at}` |
| POST | `/v1/secrets/revoke` | admin token | body `{instance_id}`，立即吊销该实例 |

不要给 Agent 或 Adapter 子进程注入实例 JWT 或本服务地址：只有 `role-agent` 的
API Adapter 客户端持有它们。

## 测试

```bash
npm test        # 5 个用例
```

覆盖：按实例策略解析、跨实例拒绝、吊销即时生效、轮换后重读、文件权限过宽拒绝、
JWT 签名/受众/`sub` 校验。
