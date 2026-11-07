# NEAR AI Cloud 调研笔记(私有可验证推理网关)

> 调研时间:2026-11 | 来源:[docs.near.ai/cloud](https://docs.near.ai/cloud/introduction)(Mintlify 站点,`https://docs.near.ai/llms.txt` 可拿全量页面索引 + OpenAPI JSON)
> 一句话结论:NEAR AI Cloud = **OpenAI 兼容网关(`https://cloud-api.near.ai/v1`)+ TEE 内推理 + 密码学校验链**;接入最小改动是 OpenAI SDK 换 base_url,差异化能力在「可验证私有推理」(attestation/响应签名/E2EE)和「质押 NEAR 用收益付推理费」。注意文档页比线上模型目录滞后,**模型/价格一律以 `GET /v1/models` 实时返回为准**。

---

## 1. 产品定位与隐私三档

模型推理跑在 TEE(可信执行环境,Intel TDX 机密 VM + NVIDIA H200 GPU TEE,每节点 8×H200,Private-ML-SDK 管理执行/attestation/签名)内:模型提供方、云厂商、NEAR 都看不到 prompt/输出,数据不用于训练。模型按隐私等级分三档:

| 档位 | 含义 | 校验能力 |
|------|------|---------|
| `Confidential TEE` | NEAR 自有 GPU,连 NEAR 都看不到数据 | 完整 attestation + 响应签名 |
| `3P Confidential TEE` | 第三方 enclave(如 Chutes) | 标注 Attested 3P;JS SDK 可验 Chutes 模型 attestation,Python SDK 只验 Gateway |
| `Incognito` | OpenAI/Anthropic/Gemini/xAI 等前沿模型,经 NEAR 网关转发 | 厂商无法关联用户身份;模型本身不在 TEE 内,**无 attestation**;可选 PII 脱敏 |

## 2. 快速接入

1. cloud.near.ai 注册 → Credits 充值 → API Keys 生成 key(`sk-` 前缀)。
2. OpenAI SDK 只改两项:`base_url="https://cloud-api.near.ai/v1"` + `api_key`。也可设环境变量 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 零代码接入。
3. Header 约定:响应带 `X-Request-Id`(仅支持调试,非 traceparent,勿放敏感信息);计费凭证用 **`inference-id`** 响应头(不是 x-request-id);`X-Org-Id`/`X-Workspace-Id` 是内部租户头,客户端不可设。

```python
client = openai.OpenAI(base_url="https://cloud-api.near.ai/v1", api_key=KEY)
resp = client.chat.completions.create(model="z-ai/glm-5.3-flash",
    messages=[{"role": "user", "content": "Hello"}])
```

错误格式 `{"error": {message, type, code?, param?}}`;常见:400 参数、401 认证、**402 余额不足**、404 模型不存在、429 限流(`rate_limit_exceeded`/`service_overloaded`,退避重试)。组织级并发默认每模型 64。金额统一 nano-USD(10⁹ = $1)。

## 3. 模型目录与定价

- **唯一可信数据源**:`GET https://cloud-api.near.ai/v1/models`(免鉴权),每条含 `pricing`(input/output/input_cache_read,USD/百万 token)、`context_length`、`max_output_length`、`supported_features`(tools/structured_outputs/reasoning/json_mode/logprobs)、模态、sampling 参数。另一个目录形态 `GET /v1/model/list`(分页 `{models, limit, offset, total}`),定价为 `DecimalPrice{amount, scale:9}` 即 nano-dollar,`metadata` 含 `verifiable`/`attestationSupported`/`providerType`(vllm=TEE / external)/`aliases`/`deprecationDate`。
- 命名规则 `组织/模型名`(`zai-org/GLM-5.1-FP8`、`Qwen/Qwen3.8-27B`、`moonshotai/kimi-k3`),**大小写不统一,必须按接口返回的 id 精确使用**。
- 目录轮换很快(文档示例的 GLM-5.1、gpt-oss-120b 已下线,目录已到 kimi-k3、glm-5.3、Qwen3.8 等;实测 64 个模型)。TEE 档代表:`z-ai/glm-5.3(-flash)`(1.05M 上下文)、`Qwen/Qwen3.6-35B-A3B-FP8`、`deepseek/deepseek-v4.1-flash`、`moonshotai/kimi-k3`;嵌入/重排 `Qwen/Qwen3-Embedding-0.6B` / `Qwen/Qwen3-Reranker-0.6B`($0.01/M);图像 `black-forest-labs/FLUX.2-klein-4B`;Incognito 档有 Claude 全系、GPT-4.1→6 + o3/o4-mini + whisper、Gemini 2.5/3.x、Grok 4.x。

## 4. Reasoning 模型开关(各模型参数名不同,用错不生效)

两阶段输出:`reasoning_content`(思考,计入 completion 计费)+ `content`(答案);流式走 `delta.reasoning_content`;token 数在 `usage.completion_tokens_details.reasoning_tokens`(顶层 `reasoning_tokens` 是废弃别名)。

| 模型 | 参数 | 默认 |
|------|------|------|
| GLM-5.3 Flash | `thinking_token_budget`(缺省 8192,null=不限);`reasoning_effort` 仅 low/high | 开 |
| GLM-5.1 / Qwen3.5-122B / Qwen3.6-35B | `chat_template_kwargs.enable_thinking` | true |
| GPT-OSS-120B | `reasoning_effort: low/medium/high`(不可关) | medium |
| Kimi K2.5/K2.6 | `chat_template_kwargs.thinking`(**不是** enable_thinking;忽略 reasoning_effort) | true |

坑:GLM-5.3 Flash 设 `enable_thinking:false` 不会变快(思考改写入 content),想快用小的 token budget。

## 5. 私有推理架构

数据流(Gateway 模式):客户端 →(TLS)→ **网关(自身在 TEE 内)** →(HTTPS)→ 模型 TEE → 推理 → attestation 报告 + 响应签名。威胁模型:云厂商(即使物理访问也看不到)、网络攻击(TLS)、模型提取(权重在 TEE 内加密)、结果篡改(TEE 内签名可检出)。密钥无需客户端管理;可选 E2EE 再加一层客户端加密(见 §8)。

## 6. 验证体系(差异化核心)

验证链顺序:**preflight(发 completion 之前)** → 取并验证网关 attestation(需要时加 `model=` 取 `model_attestations[]` 候选逐一验证)→ 可选 TLS 绑定、镜像 provenance → 发请求 → **事后**取 `/v1/signature/<chat_id>` 验响应签名。参考实现:`nearai/nearai-cloud-verifier`、`near-examples/nearai-cloud-verification-example`。

### 6.1 关键端点

- `GET /v1/attestation/report`(带 API key,**不计费**):query 可带 `model`、`provider=near|chutes`、`signing_algo`(网关报告默认 ed25519、模型报告默认 ecdsa,两处必须显式统一)、`nonce`(32 字节 hex)、`include_tls_fingerprint=true`、头 `x-no-aliasing: true`。返回 `gateway_attestation` + `model_attestations[]`(每候选含 `intel_quote`、`event_log`、`signing_address/algo`、`signing_public_key`(E2EE 用)、`nvidia_payload`(GPU 证据)、`info.tcb_info.app_compose`)。
- `GET /v1/attestation/ita-token`(**公开**、免费):Intel Trust Authority 签名的 attestation JWT,轻量场景够用。
- `GET /v1/signature/<CHAT_ID>?signing_algo=`(**默认 ecdsa**;404 可有限重试)。

### 6.2 验证清单(每个报告)

1. 用 DCAP 验证器(`dcap-qvl`,Node 用 `@phala/dcap-qvl`,可换 `INTEL_PCS_URL`)验 `intel_quote`,施加 TCB/advisory 策略,**拒绝 TD_ATTRIBUTES debug 位开启的 quote**。**已验证的 quote 是密码学真相源,HTTP 回显字段只做一致性比对**。
2. report_data(64B)绑定:后 32B = 客户端 nonce;前 32B = 签名身份——无 TLS 时 identity 右零填充(ECDSA 20B、Ed25519 占满);有 TLS 时 `SHA-256(identity || tls_cert_fingerprint 原始 32B)`。
3. `MRCONFIGID`(48B)= `0x01 || SHA-256(app_compose UTF-8 原文) || 15×0x00`(注意 `jq -j` 不要 `-r`,换行会改 hash)。
4. RTMR3 重放:只取 `imr=3` 事件,每事件 digest = `SHA-384(event_type 4字节LE ":" event ":" hex解码payload)`,从 48 零字节起逐事件 `RTMR3 = SHA-384(RTMR3 || digest)`,须等于 quote 的 RTMR3。
5. GPU 证据:`nvidia_payload` 解码后**原样** POST 到 `https://nras.attestation.nvidia.com/v3/attest/gpu`,payload 内 nonce 须等于客户端 nonce,解 JWT 要求 `x-nvidia-overall-att-result == true`。
6. Signer 永远同时比对 `signing_address` + `signing_algo`,跨算法不比。

### 6.3 响应签名(精确字节原则)

请求体构建一次原样保留;响应在解析 JSON/SSE **之前**保留原始字节(`Accept-Encoding: identity` 或 hash 解压后字节)。`request_hash = SHA-256(原始请求字节)`,`response_hash = SHA-256(原始响应字节)`。

| signature_kind | 签名 text | 必须匹配的 preflight 证据 |
|----------------|-----------|---------------------------|
| `provider_tee` | `<MODEL_ID>:<req_hash>:<resp_hash>` | 恰好一个 signer+algo 匹配的已验证模型报告 |
| `gateway` | `<req_hash>:<resp_hash>` | 已验证的 gateway_attestation |

ECDSA:EIP-191 recover 后比 20 字节 Ethereum 地址;Ed25519:`signing_address` 即 32B 公钥 hex。注意链缺口:`gateway` 签名不证明上游模型产出;`provider_tee` 签名不绑定 preflight 网关/TLS 证据。同一模型多实例共享签名密钥,匹配 signer 不证明与 completion 同实例。

### 6.4 TLS 绑定与镜像 provenance

- TLS:peer 证书与 attestation 必须来自**同一条 TLS 连接**(`SHA-256(SPKI_DER)` 比对该连接上取的 `include_tls_fingerprint=true` 报告);浏览器 Fetch 拿不到 peer 证书,**浏览器端做不了 TLS 绑定**;禁止缓存指纹给新连接用。
- Provenance:attestation 管"配置绑定到运行时",provenance 回答"镜像 digest 是否来自可信构建":对 app_compose 里每个 `@sha256:` digest 做密码学验证(subject 精确相等),施加仓库/构建身份/workflow/ref/源码 revision 策略;404 只表示未验证,不证明事故。

### 6.5 验证策略与工具

应用须自定义 policy 并 **fail-closed**(缺失/不可用/畸形/不匹配 → 未验证,绝不拿别的 signer/证书/实例的报告顶替):TCB 状态、debug 拒绝、algo 规则、GPU 证据是否必需、可接受测量值、可信镜像源、证据最大年龄、TLS/签名是否必需。浏览器可视化工具:Verification Center `https://cloud.near.ai/verify?model=<ID>`(分级:Model verified / Gateway verified / Unable to verify / Verification failed;reply receipt 经 URL fragment 传入保护隐私)。

## 7. 官方 SDK(带验证)

| 语言 | 包 | 要求 | 验证调用 |
|------|----|------|---------|
| JS | `@nearai/inference-sdk` | Node ≥ 24.22.1 | `client.verifyResponse(id)` |
| Python | `nearai-inference-sdk`(纯异步) | Python ≥ 3.12 | `await client.verify_response(id)` |
| Rust | `nearai-inference-sdk` | stable,自带 reqwest | `client.verify_response(id).await?` |
| Go | `github.com/nearai/inference-sdk/go` | Go ≥ 1.26.10 | `client.VerifyResponse(ctx, id)` |

四语言统一支持:Chat Completions / Responses / Messages(System One 决策,前三者支持流式)、Gateway attestation 预检、TLS 身份绑定、响应签名验证(响应记录默认 60 分钟过期,流式须消费完再验)、可选 E2EE(Chat)与 OHTTP(System One 不支持;OHTTP 需 Ed25519,与 ecdsa 不兼容)。API key 读环境变量 `NEARAI_API_KEY`。各 API 的验证 ID:Chat 用 completion `id`,Responses 用 `event.response.id`,Messages 用 `event.message.id`,System One 用 `decisionId`(取自 `X-Generation-Id` 头)。

## 8. 高级能力(Guides)

- **无状态 Responses API** `POST /v1/responses`:底层 = Chat Completions 代理,服务端零存储(`Cache-Control: no-store`)。多轮须每次重发完整历史;函数调用客户端执行(`status:"incomplete"` + `function_call`,回传时原样回显并附同请求内恰好一个 `function_call_output`)。以下输入 400:`store:true`、`conversation`、`previous_response_id`、`background:true`、`input_file`、内置 server 工具(web_search/file_search/code_interpreter/computer/远程 MCP)。已退役(410):`/v1/conversations`、`/v1/files`、`GET/DELETE /v1/responses/{id}` 等。`resp_*` ID 不可检索。
- **Prompt 缓存**:自动开启,TEE 内 vLLM/SGLang 前缀 KV 缓存,命中按 `input_cache_read` 折扣价计费;命中数在 `usage.prompt_tokens_details.cached_tokens`(Responses 为 `input_tokens_details.cached_tokens`)。要点:稳定内容放最前;前缀须字节级一致(JSON key 顺序、时间戳都会使后续失效);有最小前缀长度;按部署隔离会被驱逐,常打同一前缀保热;缓存不出 TEE。
- **Fusion(多模型合议)**:`/v1/chat/completions` 上加 server tool `{"type":"openrouter:fusion","parameters":{...}}`(配 `tool_choice:"required"`),`analysis_models`(必需)+ 评判 `model` 等;响应顶层可能带 `nearai_fusion`(panel/judge/aggregate_usage);计费 = 聚合 usage。可与 `web_context_search` 组合。
- **Web 搜索**:`tools: [{"type":"web_context_search"}]` 且 **必须 `stream: true`**;流中 `delta.tool_calls`(组查询)→ `delta.nearai_tool_result`(注入结果,可展示来源)→ `delta.content`。按次计费,价格见 `GET /v1/services`。Responses API 不执行内置搜索(400);`POST /mcp` 单独暴露 web_search 工具。
- **专用端点**(均 API key、在 TEE 内):`/v1/embeddings`(Qwen3-Embedding,支持数组批量)、`/v1/rerank`(Qwen3-Reranker,返回 relevance_score 0–1)、`/v1/score`(两文本相似度)、`/v1/images/generations|edits`(FLUX.2-klein,verifiable 模型仅 b64_json、不支持 quality/style)、`/v1/audio/transcriptions`(whisper-large-v3,multipart ≤25MB)、`/v1/privacy/classify|redact`(PII spans / 真实感假数据替换,**原始 PII 不回显**)。视觉用 `Qwen/Qwen3-VL-30B-A3B-Instruct` + 标准 `image_url` 内容块。
- **E2EE Chat Completions(v2 协议)**:Curve25519 签名 → X25519 ECDH → HKDF-SHA256(info=`"ed25519_encryption"`) → XChaCha20-Poly1305;线上格式 `[临时公钥32B][nonce24B][密文+tag]` hex。流程:取模型公钥(attestation 报告的 `signing_public_key`,必须经 nonce 验证)→ 客户端生成 Ed25519 密钥对 → 加密并带请求头 `X-Signing-Algo: ed25519`、`X-Client-Pub-Key`、`X-Model-Pub-Key`、`X-Encryption-Version: 2`、`x-no-aliasing: true` → 解密响应(content/reasoning_content 均为密文,流式每 chunk 独立)。支持 Chat/Completions/Embeddings/Images,**Responses 不支持**。Legacy ECDSA:SECP256K1 + AES-256-GCM,info=`"ecdsa_encryption"`。

## 9. API 参考要点

四种 token:`sk-`(API key)、JWT access token(短时效,`rt_` refresh token 经 `POST /v1/users/me/access-tokens` 换)、`rt_`(refresh,只能换 token)、`rpt-`(reporting token,org owner/admin 创建,只读用量导出,**原文仅返回一次**)。

账户层级:`User → Organization → Workspace → API key`。API key 管理在 `/v1/organizations/{org}/workspaces/{ws}/api-keys`,可设 name/过期/**spend_limit**;新建 key 最长 10 秒生效。角色 owner/admin/member,仅 owner 可提权/删组织。

推理端点差异:`POST /v1/completions` 的 `prompt` **仅单字符串**(数组/token ID 400);Chat 透传 provider 未知字段,支持 Anthropic `cache_control` 断点、Gemini `thought_signature` 回传。

用量/计费查询:

| 端点 | 认证 | 要点 |
|------|------|------|
| `GET /v1/organizations/{org}/usage/balance` | JWT | total_spent/remaining/spend_limit(nano-USD) |
| `GET .../usage` / `/usage/models` | JWT | 分页历史;按模型聚合(day/week/month = 滚动 24h/7d/30d) |
| `GET .../usage/export` / `/usage/summary` | rpt- token | ≤366 天窗口,opaque cursor 分页(limit ≤1000);行含 inference_id、token、`*_cost_nano_usd` |
| `POST /v1/billing/costs` | API key | body `{requestIds:[UUID]}`(≤10000),返回每请求 costNanoUsd;UUID 取 `inference-id` 头或 body id 的 UUIDv5(DNS namespace);未命中返回 0 + warning;有几秒延迟 |

`POST /v1/check_api_key`:校验 key+限流+余额,返回 `{valid, organization_id, workspace_id, api_key_id}`。`GET /v1/health` 公开。

## 10. Staking for Inference

质押 NEAR,用**质押收益**(非本金)支付推理额度;本金随时可赎回,取消质押即停发,无沉没成本。额度按秒连续累积,1 credit = $1 用量,未用完结转。预算 = f(质押量, NEAR 价格, 全网 APY)(NEAR 固定增发分给全体质押者,质押率低则 APY 高;验证人佣金 1–10%)。链上半径:`GET /v1/organizations/{org}/staking/farm`(farm source、`credit_nano_usd_per_reward_unit`)、`POST .../staking/farm/sync`、`GET /v1/staking/farm/config`(全局换算率)。cloud.near.ai 有 Staking Calculator 双向换算「月预算 ↔ 需质押 NEAR」。

## 11. 实验性:直连 TEE 端点

`https://{slug}.completions.near.ai/v1` 跳过网关直连模型 TEE,同一把 key;端点注册表 `GET https://completions.near.ai/endpoints`。**不推荐新集成**:一个 hostname 多实例服务,attestation 只覆盖应答实例(TLS 钉 A 连 B 会失败),签名在实例内存里(`/v1/signature` 可能 404)。迁移回 Gateway:换 base URL + 用 `GET https://cloud-api.near.ai/v1/model/list` 的模型 ID,key 不变。

## 12. M0 spike 实测记录(2026-11,生存模式立项时)

- `GET /v1/models` 免鉴权实测:64 个模型,决策模型候选价(USD/百万 token):`z-ai/glm-5.3-flash` $0.08/$0.5(1.05M 上下文,**生存模式默认决策模型**)、`Qwen/Qwen3.6-35B-A3B-FP8` $0.17/$1.1、`deepseek/deepseek-v4.1-flash` $0.3/$1.2。一次 2k 输入 + 500 输出的决策调用 ≈ **$0.00041**,1 美元 ≈ 2400 次决策。
- credits 购买无公开 API,只能仪表盘充值;staking farm(House of Stake)是唯一程序化 credits 通道,但其端点要求 org = NEAR 登录用户的默认 org —— **需要人工步骤**:NEAR 账户登录 cloud.near.ai → 创建/确认 org → 探测 `GET /v1/staking/farm/config`。spike 未完成,接入 farm 前先跑这步。
- 生存模式架构定稿(2026-11,路径 C 分阶段):M1 链上流动质押(Meta Pool stNEAR,主网 `meta-pool.near`,`deposit_and_stake` payable)+ 人工充值 credits;M4 再切 farm 自动化。设计/实现文档见 `knowledge/survival-mode-implementation.md`(实现后补充)。

## 13. 接入注意事项(坑清单)

- 文档示例模型滞后于线上目录;`/v1/models` 免鉴权,接入前实时拉取做价格/能力表。
- 模型 id 大小写不统一(`z-ai/` vs `zai-org/`、`Qwen/` vs `qwen/`),精确复制接口返回值。
- attestation 与签名请求的 `signing_algo` 默认值不同,必须显式统一。
- 浏览器环境做不了 TLS 绑定(Fetch 拿不到 peer 证书);SDK 的浏览器入口不验 Gateway TLS。
- `/v1/completions` 的 prompt 只收字符串。
- 响应签名要原始字节,别解析-重序列化。
- 验证全链 fail-closed,缺的证据就是未验证。
