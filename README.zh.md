# dsh-agent-providers

English | **中文**

把第三方 coding agent（**opencode**、Claude Code、Codex、TRAE CLI、Gemini CLI、Aiden Claude、
以及任何讲 ACP 的 agent）注册成 **DSH 的模型供应商组**；不支持的走可配置 CLI 通道。会话仍由
DSH 管理。

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

## 支持的 agent

下面每一条都是在装好的 agent 上实测的，不是照 README 抄的。

| Agent | 命令 | 会话 | 模型选择 | 凭据 |
|---|---|---|---|---|
| **OpenCode** 1.19.6 | `opencode acp` | list / fork / resume / close | 账号下的 44 个，探测得到 | 凭据**文档**（`OPENCODE_AUTH_CONTENT`） |
| **OpenCode v2** 2.3.2 | `opencode2 acp` | list / fork / resume / close | 账号下的 49 个（`deepseek/…`、`gateway/…`、`opencode-go/…`），探测得到 | 它自己的 `~/.local/share/opencode/auth.json`，不映射任何凭据 |
| **Claude Code**（`claude-agent-acp` 0.109.1） | `claude-agent-acp` | list / fork / resume / close / **delete** / title | `default` `opus` `fable` `sonnet` `haiku`；另有 `effort`、`fast`、`ultracode`、`mode` | `ANTHROPIC_API_KEY`，不需要登录调用 |
| **Codex**（`codex-acp` 2.9.0） | `codex-acp` | list / fork / resume / close / delete / title | 账号相关（实测 11 个），**登录后才有** | ACP `authenticate` 的 `api-key` |
| **TRAE CLI**（`traex`，traecli 0.216.0） | `traex acp serve` | list / fork / resume / close（**没有 delete**） | 账号相关（实测 12 个）+ `mode`、`collaboration_mode`、`reasoning_effort` 选项 | 它自己的 `~/.trae` 登录，或 `TRAECLI_PERSONAL_ACCESS_TOKEN` |
| **Aiden Claude**（`aiden x claude`，Aiden 2.0.6 / Claude Code 2.1.328） | `aiden x claude` | 只有 resume（走 Claude Code 自己的 session id，**没有 list/fork/delete**） | 实时网关目录（`aiden x models --claude --json`，实测 7 个）；每个 `id` 就是 `--model` 接受的值 | Aiden 自己的 ByteCloud 登录，**不映射任何凭据** |

五个 ACP 路由都支持图片输入；`aiden-claude` 只支持文本。其它 ACP agent 把字段写全就能用。

```yaml
agents:
  opencode-go: { preset: opencode, displayName: OpenCode Go, defaultContextWindow: 1000000, catalog: probe }
  opencode-v2: { preset: opencode2, displayName: OpenCode v2 }
  claude:      { preset: claude-code, displayName: Claude Code }
  codex:       { preset: codex, displayName: Codex }
  trae:        { preset: traex, displayName: TRAE CLI }
  aiden:       { preset: aiden-claude, displayName: Aiden Claude }
```

### 两个 OpenCode 二进制，两个预设

它们不是同一个程序。`opencode`（1.x）是旧的 npm 版本，它的 ACP server 做推理解析凭据时不认
`OPENCODE_API_KEY`，而是读一个**凭据文档**——就是下面那个坑。`opencode2`（2.3.2）是 v2 二进制，
用自己 `~/.local/share/opencode/auth.json` 登录（这台机器上的 provider 有 `deepseek`、`gateway`、
`opencode-go`），所以 `preset: opencode2` **不映射**任何凭据，也因此在一台没有存
`CUSTOM_OPENCODE_API_KEY` 的机器上照样能用——而 `preset: opencode` 在那里会直接报 "needs credential"。

v2 的用量本来就是互斥口径（实测 `inputTokens` 69、`cacheReadTokens` 59344），所以**不**开
`inputTokensIncludeCache`；它也会发 `usage_update`（默认模型 `size` 1048576），窗口在运行中学到。

权限：v2 **能**问，但默认自动放行，所以不改配置就不会弹窗。在项目的 `opencode.json`（或全局配置）
里加上：

```json
{ "permission": { "edit": "ask", "bash": "ask" } }
```

这样一次写入会以 `session/request_permission` 到达，选项是 `allow_once` / `allow_always` /
`reject_once`，并且**把目标路径放在 tool title 里**；`permission: ask` 会把它变成 DSH 审批弹窗：
`OpenCode v2 请求修改文件：through-plugin.txt`。端到端实测：批准则文件写出（`end_turn`），
拒绝则整轮 `cancelled`（`APPROVAL_REJECTED`）。

`preset: codex` 里的登录请求形状是照它源码读的（`_meta["api-key"].apiKey`），凭据取
`OPENAI_API_KEY`。

