# 竞技场(Arena)设计与实现全览

> 版本: v1.0(2026-10-23) | 范围: 从设计定案到生产部署的完整实现总结
> 前置文档: `arena-mode-design.md`(v0.9 设计定稿,本文档为实现态全览)
> 项目背景: **为以太坊 2026 黑客松打造的核心功能**——让 AI Agent 在不可篡改的链上规则下进行自主 DeFi 竞技

---

## 1. 一句话定义

owner 出资(本金 + 燃料)→ agent 获得专属链上托管账户 → 在赛季内**完全自主**地跑策略(固收/现货/永续)→ 燃料按 token 计费即"生命值"→ 到期链上结算净值排名(荣誉榜)。

核心命题:**当 AI Agent 拥有真金白银并完全自主决策时,谁更聪明?**

## 2. 关键设计决策(含决策过程)

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| 1 | 参赛链 | Avalanche C-Chain 主网,Fuji 测试 | 既有 DeFi 技能全在 AVAX 生态 |
| 2 | 报名费 | owner 自费,金额可配(默认 60U 本金 + 9U 燃料) | 平台不兜底,owner 有取回权 |
| 3 | 调教边界 | 赛季中可改策略配置;owner 有紧急冻结并退赛按钮 | 自主不等于失控 |
| 4 | agent 间转账 | 禁止(链上白名单天然实现) | 防合谋刷榜 |
| 5 | 交易频率 | 不设平台硬上限,燃料经济自然约束 | 烧不起就慢下来 |
| 6 | 排行榜 | 荣誉榜(无奖金池),链上可验证 | 公信力来自链上而非后台 |
| 7 | 首期链范围 | 只 EVM | Solana 二期 |
| 8 | **报名窗口** | **赛季未结束前随时可加入**(中途加入从本金起步) | 10-23 修订:去掉"开赛截止",合约 `register` 门槛改为 `now < endTime` |
| 9 | **托管方案** | 自研 per-agent 智能账户(白名单出口),二期 MPC(Turnkey 路线)签名层 | x402 是支付协议不管托管;每笔 2-of-2 MPC 与高频自主矛盾 |
| 10 | **燃料耗尽** | **方案 B:决策停机而非淘汰**,仓位继续计收益 | 燃料效率本身是可竞争策略 |
| 11 | **模型** | 赛季固定模型(config.llmModel),不可换 | 公平:排行榜比策略不比模型 |
| 12 | **计价** | 输入/输出分价 × priceMarkup(默认 1.0),6 位截断 | 本质是预算配给:9U 预付已归平台,扣费决定 agent 寿命 |
| 13 | **管理员** | **链上 owner 判定**(该链 DIDIdentity 的 owner),与铸造后台同源 | 不用 .env 白名单;各链 owner 独立 |
| 14 | **部署/白名单/结算触发** | **管理员钱包签名**(服务端只组装 unsigned tx) | 测试网赛季由 MetaMask 部署,服务端密钥非合约 owner 时自动结算会 revert |
| 15 | 赛季生命周期 | 全自动:部署完成即开赛(无"人工开放"步骤),到期自动熔断→结算→归档 | 唯一人工动作 = 两次签名 |

## 3. 总体架构

```
┌ 前端 web/ ──────────────────────────────────────────────┐
│ /arena        用户页:赛季列表/报名/策略面板/净值曲线/动作记录/紧急停止/取回 │
│ /admin/arena  管理页:建模板/一键部署(签3笔)/白名单预填(签1笔)/触发结算(签N笔)│
└──────────────┬───────────────────────────────────────────┘
               │ HTTPS (JWT/SIWE,X-Chain-Key)
┌ Agent 服务 agent/(单进程多链) ───────────────────────────┐
│ 路由 index.ts        /arena/* 公开+owner, /admin/arena/* 链上owner │
│ 竞技场内核                                                                     │
│   core/arena.ts        赛季/报名/冻结/提取(tx 组装+回执事件解析+Playbook 校验)│
│   core/arenaDeploy.ts  一键部署(读编译产物+nonce 预测三连号)+白名单模板      │
│   core/arenaSettlement.ts 结算(服务端自动+owner 钱包签名两条路径)+withdrawFee│
│   core/arenaFuel.ts    燃料计费(分价×加成/原子扣费/调度门槛)                │
│   core/arenaScheduler.ts 统一调度器(两层 tick+并发闸门+优先级队列)          │
│   core/arenaNav.ts     净值计算(现金+Aave+GMX,唯一口径)                     │
│   core/arenaGuard.ts   护栏评估(日回撤/累计回撤/现金缓冲)                    │
│   core/arenaPlaybook.ts 风险预设档(保守/均衡/激进/自定义)                    │
│   policy/arenaEngine.ts 竞技场策略引擎(复用主人模式硬规则,砍软规则)          │
│   chain/arenaExec.ts   唯一执行入口(内层 calldata 包 ArenaAccount.execute)   │
│ 技能 runtime-skills/builtins/arena-strategies(6 工具,纯函数可被调度器直调) │
└──────┬───────────────────────────────────────────────────┘
       │ 平台热钱包签名(executor)
┌ 链上 contract/(Avalanche, UUPS) ─────────────────────────┐
│ ArenaSeason(单例/赛季):注册克隆账户/方法级白名单/结算登记/withdrawFee │
│ ArenaAccount(per-agent 克隆):execute 白名单出口/freeze/settle/withdraw  │
└──────────────────────────────────────────────────────────┘
```

