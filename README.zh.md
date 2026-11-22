# dsh-agent-providers

English | **中文**

把第三方 coding agent（**opencode**、Claude Code、Codex、Gemini CLI、以及任何讲 ACP 的 agent）
注册成 **DSH 的模型供应商组**；不支持的走可配置 CLI 通道。会话仍由 DSH 管理。

装好之后，模型选择器里多出一组：

```
OpenCode Go            ← 这个插件注册的 provider route
  ├─ OpenCode-Go/DeepSeek V4.1 Flash
  ├─ OpenCode-Go/GLM 5.3
  └─ …（118 个，其中 33 个在 Go 套餐里）
DeepSeek 账号          ← 原有
opencode               ← 原有
```

Composer 下方还有一条 **Agent 会话** 栏（默认收起，点"管理"展开）：列出该 agent 存下来的
会话，标注哪一条绑在当前对话上，可以关闭/删除，见 [会话管理](#会话管理m2)。

和现有的 `opencode` 组**完全同构**：`/model`、composer 模型席、`agent-default-model`、
`subagent-model-selection-settings.allowedModels` 全都照常认它。
**但实际干活的是 agent 自己**——它在自己的进程里跑自己的工具循环。

---

## 安装与卸载

### 安装（作为 bundle）

插件页 → **Plugins → 添加**，或在命令行：

```bash
dsh plugin add dsh-agent-providers
```

装完它会在 profile 的 `dsh.profile.bundles` 里出现一行，并注册一个空的
`llm-agent-providers` 行——**此时还没有任何 provider**，因为 agent 配置属于你的部署。
在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: llm-agent-providers
  name: dsh-agent-providers
  config:
    agents:
      opencode-go:
        preset: opencode
        displayName: OpenCode Go
        defaultContextWindow: 1000000
        catalog: probe
```

保存即生效（HMR 重组合，不需要重启）。**打开插件页/模型菜单才第一次 spawn agent**，
安装本身不启动任何进程。

### 卸载

插件页 → **Remove**，或 `dsh plugin remove dsh-agent-providers`。

卸载**不会**替你清理这些，因为它们可能还有用：

| 残留 | 位置 | 处理 |
|---|---|---|
| 会话绑定表 + 启动诊断 | `$DSH_HOME/profiles/<profile>/agent-providers/` | 可直接删；不删也没影响 |
| agent 自己存的会话 | opencode 的 `~/.local/share/opencode`、Claude 的 `~/.claude` 等 | 属于 agent 自己，插件从不写 |
| 你 profile 补丁里的 `llm-agent-providers` 行 | `cordis.patch.yml` | 插件页删除时会一并移除；手改的记得删 |

### 开发时安装

```bash
git clone <repo> && cd dsh-agent-providers
npm install                 # 或 npm run link 用本机已装的 DSH 包
ln -s "$PWD" "$DSH_HOME/profiles/$DSH_PROFILE/node_modules/dsh-agent-providers"
# 然后在 profile 补丁里加同一个 llm-agent-providers 行
```

用软链而不是 `file:` 安装，这样改代码后重新组合 profile 就会生效，不必反复安装。

## MVP：opencode，复用已有的 Go 订阅凭据

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: llm-agent-providers
  name: dsh-agent-providers
  config:
    agents:
      opencode-go:
        preset: opencode
        displayName: OpenCode Go
        # 这一行就是全部"认证配置"：把 DSH 里已经存好的
        # custom-opencode 那把 key 交给子进程的 OPENCODE_API_KEY
        credentials: { OPENCODE_API_KEY: CUSTOM_OPENCODE_API_KEY }
```

`preset: opencode` 展开成 `transport: acp`、`command: opencode`、`args: ['acp']`，
以及同一条凭据映射。三条前提：

1. 机器上装了 `opencode`（`npm i -g opencode-ai`，或 `command: npx, args: ['-y','opencode-ai','acp']`）
2. DSH 里已经配好 `custom-opencode` 那个 provider（你现在就有）
3. `opencode acp` 能跑（1.19.6 实测可用）

### 为什么密钥能直接复用（实测）

`custom-opencode` provider 用的是 `apiKeyEnv: CUSTOM_OPENCODE_API_KEY`，
值存在 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下。把同一把 key 交给 `opencode acp`
子进程后，它的模型目录从 **12 个变成 44 个**（其中 33 个 Go 套餐模型）：

```
无凭据：  opencode/beam-free, opencode/big-pickle, … (12 个免费模型)
有凭据：  opencode-go/deepseek-v4.1-flash, opencode-go/glm-5.3, opencode-go/qwen3.8-max,
          opencode-go/kimi-k3, opencode-go/minimax-m3, opencode-go/grok-4.7, … (44 个)
```

`opencode-go/*` 那一组和你 profile 里 `custom-opencode.models` 列的**是同一批模型**。
所以认证不用二次登录、不用复制粘贴、也不用写进 profile 文件。

（注意：仅设 `OPENCODE_API_KEY` 能让目录变长，却不足以让推理通过——见下面的
[关键坑](#关键坑opencode-的-acp-不认-opencode_api_key)。预设用的是凭据文档模板。）

### 实测记录（这台机器上真跑过）

| 项目 | 结果 |
|---|---|
| `opencode acp` 握手 | ✅ 1.4–2.8s |
| `initialize` 能力位 | ✅ `loadSession` + `list`/`fork`/`resume`/`close` + `image` |
| 凭据复用（DSH 存的 key → 子进程） | ✅ 模型目录 **44** 个，其中 **33** 个在 Go 套餐里 |
| **真实推理** | ✅ `OK`，`stop_reason: end_turn`，usage `input 4214 / output 3 / cacheRead 1792`，首 token +5.5s |
| 会话列表 / 关闭 | ✅ 25 条真实会话，关闭返回 `{"closed":true}` |
| 模型选择（`session/set_config_option`） | ✅ 切到 `opencode-go/deepseek-v4.1-flash` 成功 |

### 关键坑：opencode 的 ACP 不认 `OPENCODE_API_KEY`

这是花最久才定位的一条，记在这里免得再踩：

- `OPENCODE_API_KEY` 只影响**模型目录**——设了它，opencode 会列出 `opencode-go/*`；
- 但**推理**走的是它自己的凭据文档（`~/.local/share/opencode/auth.json`），
  环境变量那条路在 ACP 模式下不生效，于是每次 prompt 都回 `Invalid credential`；
- 而 `opencode run`（不走 ACP）是好的，所以"直接跑没问题"。

正确做法是**把 key 包成凭据文档注入**，既不用改用户的 `auth.json`，也不用落盘：

```yaml
credentials:
  OPENCODE_AUTH_CONTENT:
    ref: CUSTOM_OPENCODE_API_KEY
    template: '{"opencode-go":{"type":"api","key":"{value}"}}'
```

`opencode` 预设已经内置了这一条，所以 profile 里只需要 `preset: opencode`。
`OPENCODE_AUTH_CONTENT` 是 opencode 自己的环境变量；模板里 `{value}` 由 DSH 凭据解析后的
密钥替换——插件里没有任何厂商专用分支，换 agent 只是换模板。

### 顺带拿到的能力（opencode 1.19.6 的 `initialize` 实测）

```json
{ "agentCapabilities": {
    "loadSession": true,
    "sessionCapabilities": { "list": {}, "fork": {}, "resume": {}, "close": {} },
    "promptCapabilities": { "image": true, "embeddedContext": true } } }
```

→ 会话恢复、会话列表、分叉、关闭、图片输入全都原生支持；
`session/new` 返回的 `configOptions` 里有 `category: "model"` 和 `category: "mode"`
两个选择器，所以**会话内换模型**也是原生的。

---

## 会话管理（M2）

要求④「在 DSH 里管理它们的会话」由三层提供，全部走同一个 `SessionAdmin`：

| 面 | 位置 | 能做什么 |
|---|---|---|
| **侧栏** | composer 下方的 *Agent 会话* 栏 | 列出每个 route 的会话、**高亮当前对话绑定的那条**、分叉当前对话、关闭 / 删除 |
| **HTTP** | `GET /agent-providers`、`GET /agent-providers/api/{close,delete,fork}` | 面板的数据源 |
| **模型工具** | `agent_sessions({action: 'list'\|'fork'\|'close'})` | agent 自己整理或分叉自己的会话 |

`fork` 不是只造一个孤立副本：它把**当前对话的绑定**指向分支，所以下一轮直接续在分支上
（`fork` + `rebind` 一起做）。`close` 只释放 agent 侧资源，历史留着；`delete` 才真删。

面板通过 slot 的 `inject: (sessionId) => ({ sessionId })` 拿到当前会话 id，所以它知道
"屏幕上这条对话用的是哪一条 agent 会话"：那一行有底色、带 `当前会话` 标签，
并且该 route 支持 `fork` 时会多出一个 `分叉当前对话` 按钮。

能力按 agent 自报走：opencode 没有 `sessionCapabilities.delete`，所以它的删除按钮不出现，
工具调用 `delete` 会明确报"cannot delete"。

两条实现约束值得记下来：

- **宿主只把 GET/HEAD 派发给插件路由**。POST 会在插件代码之前被 `405 allow: GET, HEAD`
  拦掉，所以动作走 `GET /agent-providers/api/close?route=…&sessionId=…`，靠
  `x-dsh-agent-providers: 1` 这个自定义头挡住跨站请求（跨站带不上自定义头，也过不了预检）。
- **prefix 路由的 path 不能带尾斜杠**，且它同时匹配 `p` 和 `p/<任意>`，所以动作必须挂在
  独立子路径 `/agent-providers/api` 下，否则会和清单路由 `p` 撞。

## 代码结构

```
lib/
├── index.js               插件入口：路由注册、设置命名空间、热重载、生命周期
├── config.js              Config schema（agents 字典 = provider 组）
├── presets.js             opencode / claude-code / codex / gemini 预设
├── adapter.js             LlmAdapter：会话绑定、resume/replay、chunk 组装、串行化
├── sessions.js            SessionAdmin：清单 / 分叉并重绑 / 关闭 / 删除
├── http.js                面板的 HTTP 面：清单 + 动作（含跨站防护）
├── tools.js               模型工具 agent_sessions
├── client.js              侧栏 *Agent 会话* 栏（浏览器半边）
├── diagnostics.js         冷启动失败的一行诊断记录
├── render.js              历史渲染、增量提取、漂移摘要（纯函数）
├── registry.js            DSH 会话 ↔ 外部会话 的持久绑定
└── transport/
    ├── contract.js        契约：能力位 + 归一化事件 + 断言
    ├── acp.js             ACP 实现（官方 SDK，一个进程服务多个会话）
    ├── cli.js             配置驱动的一次性 CLI 实现（给没有 ACP 的 agent）
    └── index.js           工厂 + 凭据注入
docs/transport-contract.md  ★ 再接入一个 agent 要写多少代码
test/                       87 个测试（真 ACP agent + 真 CLI + 纯函数）
```

**适配器不认识协议**：ACP、CLI 的差异全部挡在 `transport/` 后面。
详见 [docs/transport-contract.md](docs/transport-contract.md)。

---

## 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `preset` | — | `opencode` / `claude-code` / `codex` / `gemini` / `cli-jsonl` |
| `transport` | `acp` | `acp` 或 `cli` |
| `command` / `args` | — | 启动 agent 的命令 |
| `env` | `{}` | 字面环境变量，优先级最高 |
| `credentials` | `{}` | 子进程变量名 → DSH 凭据。写 ref 字符串即为直接注入；写 `{ ref, template }` 则把密钥填进模板的 `{value}` 再注入（agent 需要 JSON 凭据文档时用） |
| `cwd` | 会话 cwd | 覆盖 agent 的工作目录 |
| `permission` | `allow` | `allow` 自动批准 agent 的权限请求；`reject` 全拒 |
| `continuity` | `auto` | `resume` 只发增量；`replay` 每轮全量重放；`auto` 看 transport 支不支持 |
| `eventTimeoutMs` | 600000 | 单轮内两个事件之间的空闲上限 |
| `connectTimeoutMs` | 120000 | spawn + initialize + 建会话的上限 |
| `idleReleaseMs` | 600000 | 热进程空闲多久回收 |
| `showToolActivity` | `true` | 把 agent 的工具活动写成 reasoning 里的 `→ Read src/app.ts` |
| `catalog` | `auto` | `auto`：`models` 为空时探测，否则用声明表；`probe`：总是探测，声明表当作**元数据覆盖**；`declared`：不探测 |
| `models` | `[]` | 模型表 / 覆盖项：`{ id, name?, contextWindow?, maxTokens? }` |
| `defaultContextWindow` | `200000` | 未单独声明的模型使用的上下文窗口（见下） |
| `badgeText` | `Agent` | 模型选择器里跟在模型名后面的小标签文字 |
| `badgeTone` | `info` | 标签色调：`neutral` / `info` / `success` / `warning` |
| `defaultMaxTokens` | — | 未单独声明的模型使用的输出上限 |
| `format` / `cli` | — | `transport: cli` 的 recipe，见 docs |
| `maxReplayChars`（顶层） | 400000 | replay 时历史截断上限（从最旧丢） |

---

## 隔离边界

公开使用前值得说清楚插件**碰**什么、**不碰**什么。

### 子进程

- 子进程的环境变量**不是**从宿主继承的：先按宿主 subprocess seam 的规则洗白
  （丢掉所有 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 形状的名字和全部 `DSH_*`），
  再合并你 profile 里显式映射的凭据。所以 agent 看不到 `DEEPSEEK_API_KEY`，
  也看不到 `DSH_HOME`、`DSH_SESSION_ID` 这类宿主身份。
- 工作目录是这条对话自己的 cwd；插件不 `cd` 到别处。
- 插件**不写** agent 自己的配置或凭据库（opencode 的 `auth.json`、Claude 的 `~/.claude`）。
  凭据只经环境变量传进去。
- 子进程在插件卸载时被 SIGTERM→SIGKILL 收掉；空闲 `idleReleaseMs` 后自动回收。

### 宿主

- 只注册三样东西，都有前缀/命名空间：LLM provider route、`/agent-providers` 路由、
  一个模型工具。provider route 撞名会在注册时抛错并保留原路由，不会静默覆盖别人。
- 设置段用 `settings.configure({ auto: false })`，与 `dsh-llm-pi-ai` 一致。
- 状态只写 `$DSH_HOME/profiles/<profile>/agent-providers/`（目录 0700、文件 0600），
  绑定表有上限（默认 1000 条，按最近使用淘汰）。
- `agent_sessions` 工具是**全局**的（每个 agent 都看得见），可以用
  `exposeTool: false` 关掉，或用 `toolName` 改名避免撞名。

### 网络

- `/agent-providers` 两个路由**只回答本机连接**（`127.0.0.0/8`、`::1`），
  非 loopback 一律 403。
- 写操作额外要求 `x-dsh-agent-providers: 1` 自定义头 + 同源 Origin，
  跨站页面带不上也过不了预检。
- 已知事实：这些插件路由**不在**保护应用外壳的那层认证后面
  （`GET /` 返回 401，`GET /agent-providers` 返回 200）。所以别把 DSH 直接暴露到
  公网；要远程用，请在前面加自己的认证层。

## 选择器里怎么区分（badge）

选 agent 模型和选普通模型长得一模一样，但两者差别很大：agent 跑自己的工具循环，
DSH 的审批/沙箱管不到它。所以每条 agent 路由下的每个模型都带一个小标签：

```
DeepSeek V4.1 Flash          ← 普通模型
DeepSeek V4.1 Flash  Agent   ← agent 提供的（badge）
```

这是 `model-provider` 的 `LlmModelInfo.badge`，选择器（`/model` 弹窗和 composer 模型席）
本来就会画成 Tag，**不需要任何客户端代码**。想换颜色/文字：

```yaml
badgeText: 外部
badgeTone: warning
```

`tone` 只有 `neutral` / `info` / `success` / `warning` 四档——这是选择器支持的调色板。

## 上下文窗口（必须显式声明）

ACP 在 `session/new` 里**不告诉客户端模型的上下文窗口**，模型目录也只有 id 和名字。
如果不配，插件只能回退到 200k —— 一个 1M 的模型会被按 200k 计量和压缩（这就是你看到
`10.1K / 200K` 的原因）。

三级来源，优先级从高到低：

1. `models:` 里该模型自己的 `contextWindow`
2. **agent 自己在运行时报告的** `usage_update.size`（谁发就听谁的，自动纠正）
3. 该 route 的 `defaultContextWindow`
4. 兜底的 200 000

opencode 目前**不发** `usage_update`（实测 deepseek-v4.1-flash 一轮没有任何 context 事件），
所以必须靠 1 或 3。现在 profile 里配的是：

```yaml
defaultContextWindow: 1000000
catalog: probe            # 探测目录 + 用 models: 做覆盖，不用手抄 33 条
```

`hy3` / `iceman-*` 这几个实际是 256k，用的时候在 `models:` 里单独钉住即可：

```yaml
catalog: probe
models:
  - { id: opencode-go/hy3, contextWindow: 256000, maxTokens: 131072 }
```

> 注意 `工具 9.6K` 那一项：DSH 按**组装出来的请求**估算，会把工具 schema 算进去；
> 我们的 adapter 并不把它们发给 agent（agent 有自己的工具循环），所以这一项偏保守。

## 关键设计决定

**1. 绝不吐 `tool-call-delta`。** agent 有自己的工具循环，DSH 拿到 tool call 就会去执行。
工具活动折叠成 reasoning 块里的面包屑，长任务在 UI 里仍有活气。

**2. 一个 DSH step = 一条 assistant 消息。** agent 在一次 prompt 里干完活并 `end_turn`，
DSH 的 turn 立刻收尾，不会出现"外部还在干、DSH 在等下一步"的错位。

**3. resume 是默认，replay 是逃生舱。** 只有能证明对得上才 resume：cwd 相同、
已转发的 user 轮次仍是当前请求的**前导** user 轮次、且这些轮次的摘要一致。
压缩 / 分叉 / 改 prompt 都会让摘要对不上 → 静默降级全量重放。

**4. 能力位决定降级，不靠猜。** transport 说没有 `RESUME`，适配器就不写绑定、每轮重放；
说没有 `IMAGES`，图片就降级成文字说明。不会为了"看起来支持"而假装。

**5. `session/load` 重放回来的历史主动丢弃。** DSH 会话是权威副本，再吐一遍就是重复。

**6. 辅助调用一律拒绝。** `session-title`、compaction 这类请求如果也去开一个 opencode，
只为起个标题，代价完全不成比例。`stream()` 见到 `options.purpose` 直接报错，harness 自己降级。

**7. 一个进程服务多个会话，按 (Session, route) 串行化。** ACP 按 session id 寻址，
所以同一 route+cwd 只维护一个热进程；但一个会话同时只能跑一个 turn。

---

## 验证

```bash
npm run link   # 把本机已装的 DSH 包软链进来（只为跑测试）
npm test       # 87 个测试，~3s
```

覆盖：

- **契约一致性**：同一套 `runTransportConformance` 同时跑 ACP 和 CLI
- **ACP**：能力位来自 agent 自报（含"没有 loadSession 就不点亮 RESUME"）、模型目录、
  一个进程多会话、恢复、`set_config_option` 换模型（含非法模型报错）、图片
- **CLI**：recipe 校验（错配在加载期就炸）、会话 id 发现、`--resume` 回传、
  模型在 spawn 时生效、拒绝（exit 0 但 `is_error`）被正确识别、崩溃带 stderr、纯文本模式
- **适配器**：chunk 配对、**无 `tool-call-delta`**、reasoning 含思考/工具/计划、
  usage 去重缓存计数、只发增量、漂移降级、无 RESUME 时不写绑定、并发串行化、缺凭据报名字
- **会话管理**：清单带出绑定关系、fork 后下一轮真的续在分支上、close 掉绑定、
  delete 从 agent store 消失、后端不支持 fork 时明确拒绝而不是假装
- **HTTP 面**：无自定义头 → 403、跨站 Origin → 403、同上带头的 GET 动作生效、
  未知动作 → 404、缺参数 → 400、超大 body → 400
- **模型工具**：`agent_sessions` 的 list/fork/close、非 agent 路由的会话被明确拒绝、
  非法 action 由工具 schema 在进入后端前拦下
- **凭据**：模板把密钥填进文档、缺 ref 时在 spawn 之前就报出 ref 名
- **上下文窗口**：route 默认值覆盖探测出来的模型、声明值压过默认值、
  agent 上报的 `usage_update.size` 压过默认值、`catalog: probe` 保留目录并应用覆盖
- **选择器标记**：每个 agent 模型都带 badge，可按 route 改文字/色调；
  被套餐拒绝的模型自动变成 `无权限` 警告标签，之后成功回答会清掉
- **图片**：有附件读取能力时声明 `text,image` 并把当轮图片真正发给 agent；
  没有就只声明 `text`，不骗上游
- **冷启动**：未预热的 turn 先吐一条 `Starting <agent>…`，
  并且整条 chunk 流会过一遍真实的 `BlockAssembler` 验证可装配
- **纯函数**：历史渲染、预算截断、增量提取、漂移摘要

测试里的 `test/fake-agent.mjs` 是一个**真的讲 ACP 的 agent**（手写 JSON-RPC over stdio），
`test/fake-cli.mjs` 是一个真的 CLI 子进程，所以协议层没有被 mock 掉。

### 真机实测记录

| 场景 | 结果 |
|---|---|
| 真实推理（严格条件：无环境变量、无 `auth.json`） | ✅ `OK` / `end_turn` / 真实 usage |
| 两轮续聊（resume + 只发增量） | ✅ 第二轮正确答 `two`，绑定未被重建 |
| `session/fork` + 重绑定 | ✅ `ses_…SwCm → ses_…EpBI`，两个会话都在 agent store 里，分支继承历史后续聊成功 |
| 套餐未开通的模型 | ✅ 报 `Model access is disabled`，目录里该模型变成 `无权限` 警告标签，健康的模型仍是 `Agent` |
| 图片（走 adapter 的附件通道） | ✅ 让模型读用户那张截图，回答 `10.1K / 200K` |
| 面板 HTTP（fork/close/delete/未知动作/跨站） | ✅ 200 / 403 / 400 / 404 都符合预期 |

### 端到端验证（严格条件）

```
shell 环境：无 OPENCODE_API_KEY、无 OPENCODE_AUTH_CONTENT
磁盘：      ~/.local/share/opencode/auth.json 不存在
子进程只拿到：OPENCODE_AUTH_CONTENT（90 字符，由插件模板生成）
```

结果：

```
catalog: 44 models, 33 on the Go plan
session ... (resumed=false)
model selected: opencode-go/deepseek-v4.1-flash
[+5547ms] first text delta
turn finished: stopReason=end_turn
answer: OK
usage: {"inputTokens":4214,"outputTokens":3,"cacheReadTokens":1792}
```

也就是凭据只经过插件这一条路，没有环境变量或磁盘 auth 兜底。

复现：

```bash
node probe/probe-turn.mjs opencode-go/deepseek-v4.1-flash "Reply with exactly: OK" /root preset
```

---

## 发布前待办

| 项 | 说明 |
|---|---|
| `docs/DETAIL.md` + `docs/preview.svg` | 插件市场的详情页素材，官方 bundle 都带；还没写 |
| CI 的 npm 依赖 | `devDependencies` 已经列好，`npm install && npm test` 可直接在 CI 跑；本机也可以用 `npm run link` 走已装的 DSH |
| 版本策略 | ACP SDK 钉在 `1.4.0`（与 DSH 树一致）；升 2.x 需要适配 v2 协议 |
| 真机回归 | `probe/` 里七个脚本是这次的验证手段，建议加一条手动 checklist |

## 还没做的

| 缺口 | 说明 |
|---|---|
| 工具 schema 的计量 | 面板的 `工具 9.6K` 是 DSH 按组装请求估的，agent 拿不到这些 schema。`tools.restrict` 只允许 agent 作用域，`agent/pre-step` 又不带工具集，插件层改不了 |
| 托管子进程 | 现在自己 `spawn` + 洗环境；改用宿主的 `ctx.subprocess.spawn` 还能拿到托管范围终止（现在靠 SIGTERM→SIGKILL 已经够用） |
| 并发上限 | 同一 route+cwd 共用一个 agent 进程，多个 DSH 会话可能同时发 prompt；目前没有并发上限，靠 agent 自己排队 |
| 重命名 | ACP v1 没有 `session/set_title`，等 v2 或各 agent 的私有扩展 |
| 进程池 | 现在是"每 route+cwd 一个热进程 + 空闲回收" |
| 计费口径 | ACP `usage` 是**会话累计**，接成本面板前要做差分 |
| `mode` 选择器 | opencode 的 `build`/`plan` 已有配置项，但还没暴露成 DSH 的推理档位或独立开关 |
| 图片 | ACP 侧已按 `ImageContent` 传了，DSH 侧还没把 image block 取出来 |

---

## 仓库结构

```
dsh-agent-providers/
├── package.json            # 包 + dsh.bundle / dsh.client 清单 + engines.dsh
├── cordis.patch.yml        # bundle 补丁：插入 llm-agent-providers 行（无配置）
├── icon.svg
├── lib/                    # 运行时代码（唯一进入 npm 包的目录之一）
├── docs/                   # 契约文档 + 调研报告
├── test/                   # 92 个测试，CI 直接跑
├── probe/                  # 真机验证脚本（不进包）
├── scripts/link-dsh.mjs    # 开发时软链本机 DSH 包
└── .github/workflows/ci.yml
```

## 实测脚本

`probe/` 下是这次真机验证用的脚本（不进包，只在本仓库里）：

| 脚本 | 作用 |
|---|---|
| `probe-acp.mjs <cwd>` | 分阶段计时一次 ACP 握手 |
| `probe-turn.mjs <model> <prompt> <cwd> [preset]` | 走插件自己的 preset 凭据通道跑一轮真实推理 |
| `probe-usage-cumulative.mjs` | 同一会话跑三轮，看 usage 是每轮还是累计 |
| `probe-fork.mjs` | 真实 `session/fork` + 重绑定 + 分支续聊 |
| `probe-extras.mjs` | 套餐拒绝的模型标签、图片走 adapter 通道 |
| `probe-vision.mjs <image>` | 用多模态模型读一张图（当前会话模型不支持图像时用） |
| `probe-context.mjs` | 读线上 profile，打印解析后的窗口 / 模态 / badge |

## 风险

- external agent 用自己的权限模型干活，**DSH 的 approval / sandbox 管不着它**。
  生产上要么 `permission: reject` + agent 侧 `--sandbox read-only`，要么明确只放行全权限。
- 首 token 延迟含一次进程冷启动（5–15s 量级），不是模型变慢。
- 同一个 opencode 数据目录被两个 ACP 进程同时写会有竞争；需要时用 `env: { OPENCODE_CONFIG_DIR: ... }` 隔离。