`preset: traex` 展开成 `traex acp serve`——`acp` 是子命令**组**，`traex acp` 只打印帮助。
它故意不映射任何凭据：TRAE CLI 走自己的登录库（`~/.trae/traecli.toml`）。
`traex login status` 回 "Logged in using Trae"，插件直接复用——子进程保留 `HOME`，所以即使
环境里所有 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 形状的名字和 `DSH_*` 都被洗掉，这个登录库
仍然可达。它的 ACP `initialize` 提供 `trae-sso`、`trae-tob-browser`、`trae-tob-pat`；最后一种
要求进程启动**前**就设好 `TRAECLI_PERSONAL_ACCESS_TOKEN`，所以非交互场景由 profile 从已存凭据
映射：

```yaml
credentials:
  TRAECLI_PERSONAL_ACCESS_TOKEN: { ref: TRAECLI_PERSONAL_ACCESS_TOKEN }
```

插件从不写 agent 自己的凭据库；环境变量是唯一通道。

TRAE CLI 有四个会话配置项——`model`、`mode`（`default` / `plan` / `auto` /
`bypass_permissions`）、`collaboration_mode`、`reasoning_effort`（`low` / `medium` / `high` /
`max`）——在 profile 里按 id 设置：

```yaml
agents:
  trae:
    preset: traex
    configOptions: { mode: plan, reasoning_effort: high }
```

模型值是 traex 的**配置名**而不是模型 id（`Doubao-Seed-Evolving`、`deepseek-v4.1-flash`、
`DeepSeek-V4-Pro`……），而且列表是账号相关的。工具活动以 `tool_call` / `tool_call_update`
到达，和其它 agent 一样折进 reasoning 通道。

**所有 ACP 预设都自带 `permission: ask`**，所以这不是 TRAE CLI 的专属待遇：OpenCode、Claude Code、
Codex、Gemini 在动文件/跑命令前问客户端时，问题同样会走到 harness 工具调用用的那个审批弹窗。
该字段是逐路由的——`allow` 自动批准、`reject` 全拒——手写的路由仍保持默认 `allow`。

对 TRAE CLI 而言，它自己的权限请求会变成这个审批弹窗，带上它的解释：`reason` 加本地化的
`displayReason`（`TRAE CLI 请求修改文件：Editing files`）。TRAE CLI 对编辑请求只给一个泛化标题，所以弹窗里
没有文件路径可承诺。审批是一次性的（`allowed-once`），同一个操作问两次就会弹两次。"不"会选中
它唯一的非放行选项 `abort`，TRAE CLI 会**结束整轮**（`stopReason: cancelled`），而不是只失败
一个工具。失败会带上工具名和原因：`APPROVAL_REJECTED`、`APPROVAL_DISMISSED`、
`APPROVAL_UNAVAILABLE`（如 `no approval channel answered for agent.edit`），`permission: reject`
时是 `APPROVAL_DENIED`；agent 自己取消仍是 `ABORTED`。没有审批服务、没有可路由的 agent、或
问题落在已结束的回合之外时，transport 会拒绝并记日志，绝不静默放行；这种部署应显式设置
`permission: allow`（旧行为）或 `reject`。

> 如果一个 agent 要先有会话才能列模型、又要先登录才能建会话，它会呈现一个空分组——
> 没东西可选，就永远走不到那句解释登录的报错。这种路由会先挂一个占位模型
> （`default`，带 `需要登录` 标签），等真目录能读到再替换。
> 用 `fallbackModel: { id, name }` 改名，或 `fallbackModel: false` 保持空分组。

### Aiden Claude：公司内部 `aiden x claude` 启动器

`preset: aiden-claude` 是 `transport: cli` 路由，不是 ACP：它展开成公司启动器的 print 模式，
网关和登录都由 Aiden 负责：

```
aiden x claude --print --output-format stream-json --verbose --include-partial-messages \
  --permission-mode acceptEdits [--model <gateway-id>] '<prompt>'
```

这和 `preset: claude-code` 是两条不同的路由：那条走 ACP 连官方 `claude-agent-acp` 适配器、用
`ANTHROPIC_API_KEY` 认证；这条把网关路由和登录都交给 Aiden。

两件事分在两个地方发生：

- **模型列表是网关的，不是写死的表。** 预设带
  `cli.catalogCommand: ['aiden', 'x', 'models', '--claude', '--json']`。该命令在 stdout 上只吐
  纯 JSON——`{ schema_version, source, fetched_at, models: [ { cli_type, id, series, alias,
  context_length, quota, ptu, capacity, status } ] }`，实测 7 个模型——它自己的
  `- Check user login status...` 转圈提示走 stderr。每个 `id` 正是 `aiden x claude --model`
  接受的值，`context_length` 是网关的权威窗口（`ark-deepseek-v4.1-flash-1017` → 936000），
  由 `cli.catalogJson` 映射成选择器里的窗口。`cli.catalogTimeoutMs` 给这次调用设上限（默认
  20000 ms）。没有 `catalogCommand` 的 recipe 仍以声明的 `models:` 作为目录，所以其它预设不变。