## 4. 链上合约(资金安全的根基)

### 4.1 ArenaAccount(per-agent 托管账户,Clones 最小代理)

- **资金出口收敛**:`execute(target, value, data)` 仅 executor 可调,且目标+方法选择器必须在赛季白名单内;`transfer` 等裸转账方法级 revert——**平台自己也卷不走钱**(测试用例显式验证);
- **owner 制衡**:owner(用户钱包)不碰日常交易,但可 `freeze`(紧急停止)→ 平台结算 → `withdraw` 取回;
- **头寸归属**:Aave aToken/GMX 仓位挂账户地址下,净值归因、排行榜天然按地址;
- UUPS 可升级,升级权限在 owner(诚实默认)。

### 4.2 ArenaSeason(赛季治理合约)

- `register(agentTokenId)`:`now < endTime` 随时可报名;克隆账户、本金直注账户、燃料直付 feeRecipient;一步失败整笔回滚;
- `allowedCalls[target][selector]`:**资金出口的唯一链上裁决**,管理员按赛季配置;
- `haltTrading`(结算前熔断,幂等)、`recordResult(account, navUsd)`(结算登记,驱动账户解锁);
- `withdrawFee(token, to, amount)`:救援通道(燃料正常不滞留合约,防误转入);
- `settle(navUsd)` 只能由赛季合约调(账户侧).

### 4.3 部署形态

- 每赛季一条链上实例:实现合约共享,UUPS 代理 per-season;per-agent 账户为 Clones 克隆(120 个 agent 也不用部署 120 次);
- 部署交易由后端从 Hardhat 编译产物读 bytecode 组装,**三连号 nonce 显式写入**(预测地址=initialize 里的账户实现地址,一轮签完);
- 合约测试:`contract/test/arena.test.js` **10 用例全绿**(注册/白名单/裸转账拒绝/冻结/到期结算/中途加入/UUPS 权限/withdrawFee/金额可配)。

## 5. 后端实现要点

### 5.1 燃料计费(arenaFuel)

- 公式:`input/1e6 × 输入价 + output/1e6 × 输出价`,× `priceMarkup`,**截断**到 6 位(结算同样截断防虚高);固定模型不匹配直接拒绝;
- 原子扣费(`WHERE balance >= cost`),不透支、失败不写流水;`arena_fuel_ledger` 每笔一行可回放对账;
- 调度门槛:余额 ≥ 上次实际扣费(无历史用 firstDecisionCostUsd)→ 不足即**决策停机**(方案 B);
- **本质 = 预算配给**:9U 预付已在报名时归平台,扣费决定 agent 能自主多久;decision tick 用无状态一次性 prompt(不挂聊天历史),输入 token 有界且 agent 间可比。

### 5.2 统一调度器(arenaScheduler,设计文档 §8 落地)

- 中央调度 + 每账户 `arena_due` 到期时间(表驱动,崩溃恢复);不给每 agent 独立调度器(防惊群);
- **两层 tick**:cheap(纯代码,默认 10min,不烧燃料:行情/净值/护栏/快照/allocation 偏离)→ decision(默认 30min,燃料闸 + 10min 最小间隔地板 + 并发信号量 ≤4 + 滚动 60s/10 次 LLM 限流);
- 优先级:forceDeRisk(10) > haltNewPositions(8) > 偏离触发(5),限流只延迟常规,护栏永不降级;
- LLM 输出稳健解析(容忍代码块/自然语言),动作分发到技能纯函数;forceDeRisk 时只许降仓类动作;
- **决策留痕**:每轮 decision tick 落 `arena_trades`(hold/acted/rejected_all + 原始输出截断),赛季页可见模型行为;
- 赛季到期自动结算:`haltTrading` → 逐账户 `recordResult`(仅当服务端密钥=合约 owner 时成功;测试网用管理页签名流程)。

### 5.3 策略技能(arena-strategies,DRY 原则)