- **一轮就是一个进程，凭据是 Aiden 自己的。** 不映射任何凭据：环境洗白会丢掉所有 `KEY` /
  `PASSWORD` / `SECRET` / `TOKEN` 形状的名字和全部 `DSH_*`，但 `HOME` 保留，Aiden 靠它复用
  自己的 ByteCloud 登录/token 库。没有缓存会话时非交互运行会失败，先交互式登录一次；
  无 TTY 时 `--model` 是必需的。

续聊是 Claude Code 自己的能力：第一个带 `session_id` 的事件（`system:init` 就有）成为绑定，
下一轮追加 `--resume <session_id>`。这也是这条路由唯一的会话能力——CLI 进程只活一轮，所以
没有 `list` / `fork` / `delete`；也不能在活会话里换模型：换模型等于新开会话 + 重放历史。
提示只支持文本，没有图片输入。

**权限就是这条路由的命令行开关，因为 `cli` 路由没有审批通道。** Claude Code 的 print 模式默认
拒绝受控工具——一次写入会回
`Claude requested permissions to write to <path>, but you haven't granted it yet.`——所以预设带
`--permission-mode acceptEdits`：文件编辑放行，其它受控工具仍然拒绝。这里不会弹 DSH 的审批窗，
和 ACP 预设的 `permission: ask` 不同。要放宽就显式放宽：

```yaml
agents:
  aiden:
    preset: aiden-claude
    extraArgs: ['--dangerously-skip-permissions']   # 所有受控工具都放行，不再询问
```

`args` 和 `extraArgs` 会追加到启动器自己的 argv 上，所以 Claude Code 的权限开关就该放在这里。
Aiden 会拒绝透传 `--model` / `--settings` / `--setting-sources` / `--fallback-model`（它自己的
`--model` 优先）；`--resume`、`--print`、`--output-format`、`--verbose`、
`--include-partial-messages`、`--permission-mode`、`--allowedTools`、
`--dangerously-skip-permissions` 会透传给 Claude Code。

用量本来就是互斥口径：`result` 事件里的 `usage.input_tokens`（不含缓存）和
`usage.cache_read_input_tokens`、`usage.cache_creation_input_tokens` 并列，recipe 经
`jsonl.usage` 映射成 `inputTokens` / `cacheReadTokens` / `cacheWriteTokens`，所以**不需要**
`inputTokensIncludeCache`。一个坑：`result` 里也有 `modelUsage.<id>.contextWindow`，但实测
一律是 `1e6`，应当以目录里的 `context_length` 为准。

`probe/probe-aiden.mjs [model] [prompt] [cwd]` 会打印实时目录并跑一轮短对话，花一次模型调用，
需要先登录 `aiden`。

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

### 用量坑：ACP 不保证 `inputTokens` 与缓存计数互斥

这条值得单独列，因为它会悄悄把用量算成两倍：

- ACP 没有规定 `inputTokens` 和缓存计数是什么关系。
- OpenCode 报的是**不含缓存**的输入，缓存单独给，所以 harness 的
  "`inputTokens` 不含 cache" 规则天然成立。
- TRAE CLI 把 cache read **和** write 都折进 `inputTokens`。实测一轮：
  `{ totalTokens: 49481, inputTokens: 49394, outputTokens: 87, cachedReadTokens: 24624, cachedWriteTokens: 24764 }`
  ——49394 = 24624 read + 24764 write + 6 个新 token。照字面用，harness 会把这一轮按约
  2 倍计量，再把缓存加一遍。
- `inputTokensIncludeCache: true` 就是说明这个 agent 用的是哪种读法；transport 会从
  `inputTokens` 里减掉 `cachedReadTokens` + `cachedWriteTokens`。同类一轮经预设之后报的是
  `{ inputTokens: 103, outputTokens: 2, cacheReadTokens: 22656 }`——103 + 22656 = 原始的 22759。

这是通用开关，不是厂商分支：换成把缓存折进去的 agent，加同一个字段即可。`traex` 预设
已经带上它，其它预设保持默认 `false`。

`cli` 路由同理，只是答案更简单：Claude Code 报的 `usage.input_tokens` 本来就不含缓存，缓存单列在
`usage.cache_read_input_tokens` 和 `usage.cache_creation_input_tokens`，所以 `aiden-claude`
把这两条路径映射成 `cacheReadTokens` / `cacheWriteTokens`，不开 `inputTokensIncludeCache`。

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

能力按 agent 自报走：opencode 和 TRAE CLI 都没有 `sessionCapabilities.delete`，所以它们的
删除按钮不出现，工具调用 `delete` 会明确报"cannot delete"。

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
├── presets.js             opencode / claude-code / codex / gemini / traex / aiden-claude 预设
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
test/                       153 个测试（真 ACP agent + 真 CLI + 纯函数）
```

**适配器不认识协议**：ACP、CLI 的差异全部挡在 `transport/` 后面。
详见 [docs/transport-contract.md](docs/transport-contract.md)。

---

## 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `preset` | — | `opencode` / `opencode2` / `claude-code` / `codex` / `gemini` / `traex` / `aiden-claude` / `cli-jsonl` |
| `transport` | `acp` | `acp` 或 `cli` |
| `command` / `args` | — | 启动 agent 的命令 |
| `env` | `{}` | 字面环境变量，优先级最高 |
| `credentials` | `{}` | 子进程变量名 → DSH 凭据。写 ref 字符串即为直接注入；写 `{ ref, template }` 则把密钥填进模板的 `{value}` 再注入（agent 需要 JSON 凭据文档时用） |
| `cwd` | 会话 cwd | 覆盖 agent 的工作目录 |
| `permission` | `allow`（所有 ACP 预设为 `ask`） | `allow` 自动批准 agent 的权限请求；`reject` 全拒；`ask` 把这些请求交给 harness 的审批弹窗（没有审批服务时拒绝） |
| `continuity` | `auto` | `resume` 只发增量；`replay` 每轮全量重放；`auto` 看 transport 支不支持 |
| `eventTimeoutMs` | 600000 | 单轮内两个 agent 事件之间的静默上限；审批等人类回答时暂停计时 |
| `connectTimeoutMs` | 120000 | spawn + initialize + 建会话的上限 |
| `idleReleaseMs` | 600000 | 热进程空闲多久回收 |
| `showToolActivity` | `true` | 把 agent 的工具活动写成 reasoning 里的 `→ Read src/app.ts` |
| `inputTokensIncludeCache` | `false` | agent 是否把缓存 token 折进 `inputTokens`；为 `true` 时从 `inputTokens` 里减掉 `cachedRead` + `cachedWrite`，保证 harness 的计数互斥 |
| `contextWindowMetaPath` | — | 目录条目 `_meta` 里模型窗口的点号路径，如 `trae.contextWindow` |
| `cli.catalogCommand` / `cli.catalogJson` / `cli.catalogTimeoutMs` | — / — / 20000 | `cli` recipe 的实时目录：要执行的 argv、把每个条目取出来的 JSON 路径（`entries`、`id`、`name`、`contextWindow`）、以及超时；没有它时声明的 `models:` 就是目录 |
| `catalog` | `auto` | `auto`：`models` 为空时探测，否则用声明表；`probe`：总是探测，声明表当作**元数据覆盖**；`declared`：不探测 |
| `auth` | — | `{ methodId, ref, params }`，给"不登录就拒绝 `session/new`"的 agent；`params` 里的 `{value}` 会被替换成凭据 |
| `configOptions` | `{}` | 建/载会话后应用的会话配置，恢复（resume）时重新应用，按选项 id：`{ effort: high, mode: plan }` |
| `fallbackModel` | `true` | 目录读不出来时挂的占位模型 |
| `models` | `[]` | 模型表 / 覆盖项：`{ id, name?, contextWindow?, maxTokens? }` |
| `defaultContextWindow` | `200000` | 未单独声明的模型使用的上下文窗口（见下） |
| `badgeText` | `Agent` | 模型选择器里跟在模型名后面的小标签文字 |
| `badgeTone` | `info` | 标签色调：`neutral` / `info` / `success` / `warning` |
| `defaultMaxTokens` | — | 未单独声明的模型使用的输出上限 |
| `format` / `cli` | — | `transport: cli` 的 recipe，见 docs |
| `maxReplayChars`（顶层） | 400000 | replay 时历史截断上限（从最旧丢） |

---

## 把 agent 作为子智能体使用（委派）

这是两件不同的事，只有第一件属于本插件：

- **agent 作为模型。** 本插件管的。route 就是一个 provider，所以 harness 自己的委派工具创建的子
  agent 可以**用它当模型**——`subagent-model-selection-settings.allowedModels` 把它和别的
  provider 一视同仁（`trae/deepseek-v4.1-flash`）。除了 route 本身，不需要额外配置。
- **agent 作为子智能体后端。** harness 把任务交给一个**外部进程**，用 ACP 驱动它。DSH 自带这个
  后端：`@deepseek-ai/dsh-subagent-acp`，它是注册在 `ctx.subagents` 上的具名 provider。**只改配置、
  不写代码**，上表里任何讲 ACP 的 agent 都能这么接。

### 怎么接

```bash
dsh plugin --profile <profile> add @deepseek-ai/dsh-subagent-acp@0.2.2-rc.1
```

```yaml
- insert:
    - id: subagent-acp-traex
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: traex            # 委派工具要选的名字
        command: traex
        args: ['acp', 'serve']
        permission: allow              # 或 reject（默认值），见下
    - id: tool-subagent-traex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: traex                # 必须和 providerName 一致
        toolName: traex_subagent       # 一个 provider 一个实例，名字不能重
        maxDepth: 'provider-managed'   # 必填，见第一个坑