- 6 个工具(状态/存入/取出/兑换/开仓/平仓)= **导出的纯函数** + zod 包装;调度器与对话两条路径执行同一份代码;
- 内层 calldata 全部复用现有 `buildUnsigned*`(Aave/GMX/DEX 的纯 encode 函数),`chain/arenaExec.ts` 只负责"包一层 execute + 签名发送 + 回执核实";
- 工具级护栏硬卡 `maxOrderPct`/`maxLeverage`/现金缓冲,LLM 幻觉超大参数执行前必拒(调度器另有同款,双保险);
- 盈亏归因写 `arena_trades`;竞技场引擎(`policy/arenaEngine.ts`)与主人模式**共用 `checkProposalHardRules` 硬规则**,只砍软规则(限额/冷却/审批),估值失败=拒绝(无人工可转)。

### 5.4 数据模型(PGlite,7 张表)

`arena_seasons`(config JSONB 承载全部赛季旋钮:模型/定价/加成/调度间隔)、`arena_accounts`、`arena_fuel` + `arena_fuel_ledger`、`arena_trades`、`arena_snapshots`(净值曲线)、`arena_playbooks`(版本化,owner 改动全量留痕)、`arena_due`(调度队列)。

### 5.5 管理端(链上 owner 鉴权)

- `chainAdminRequired` = JWT + 该链 DIDIdentity 的 `owner()`(与铸造后台同源,无 .env 白名单);
- **一键部署**:`deploy-txs`(读编译产物+nonce 预测三连号+initialize 打包)→ 钱包连签 3 笔 → `deploy-confirm`(回执实际地址回填,预测失配报错);nonce 冲突自动重试一次;
- **白名单**:按链配置预填模板(Aave/GMX/DEX 方法级规则),review 后签 1 笔;
- **结算**:`settle-txs`(未熔断先 haltTrading + 逐账户 recordResult,净值实时计算)→ 签 N 笔 → `settle-confirm`(解析 `ResultRecorded` 事件落库,全结清自动归档)。

## 6. 前端实现要点

- `/arena`:赛季卡片(派生状态徽章)/排行榜(链上身份名关联,未结算按最近快照净值)/报名( approve+register 两笔签名,Registered 事件回写)/我的参赛(净值/燃料/停机角标/净值曲线 SVG/动作记录/紧急停止/取回)/策略面板(风险四档/分配/护栏/高级 JSON,版本化保存);
- `/admin/arena`:建模板(USDC 按链预填,默认选有 USDC 的链;开始默认今天、结束默认 +3 个月)/一键部署/白名单预填/触发结算/手动结算;
- 只列当前钱包的 agent(owner 过滤);报名不校验 agent 归属(出资自愿,USDC transferFrom 强制付款)。

## 7. 端到端流程

```
管理员:创建模板 → 一键部署(签3笔) → 白名单核对上链(签1笔) → 完成
                                  ↓ 到 start 时间自动开赛
用户:   报名(签2笔:approve+register) → 配 Playbook(可改) → 自主竞技
                                  ↓ 每 30min 决策(烧燃料)/每 10min 巡检(免费)
                                  ↓ 到期(或 owner 冻结退赛)
结算:   haltTrading → recordResult × N(钱包签名) → owner 取回剩余
```

## 8. 运维与已知事项

- 服务器必须预编译合约产物(`cd contract && npx hardhat compile`,国内用 npmmirror 源),否则一键部署报"编译产物缺失"(见 operations-guide §8.5);
- 生产 `.env` **缺 JWT_SECRET**(用代码默认值,安全隐患,待补配);
- 服务器(国内)访问部分境外 RPC/API 不稳定,链上错误现在如实上报(不再误标"LLM 网关");
- 验证脚本:`agent/scripts/verify-arena{,-fuel,-strategies,-scheduler,-settlement}.ts`(离线,AGENT_DATA_DIR 给临时目录);
- 二期方向:MPC 签名层(Turnkey)、Solana 竞技场、多策略并行增强、燃料链上摘要存证。

## 9. 文件索引

| 层 | 文件 |
|---|---|
| 合约 | `contract/src/ArenaSeason.sol` `ArenaAccount.sol` `interfaces/IArena*.sol` `test/arena.test.js` |
| 后端 | `agent/src/core/arena*.ts`(8 个) `policy/arenaEngine.ts` `chain/arenaExec.ts` `chain/admin.ts` `db/arena.ts` |
| 技能 | `agent/runtime-skills/builtins/arena-strategies/` |
| 前端 | `web/src/pages/ArenaPage.tsx` `AdminArenaPage.tsx` `lib/arenaApi.ts` |
| 验证 | `agent/scripts/verify-arena*.ts`(5 个) |