```

两个坑，第一次接都会碰到：

1. **`maxDepth: 'provider-managed'` 是必填的。** ACP 后端不声明任何启动期能力（它管不了递归深度、
   工具过滤、persona、结构化输出），工具实例在没有这句确认时会拒绝激活：
   `provider "traex" cannot enforce maxDepth (no depthLimit capability)`。
2. **peer 依赖不会自动装。** `@deepseek-ai/dsh-subagent-acp` 的 peer 是本 harness 同版本的六个
   `@deepseek-ai/dsh-*` 包，pnpm hoisted 布局的 profile 不会替你装上，于是这行 import 失败：
   `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-subagent`（下面还有一层 `dsh-scope`）。要么显式补
   （`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-subagent`、`dsh-subprocess`、`dsh-timeout`、
   `cordis`），要么用 `--config.auto-install-peers=true` 重装。

### 子智能体运行和 provider route 的区别

| | provider route（本插件） | 子智能体后端（`dsh-subagent-acp`） |
|---|---|---|
| 上下文 | DSH 对话，续聊或回放 | **全新进程 + 全新会话**，只继承父的 cwd |
| 权限 | `ask` 会弹 harness 审批 | 只能 `allow` / `reject` 自动回答，**不会弹人工审批**，默认还是 `reject` |
| 用量 | 互斥计量；窗口从 `usage_update` 学习 | 都没有：只拿回子 agent 的最终文本 |
| 模型 | picker 里按轮选 | 子 agent 自己的默认模型 |
| 进程 | 每 route+cwd 一个热进程 | 每次运行一个新进程，不池化 |

因为权限是"被回答"而不是"被询问"，traex 作为子智能体必须写 `allow` 才能改文件/跑命令；默认的
`reject` 会把每个受控工具都拒掉。同样的两行也适用于 `opencode2`（`args: ['acp']`），它只有在自己
配置里要求时才问权限。

真机端到端验证过：父会话调用一次 `traex_subagent`，要求"只回复 SUBAGENT_OK"，TRAE CLI 作答，
父会话如实报出 `SUBAGENT_OK`。

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
- 可选服务都通过 `ctx.inject` 挂接，而不是随手读：`approval`、`agents`、`attachments`、
  `credentials`、`profileContext`、`subprocess`、`workingDirectory` 只在宿主组合真的挂了它
  时可见，否则读作不存在。cordis 的 fiber 只看得见自己 inject 过的服务，所以这一条才让凭据
  能解析、图片能加载、cwd 能跟随会话、审批能真正到达宿主；硬依赖只有 `llm`。
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

选 agent 模型和选普通模型长得一模一样，但两者差别很大：agent 跑自己的工具循环。
`permission: ask` 时它的**权限请求**会走 harness 的审批弹窗，但 agent 执行的沙箱仍是它自己的，
不是 harness 的。所以每条 agent 路由下的每个模型都带一个小标签：

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

`cli` 路由则可以从目录命令自带的窗口里读：`aiden x models --claude --json` 给每个模型一个
`context_length`（`ark-deepseek-v4.1-flash-1017` 是 936000），
`cli.catalogJson.contextWindow: 'context_length'` 把它放到模型上，所以从第一轮起就用网关
自己的数字计量。`result` 事件里的 `modelUsage.<id>.contextWindow` 不能替代它：实测一律是 `1e6`。

四级来源，优先级从高到低：

1. `models:` 里该模型自己的 `contextWindow`
2. **agent 自己在运行时报告的** `usage_update.size`（谁发就听谁的，自动纠正）
3. 目录条目在 `_meta` 里自报的窗口，按 `contextWindowMetaPath` 读取
4. 该 route 的 `defaultContextWindow`
5. 兜底的 200 000

opencode 目前**不发** `usage_update`（实测 deepseek-v4.1-flash 一轮没有任何 context 事件），
所以必须靠 1 或 4。现在 profile 里配的是：

```yaml
defaultContextWindow: 1000000
catalog: probe            # 探测目录 + 用 models: 做覆盖，不用手抄 33 条
```

TRAE CLI 则**会发**：四个模型实测运行时 `size` 都是原始窗口的 95%——`gpt-6.1-sol` 475,000 →
451,250、`gpt-5.6-sol` 272,000 → 258,400、`DeepSeek-V4-Pro` 216,000 → 205,200、
`Doubao-Seed-Evolving` 1,000,000 → 950,000。它的 `_meta` 同时给 `rawContextWindow` 和
`autoCompactBufferTokens`（40,960，再减一次得到它自己的 `autoCompactTokenLimit`，不是 raw 与
`size` 的差）。静态目录值也可能过时：`deepseek-v4.1-flash` 目录里写
`_meta.trae.contextWindow: 200000`，而同一模型的运行时 `usage_update` /
`_meta["_trae/contextUsage"]` 报 `rawContextWindow: 1000000`、`effectiveContextWindow: 950000`、
`autoCompactTokenLimit: 909040`，harness 采用运行时的 950000。这正是「运行时压过目录」的理由。
目录仍然值得先读：`contextWindowMetaPath: 'trae.contextWindow'` 让 `resolveModel` 读取每个模型
自报的窗口，而且它在还没有窗口时会自己去补目录——所以即使是无头运行、从没列过模型，也会从一
开始就把 `gpt-6.1-sol` 按 475,000、`Doubao-Seed-Code` 按 116,000 计量（以前每个模型都是
200,000）。`traex` 不需要用 `models:` 钉；想钉仍然可以钉。agent 自己的账本也跟着走：
`session/prompt` 结果带 `_meta["_trae/tokenUsage"]`，更新流里带 `_meta["_trae/contextUsage"]`
（按 `systemPrompt`、`toolDefinitions`、`developerMessages`、`userMessages`、
`assistantMessages`、`toolResponses` 分项）。

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
工具活动折叠成 reasoning 块里的面包屑，长任务在 UI 里仍有活气。标题如果是裸 call id
（`call_00_…`）会回退成 ACP 的 kind，所以面包屑显示 `→ Editing files` 而不是 `→ call_00_…`；
冷启动提示单独占一行。

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
npm test       # 153 个测试，~11s
```

覆盖：

- **契约一致性**：同一套 `runTransportConformance` 同时跑 ACP 和 CLI
- **ACP**：能力位来自 agent 自报（含"没有 loadSession 就不点亮 RESUME"）、模型目录、
  一个进程多会话、恢复、`set_config_option` 换模型（含非法模型报错）、图片
- **CLI**：recipe 校验（错配在加载期就炸）、会话 id 发现、`--resume` 回传、
  模型在 spawn 时生效、拒绝（exit 0 但 `is_error`）被正确识别、崩溃带 stderr、纯文本模式
- **CLI 目录命令**：条目映射、按 id 去重、JSON 前后有杂字仍能解析、失败时报命令名与 stderr、
  超时被杀、中断杀子进程；缓存 token 映射成互斥用量；目录窗口在打开选择器之前就进入计量；
  `aiden-claude` 预设的实测调用形状
- **适配器**：chunk 配对、**无 `tool-call-delta`**、reasoning 含思考/工具/计划、
  usage 去重缓存计数、只发增量、漂移降级、无 RESUME 时不写绑定、并发串行化、缺凭据报名字
- **会话管理**：清单带出绑定关系、fork 后下一轮真的续在分支上、close 掉绑定、
  delete 从 agent store 消失、后端不支持 fork 时明确拒绝而不是假装
- **HTTP 面**：无自定义头 → 403、跨站 Origin → 403、同上带头的 GET 动作生效、
  未知动作 → 404、缺参数 → 400、超大 body → 400
- **模型工具**：`agent_sessions` 的 list/fork/close、非 agent 路由的会话被明确拒绝、
  非法 action 由工具 schema 在进入后端前拦下
- **凭据**：模板把密钥填进文档、缺 ref 时在 spawn 之前就报出 ref 名
- **审批**：`permission: ask` 走宿主的审批通道、`allowed-once` 放行、其它结果拒绝、
  无通道 / 回合外 fail closed 并记日志；失败码带上工具名（`APPROVAL_REJECTED` /
  `APPROVAL_DISMISSED` / `APPROVAL_UNAVAILABLE` / `APPROVAL_DENIED`）
- **静默看门狗**：agent 没有事件会按 `eventTimeoutMs` 取消；等人审批期间暂停计时，
  不会把人的思考时间算成 agent 沉默
- **目录窗口**：`contextWindowMetaPath` 从目录 `_meta` 读窗口；优先级是声明 >
  运行时 `usage_update` > 目录 > route 默认 > 200k
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

`probe/probe-dsh-headless.mjs` 再往上走一层：它把 `traex` 预设放进一个真实的 DSH headless
profile 里跑——临时 `DSH_HOME`、软链 + patch，从不碰 `~/.dsh` 或 `~/.trae`——打印带时间戳的
`--json` 事件，并断言 agent 真的写出了文件。`--model` 换模型；`--no-approver` 复现 fail-closed。

### 真机实测记录

| 场景 | 结果 |
|---|---|
| 真实推理（严格条件：无环境变量、无 `auth.json`） | ✅ `OK` / `end_turn` / 真实 usage |
| 两轮续聊（resume + 只发增量） | ✅ 第二轮正确答 `two`，绑定未被重建 |
| `session/fork` + 重绑定 | ✅ `ses_…SwCm → ses_…EpBI`，两个会话都在 agent store 里，分支继承历史后续聊成功 |
| 套餐未开通的模型 | ✅ 报 `Model access is disabled`，目录里该模型变成 `无权限` 警告标签，健康的模型仍是 `Agent` |
| 图片（走 adapter 的附件通道） | ✅ 让模型读用户那张截图，回答 `10.1K / 200K` |
| Claude Code：握手 → 目录 → 选模型 → 推理 | ✅ 5 个模型 id、`delete` 能力，坏密钥会把 agent 自己的 HTTP 403 原样抛出 |
| Codex：ACP `authenticate` → 目录 | ✅ 登录**之后**才出现 11 个账号模型，说明 `_meta` 形状是对的 |
| TRAE CLI：握手 → 目录 → 推理 | ✅ 12 个账号模型（如 `Doubao-Seed-Evolving`、`gpt-6.1-sol`、默认 `deepseek-v4.1-flash`）；握手 0.5–1.4s，冷启动首答 4–5s（它自己的 system prompt 约 22–24k token） |
| TRAE CLI：换模型 | ✅ `set_config_option model` → `gpt-6.1-sol` 163 ms，首 token 4108 ms，总 4493 ms；→ `Doubao-Seed-Evolving` 切换 83 ms，首 token 10.5s |
| TRAE CLI：续聊 | ✅ `session/load` 168 ms，同一个 session id，`resumed=true`；第二轮正确回忆存储的 codeword，该轮 `inputTokens` 是 61（只转发了新的 user 轮，之前上下文由 agent store 提供，22912 个 cache-read token） |
| TRAE CLI：分叉 | ✅ `session/fork` 返回不同的 id，分支继承历史（正确答出 codeword，2586 ms） |
| TRAE CLI：没列模型也有目录窗口 | ✅ 一次从未调用 `listModels()` 的 headless 运行，仍从 `_meta` 解析出 `gpt-6.1-sol` 475000、`Doubao-Seed-Code` 116000（以前是 200000） |
| TRAE CLI：真实 DSH profile 里的审批 | ✅ answerer `allowed-once` → `approval/request "agent.edit" -> allowed-once`，文件写出（16 字节），回合完成，exit 0；`--no-approver` → `APPROVAL_UNAVAILABLE: no approval channel answered for agent.edit, so the agent stopped this turn`，exit 1，没有文件 |
| TRAE CLI：审批 allow | ✅ 一次编辑请求的选项是 `approved`（allow_once）+ `abort`（reject_once，"No, provide feedback"）；harness 结果 `allowed-once` 选中 `approved`，文件创建，`end_turn` |
| TRAE CLI：审批 reject | ✅ `rejected` 选中 `abort`；TRAE CLI **结束整轮**——`stopReason: cancelled`（不是只失败一个工具） |
| TRAE CLI：headless 多轮续聊 | ✅ 第二轮只转发了 330 个新 input token 并正确回忆 codeword；第三轮切到 `gpt-6.1-sol`，120 个 input token（也证明 `resume()` 会重新应用 `configOptions`） |
| TRAE CLI：图片 | ✅ 256×256 纯红 PNG 被 `gpt-6.1-sol`（4.4s）和 `deepseek-v4.1-flash`（2.2s）都读成 "Red" |
| TRAE CLI：未登录（空 `HOME`，真实登录未动） | ✅ `initialize` 仍成功并返回三个 auth method，但 `session/new` 和 `session/list` 回 `{"code":-32000,"message":"Authentication required"}`；fallback 让分组仍可选，显示 `TRAE CLI (sign-in required)` 和警告标签 |
| TRAE CLI：经预设的用量 | ✅ 原始 `inputTokens 49394` = 24624 read + 24764 write + 6 new；插件报 `{ inputTokens: 103, outputTokens: 2, cacheReadTokens: 22656 }` |
| TRAE CLI：从 `usage_update` 学窗口 | ✅ 四个模型实测运行时 `size` 是原始窗口的 95%；`deepseek-v4.1-flash` 目录写 200000，运行时报 950000（raw 1000000），不用 `models:` 钉就纠正 |
| 面板 HTTP（fork/close/delete/未知动作/跨站） | ✅ 200 / 403 / 400 / 404 都符合预期 |
| Aiden Claude：实时目录 | ✅ `aiden x models --claude --json` → 7 个网关模型，stdout 是纯 JSON、Aiden 的登录转圈提示在 stderr；`ark-deepseek-v4.1-flash-1017` 带 `context_length: 936000` |
| Aiden Claude：一轮用工具的对话 | ✅ `--print --output-format stream-json --verbose --include-partial-messages`：一次用工具的轮次里观测到的事件组成（`system:init` ×1、`system:hook_started` ×8、`system:hook_response` ×8、`system:status` ×2、`stream_event` ×39、`assistant` ×3、`user` ×1、`system:thinking_tokens` ×24、`result:success`），exit 0 |
| Aiden Claude：续聊 | ✅ `--resume <session_id>` 续上同一段对话（回忆验证过） |
| Aiden Claude：print 模式下的权限 | ✅ 默认拒绝一次受控写入（`Claude requested permissions to write to <path>, but you haven't granted it yet.`）；同一写入加 `--permission-mode acceptEdits` 后成功 |

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
| DSH 版本下限 | `engines.dsh` 是 `>=0.2.2-rc.1 <0.3.0-0`，`@deepseek-ai/dsh-*` peers 是 `^0.2.2-rc.1`。更窄的下限（旧的 `>=0.2.2-rc.3`）会让装着的 `0.2.2-rc.1` **静默禁用 provider 行**——`disabling profile plugin row "llm-agent-providers" … incompatible` → `NO_ADAPTER` |
| 真机回归 | `probe/` 里的脚本是这次的验证手段，建议加一条手动 checklist |

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

---

## 仓库结构

```
dsh-agent-providers/
├── package.json            # 包 + dsh.bundle / dsh.client 清单 + engines.dsh
├── cordis.patch.yml        # bundle 补丁：插入 llm-agent-providers 行（无配置）
├── icon.svg
├── lib/                    # 运行时代码（唯一进入 npm 包的目录之一）
├── docs/                   # 契约文档 + 调研报告
├── test/                   # 153 个测试，CI 直接跑
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
| `probe-agent.mjs <command> [args…]` | 描述任意 ACP agent：能力、会话选项、模式、会话存储 |
| `probe-agents.mjs [preset…]` | 把 Claude Code / Codex 预设端到端跑一遍 |
| `probe-traex.mjs [model] [prompt] [cwd]` | 走 `traex` 预设跑一轮真实推理：能力、带窗口的账号目录、四个配置项、互斥用量 |
| `probe-dsh-headless.mjs [--model m] [--task t] [--no-approver]` | 把 `traex` 预设放进真实 headless DSH profile（临时 `DSH_HOME`）跑一遍；带时间戳的 `--json` 事件、断言写出的文件；`--no-approver` 复现 fail-closed |
| `probe-aiden.mjs [model] [prompt] [cwd]` | 打印 Aiden 实时网关目录，再经 `aiden-claude` 预设跑一轮短对话；需要已登录的 `aiden`，花一次模型调用 |
| `probe-context.mjs` | 读线上 profile，打印解析后的窗口 / 模态 / badge |

## 风险

- agent 跑自己的工具、用**自己的沙箱**，所以 **DSH 的沙箱仍然管不着它**。但它的**权限请求**可以
  走 DSH 的审批弹窗：`permission: ask`（`traex` 预设的默认值）会这样做，`allow` 自动批准，
  `reject` 全拒。没有审批服务、没有可路由的 agent、或问题落在回合之外时，它会 fail closed
  （拒绝，绝不静默放行），所以无头部署应显式设 `allow` 或 `reject`。
- TRAE CLI 编辑请求的审批选项是 `approved`（allow once）和 `abort`（reject once，
  "No, provide feedback"）；它没有别的非放行路径，所以拒绝——或审批通道不可用——会结束整轮
  （`stopReason: cancelled`），不是只失败一个工具。它的 `mode: bypass_permissions`
  （"Full Access"）是 agent 自己的设置。`permission: allow` 时它自己的 sandbox 可能先拒绝一次
  受控写入、再升级成审批请求，所以 reasoning 通道里会出现一个失败的工具事件，随后才是批准后的
  重试——只是观感，不是插件 bug。
- 模型目录是账号相关的：同一账号实测 12 个，换账号或区域可能是另一组名字。上表是证据，不是契约。
- 首 token 延迟含一次进程冷启动（5–15s 量级），不是模型变慢。
- `cli` 路由没有审批通道：`aiden-claude` 带 `--permission-mode acceptEdits`，所以文件编辑放行、
  其它受控工具仍然拒绝。放宽（`--dangerously-skip-permissions`）或收紧都是 `args` /
  `extraArgs` 里的显式选择，DSH 的沙箱和审批弹窗都不作用于这个子进程。
- 同一个 opencode 数据目录被两个 ACP 进程同时写会有竞争；需要时用 `env: { OPENCODE_CONFIG_DIR: ... }` 隔离。
