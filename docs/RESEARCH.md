# 把 Claude Code / Codex 这类 Agent 接进 DSH —— 现状盘点与架构方案

> 调研基线：本机 DSH `0.2.2-rc.3`（profile `web`），事实来源为**已安装包源码** + **npm registry 实拉包** + 联网检索。
> 凡是没能实测的地方都标了「未验证」。

---

## 0. 先回答你的两个问题

**问题一：现在有没有别的插件在干这件事？**

有，而且不少。但要分清**两层**，这是整件事的关键：

| 层 | DSH 挂载点 | 语义 | 官方有没有做 |
|---|---|---|---|
| **模型层**（`ctx.llm`） | `registerAdapter(providers, adapter)` | "这个 provider 组下面有哪些模型，流式给我" | ❌ 官方没有任何 agent-as-provider |
| **子代理层**（`ctx.subagents`） | `registerProvider(provider)` | "派一个活给外部 agent，拿回结果" | ✅ 官方有 Claude Code / Codex / ACP 三个现成后端 |

官方那三个**全在子代理层，且全部是一次性的（one-shot）**，派完就散，不续聊、不进模型选择器。所以：
**你想要的"agent 像模型组一样出现在选择器里"，官方没有，只有社区在做。**

**问题二：技术路线能不能做成"新增一个 claude 供应商，下面挂它的模型"？**

能，而且 DSH 的 `LlmAdapter` 就是为"非 HTTP 后端"留的口子——现有的 `dsh-llm-deepseek`（直连 HTTP）和 `dsh-llm-pi-ai`（走 SDK）本身就是两套完全不同的内部实现，共用同一个 `stream()` 契约。再多一个"走子进程"的实现完全合规。

推荐路线：**一个插件，`agents` 字典里每个条目 = 一个 provider 组，底层统一用 ACP（Agent Client Protocol）驱动**。
理由见 §1.3 的四路线对比：只有 ACP 能同时拿到「协议级 token 流 + 会话列表/恢复/分叉 + 会话内换模型」这三样。

---

## 1. 现有实现盘点

### 1.1 官方自带（`@deepseek-ai/*`，都在子代理层）

| 包 | 干什么 | 实现方式 | 致命限制 |
|---|---|---|---|
| [`dsh-subagent-claude-code`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-claude-code) | Claude Code 一次性子代理 | 官方 Claude Agent SDK，平台锁定的原生运行时 | **One-shot**；`model`/`permissionMode`/`env` 是启动期固定值 |
| [`dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) | Codex 一次性子代理 | 官方 app-server JSON-RPC 协议 | **One-shot** |
| [`dsh-subagent-acp`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-acp) | 任意 ACP agent 一次性子代理 | `@agentclientprotocol/sdk@1.4.0`，每次新起进程 + `session/new` | **One-shot**；不做 `session/load` 恢复 |
| `dsh-subagent-dsh-sdk` | 再驱动一个 DSH | stdio JSON-RPC | 不是第三方 agent |

这三个包在本 profile 里**都没装**（plugin manager 显示 `availability: missing`），但都在官方目录里，一键可装。

官方 README 原文写得很直白（`dsh-subagent/README.md`）：

> Local spawn and fork children retain durable sessions for later messages; **ACP, DSH SDK, Codex, and Claude Code execute once.**

也就是说：**官方的设计意图就是"外部 agent = 一次性委派"，从来没打算让它们进模型选择器。**

> ⚠️ 顺带排除一个易混点：`@deepseek-ai/dsh-acp` 是 DSH 作为 ACP **服务端**被 Zed / JetBrains 调用的（方向相反）。`dsh-experimental-claude-code-mods` / `dsh-hooks-claude-code` 是把 **Claude Code 的 hooks 配置**跑在 DSH 的拦截点上（也是反方向），都不是"把 agent 接进 DSH"。`dsh-bridges` 那类包桥接的是 skills/commands/MCP **文件**，不是 agent 运行时。

### 1.2 社区（模型层 / 桥接层）

以下包我都在 `registry.npmjs.org` 上逐一核过存在性与最新版：

| 包 | 版本 | 路线 | 做法 | 对你的参考价值 |
|---|---|---|---|---|
| [`dsh-claude-code-local`](https://www.npmjs.com/package/dsh-claude-code-local) | 1.0.0 | **A** 裸 CLI | 注册一条 `claude-code` provider；`claude -p --output-format stream-json --include-partial-messages`；把整段历史渲染成文本塞 stdin；工具活动降级成 reasoning 块 | ⭐⭐⭐ **最干净的最小可行样板**（612 行，我已读完，见 §3.2） |
| [`dsh-plugin-claude`](https://www.npmjs.com/package/dsh-plugin-claude) | 0.1.0 | **B** 官方 SDK | 每个 DSH 会话一个常驻 `claude` 进程，流式输入 | ⭐⭐ 常驻进程模型 |
| [`dsh-claude-code-provider`](https://www.npmjs.com/package/dsh-claude-code-provider) | 0.0.1 | B | 同上，早期试验品 | ⭐ |
| [`dsh-subscription-agents`](https://www.npmjs.com/package/dsh-subscription-agents) | 1.5.0 | **A** 裸 CLI | **每个已登录账号 = 一个 provider 组**，模型由 CLI 自报；`native-bridge.js` 同时是 LLM adapter + subagent provider；独立 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 隔离账号；只有 Full access 才放行 | ⭐⭐⭐ **"provider 组"这件事最接近你的想法** |
| [`dsh-agent-bridge`](https://www.npmjs.com/package/dsh-agent-bridge) | 0.4.0 | A | 用 JSON recipe 描述 agent（argv / prompt 传法 / output 取值路径），零运行时依赖 | ⭐⭐ 通用化的好思路 |
| [`dsh-acp-resume`](https://www.npmjs.com/package/dsh-acp-resume) | 0.3.9 | **C** ACP | 持久会话池复用进程，空闲 10 分钟释放，下次 `session/load` 重连；但暴露成**工具** `acp_chat_*`，不是 provider | ⭐⭐⭐ **ACP + 恢复 + 面板的现成参考** |
| [`dsh-ccgui`](https://www.npmjs.com/package/dsh-ccgui) | 1.0.6 | C | 在 DSH 会话 UI 里用 Claude Code / Kimi / Codex / PI / OMP | ⭐⭐ |
| [`@zaimokuza/dsh-acp-adapter`](https://www.npmjs.com/package/@zaimokuza/dsh-acp-adapter) | 0.1.0-rc.10 | C | "Use AI agents from the DSH session UI" | ⭐ |
| [`dsh-plugin-product-subagents`](https://www.npmjs.com/package/dsh-plugin-product-subagents) | 0.4.0 | **D** 子代理 | 角色化子代理，可续聊，任意 ACP agent 免代码接入 | ⭐⭐ 权限上限设计的参考 |

**把所有包拼起来看，你会发现缺的正是你要的那一块：**
- 有 "agent 当 provider" 的 → 但都是**单家、裸 CLI、全量重放**（`dsh-claude-code-local`、`dsh-subscription-agents`）
- 有 "ACP + 会话恢复" 的 → 但暴露成**工具**，不是模型选择器（`dsh-acp-resume`、`dsh-ccgui`）
- **没有一个** = 多 agent 统一 provider 组 + ACP 原生会话 + DSH 内的会话管理面板

### 1.3 四条实现路线的核心对比

| 维度 | **A** 裸 CLI + stream-json | **B** 官方 Agent SDK | **C** ACP 客户端 | **D** 官方 subagent 后端 |
|---|---|---|---|---|
| 会话列表 | ❌ 得自己扫 `~/.claude/projects/*.jsonl` / `~/.codex/sessions/**/*.jsonl` | ✅ Claude 有 `listSessions()`；Codex 无 TS SDK | ✅ **`session/list`**（需 `sessionCapabilities.list`） | ❌ |
| 会话恢复 | 手写：`claude -r <id>` / `codex exec resume <id>` | ✅ | ✅ `session/load`（重放历史）或 `session/resume`（不重放） | ❌ 全 one-shot |
| 会话分叉 | Codex 有 `codex exec fork`；Claude 的 CLI 侧开关 **未验证** | ✅ `forkSession({upToMessageId})` | ⚠️ ACP v2 `session/fork`（**Preview 未冻结**），v1 无 | ❌ |
| 流式粒度 | 取决于 CLI：Claude 要 `--include-partial-messages` 才 token 级 | ✅ | ✅ **协议级** `agent_message_chunk` / `agent_thought_chunk` | ✅（但对父会话不可见） |
| 会话内换模型 | ❌ 基本不行（一轮一进程，每轮换 `--model` 等于重开） | ⚠️ 有相关控制，确切 API **未验证** | ✅ **`session/set_config_option`**（`category: "model"`） | ❌ 启动期固定 |
| 依赖体量 | 极小 | **大**（每平台几十 MB 原生二进制，SDK 与 CLI 版本绑定） | 中（`@agentclientprotocol/sdk` + 各家适配器） | 中大 |
| 稳定性风险 | **高**：flag 和事件 schema 随小版本漂移 | 中 | **中低**：协议受控，但适配器质量参差 | 低（官方维护） |
| 覆盖 agent 数 | 每加一家写一份 | 只有 Claude | **任意 ACP agent 一份代码通吃** | 官方已覆盖 3 家 |

**结论：选 C（ACP）。** A 作为兜底（agent 没有 ACP 适配器时）。

### 1.4 几个实测出来的坑（会直接咬人）

1. **ACP v1 没有 `session/set_model`。** 会话内换模型的正式做法是 Session Config Options：`session/new`（或 load/resume）返回 `configOptions[]`，其中 `category` 为 `mode` / `model` / `model_config` / `thought_level`；客户端调 `session/set_config_option({sessionId, configId, value})`，agent 必须回**全量** configOptions（换模型常连带改推理档位）。
2. **Claude Code 失败时常常仍 `exit 0`**，错误在 `result.is_error` / `subtype:"error"` 里。`dsh-agent-bridge` 为此专门加了 `output.errorFlag` 配置项。这是最容易写出"静默失败"的地方。
3. **`claude` 是 npm shim**（`.cmd` / `.ps1`），真正跑的是 shim 后面的原生二进制；直接 spawn 名字有时拿不到正确行为，要 `resolveExecutable`。
4. **ACP 适配器 npx 包名混乱**：`@agentclientprotocol/claude-agent-acp`（官方，0.109.1）、`@agentclientprotocol/codex-acp`（官方，2.9.0），社区还有 `claude-code-acp-ts` / `@sudocode-ai/claude-code-acp` / `claude-code-acp` 等历史包，极易装错。
5. **provider 路由 id 会撞**：官方 subagent 已占用 `claude-code` / `codex` / `acp` 这三个注册名。不过那是 `ctx.subagents` 命名空间，`ctx.llm` 是独立命名空间，**我这里用同名不冲突**（`dsh-plugin-product-subagents` 之所以改名叫 `product-subagents:*`，是因为它自己也在 subagent 层）。
6. **`@agentclientprotocol/sdk` 版本**：DSH 树里锁的是 **1.4.0**（`dsh-acp` 的依赖），npm 最新已到 2.9.1。建议**跟 DSH 对齐用 1.4.0**，省掉 zod 双份；要用 ACP v2 的 `session/fork` 再升 2.x。

---

## 2. 你的四条要求 vs 现状

| 你的要求 | 谁能满足 |
|---|---|
| ① 切换 agent 就像选模型组 | 社区 A/B 路线（`dsh-claude-code-local`、`dsh-subscription-agents`）已实现；官方无 |
| ② provider 组下面挂它支持的模型 | `dsh-subscription-agents`（CLI 自报）；其余多为静态写死 |
| ③ 实际干活是这些 agent，不是 DSH 自己 | A/B/C 都满足（DSH 的 tool 循环被短路） |
| ④ **在 DSH 里管理它们的会话** | ⚠️ **没人做全**。`dsh-acp-resume` 有会话池+面板但走工具；ACP 自带 `session/list|load|fork|delete`，没人接到 DSH 侧边栏当"会话列表"用 |

④ 就是你这个插件真正的差异点。

---

## 3. DSH 侧有哪些挂载点（都在已装源码里核过）

### 3.1 `ctx.llm` —— 唯一的正确入口

`packages/llm/llm/src/index.ts:223`：

```ts
export abstract class LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo          // 选择器的组名
  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined
  listModels(provider: string): Promise<readonly LlmModelInfo[]>   // 组下面挂的模型
  resolveModel(provider, model, signal?): Promise<LlmResolvedModelInfo>  // 上下文窗口/推理档位
  prepareCall(provider, model, signal?)                     // 元数据与 dispatch 绑同一代
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>  // ← 只需实现这个
}
```

注册（`index.ts:416`）：

```ts
const handle = ctx.llm.registerAdapter(['claude', 'codex'], adapter)
handle.replace([...])   // 原子换路由集
ctx.llm.registerConfigurableProviders([{ provider, displayName, settingsNs, settingsPath }])
```

`registerConfigurableProviders` 的作用是让这条路由出现在 **设置 → 模型** 页，可以图形化改连接参数（`dsh-claude-code-local` 就是这么做的）。

**模型选择器确认是按 provider 分组的。** `dsh-client-ui-model-selection/README.md`：

> Both entries **group models by provider** … The `/model` popup shows **provider names as group headings** and model names as rows.

所以「新增一个 claude 供应商，下面有它支持的模型」在 UI 上**零改动**就能实现，只要 `providerInfo().name` 给对、`listModels()` 返回非空。

### 3.2 `GenerateOptions` —— 我们能拿到的输入

`types.ts:564`：

```ts
interface GenerateOptions {
  provider: string; model: string
  reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]   // 完整历史，system 是 messages[0] 的 system 角色消息
  system?: string              // 一次性调用者用，loop 构建的请求里是 undefined
  tools?: ToolSchema[]         // ← 我们要**忽略**它
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>   // ← ★ 会话映射的锚点
  purpose?: string             // 'session-title' 等辅助调用
}
```

`sessionId` 由 loop 盖上，**这就是 DSH 会话 ↔ 外部 agent 会话的关联键**。

### 3.3 `StreamChunk` —— 唯一的输出面

`types.ts:496`：

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id; name?; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState? }
```

**关键约束：绝对不要发 `tool-call-delta`。** loop 会拿到 tool call 就去 `ctx.tools.execute()`，等于让 DSH 去执行 Claude Code 的内部工具，必然炸。外部 agent 的工具活动只能降级展示（见 §5.4）。

### 3.4 agent loop 的两个行为（一好一坏）

`dsh-agent-loop/README.md`：

- ✅ **「Resume and a provider or model swap alone continue the series」** —— 会话中途从 DSH 模型切到 `claude-code` provider 是**内核支持**的，历史会全量重发给我们。
- ❌ **「a multi-step tool turn resends the accumulated history each step」** —— 每一步都重发全量历史。我们的 adapter 天然只做一个 step（不吐 tool call，turn 立刻结束），所以不亏；但也意味着**每次请求我们都会拿到完整对话**，必须自己处理"发多少给 agent"。

---

## 4. 推荐架构

### 4.1 总体形状

```
DSH 模型选择器
├─ DeepSeek 账号        ← 现有
├─ DeepSeek             ← 现有
├─ opencode             ← 现有（custom-opencode，走 pi-ai，HTTP）
├─ Claude Code          ← 新插件注册的 provider route: "claude"
│    ├─ claude-opus-5
│    ├─ claude-sonnet-5
│    └─ claude-haiku-4-5
├─ Codex                ← provider route: "codex"
│    ├─ gpt-5.5-codex
│    └─ gpt-5.5
└─ Gemini CLI           ← provider route: "gemini"
     └─ ...
```

一个包 `dsh-agent-providers`，`lib/index.js` 里：

```
Config.agents: { [route: string]: AgentProfile }
                    ↓
            每个 profile 一个 AcpTransport 实例
                    ↓
     registerAdapter(Object.keys(agents), adapter)
```

`AgentProfile`：

```yaml
claude:
  displayName: Claude Code
  command: npx
  args: ["-y", "@agentclientprotocol/claude-agent-acp"]
  env: { CLAUDE_CODE_EXECUTABLE: /usr/local/bin/claude }
  permission: allow          # reject | allow
  continuity: auto           # auto | resume | replay
  idleTimeoutMs: 600000
  models: []                 # 空 = 向 agent 探测
```

### 4.2 一次请求的完整时序

```
loop 调 stream(options)
  │
  ├─ 1. 解析 route = options.provider → AgentProfile
  ├─ 2. 取 DSH session 的工作目录
  │      ctx.agents.get(options.sessionId).session.header.cwd
  ├─ 3. 取会话映射（registry: profileDir/agent-providers/sessions.json）
  │      查 [sessionId, route] → { externalSessionId, lastSentUserCount, cwdDigest }
  │
  ├─ 4. 决定同步策略
  │      continuity=replay  → 每次新 ACP 会话，全量历史渲染成一个 prompt
  │      continuity=resume  → 有映射且一致 → session/load(sessionId) 后只发增量
  │                            映射缺失/不一致 → 降级 replay 并重建映射
  │
  ├─ 5. 需要切模型？ session.setConfigOption({configId: <model 类目>, value: options.model})
  │
  ├─ 6. session/prompt，边收 session/update 边 yield chunk
  │
  ├─ 7. 记 usage（来自 PromptResponse.usage 或 result 事件）
  ├─ 8. 更新映射 + 落盘
  └─ 9. yield { type:'finish', reason:{kind:'stop'} }
```

### 4.3 会话映射与一致性（这块是全篇最容易翻车的地方）

三个状态必须对得上：

```
DSH Session (session-862b...)      ← 权威：对话内容、标题、归档
      ↕  映射表
外部 agent session (uuid)          ← 权威：agent 自己的上下文、工具状态
      ↕
ACP 子进程 (pid)                    ← 可丢：随时可以 session/load 重建
```

**映射表**（`$DSH_HOME/profiles/<profile>/agent-providers/sessions.json`）：

```json
{
  "session-862b402b": {
    "claude": {
      "externalSessionId": "01J...",
      "cwd": "/root/workspace",
      "cwdDigest": "...",
      "sentUserCount": 3,
      "sentHistoryDigest": "sha256:...",
      "lastPromptAt": 1763000000000
    }
  }
}
```

**一致性检查**（任一不成立就降级到 replay，绝不硬 resume）：

| 检查 | 不通过的含义 |
|---|---|
| `cwd` 相同 | 用户切了工作目录 → agent 的 sandbox 根变了 |
| 历史里 user 消息数 ≥ `sentUserCount` | 会话被压缩 / 回滚 / 分叉了 |
| 前缀 digest 相同 | 历史被 compaction 改写 |
| 上一轮以 `end_turn` 结束 | 上一轮是中断/失败，agent 侧状态未知 |

**为什么不干脆永远 replay？** 因为每次 replay 都要把全部历史塞进一个 prompt，agent 会把你写过的文件"再写一遍"（它的工具状态没了），成本和副作用都不可接受。**resume 是默认，replay 是逃生舱。**

### 4.4 模型目录从哪来（"下面有它支持的模型"）

三级来源，优先级从高到低：

1. **配置里写死的 `models:`** —— 最稳，推荐默认这么干
2. **向 agent 探测**（`models: []` 时）：spawn → `initialize` → `session/new` → 读返回的 `configOptions`，找 `category === 'model'` 的那一项，把它的 `options` 展开成模型列表；同时可从 `category === 'thought_level'` 的选项生成 `reasoning.efforts`
3. **探测失败** → `listModels` 返回 `[]`，并在 `registerConfigurableProviders` 的 `error` 字段写诊断（模型选择器会显示"XX 加载失败"并给重试按钮，不会整个挂掉）

探测要**缓存 + 超时 + 单飞**：一次探测要起一个进程，绝不可以在每次打开模型菜单时都做。

### 4.5 流式映射表

| ACP `session/update` | 我们的 chunk | 说明 |
|---|---|---|
| `agent_message_chunk` (text) | `block-start(text)` → `text-delta` → `block-end` | 正文 |
| `agent_thought_chunk` | `block-start(reasoning)` → `reasoning-delta` | 思考，UI 上默认折叠 |
| `tool_call` / `tool_call_update` | 合并进 **reasoning** 通道，压成一行 `→ Read src/a.ts` | ← **不是 tool-call 块**，见 §3.3 |
| `plan` / `plan_update` | 同上，`◻ 1/3 分析` | |
| `usage_update` / `PromptResponse.usage` | `{type:'usage', usage}` | 注意 DSH 要求计数**互斥**（input 不含 cache） |
| `config_option_update` | 更新内部状态，不吐 chunk | 换模型时 agent 会回推 |
| `session_info_update` | 更新会话标题（写 registry） | 会话管理面板用 |
| `end_turn` | `finish{kind:'stop'}` | |
| `max_tokens` | `finish{kind:'max-tokens'}` | |
| `cancelled` | `finish{kind:'aborted'}` | |
| 进程异常 / 协议错 | `LlmError`，由 runtime 归一成 `finish{kind:'error'}` | 用稳定 code：`TRANSPORT` / `TIMEOUT` / `ABORTED` |

**`refusal` / `max_turn_requests` 一律当失败**，不要当成功返回 —— 这是 `dsh-subagent-acp` 里的既有教训。

### 4.6 会话管理界面（要求④的落地）

分两步做，不要一次到位：

**M2（便宜版，无 UI 代码）** —— 加一个模型可调工具 + 一个 Remote：

```
agent_sessions({ route?, action: 'list'|'delete'|'fork'|'rename', sessionId? })
```

数据来自 ACP `session/list`（带 `cwd` 过滤 + cursor 分页），回退到扫 `~/.claude/projects/*.jsonl` 与 `~/.codex/sessions/**/*.jsonl`。

**M3（正式版）** —— 客户端插件，在右侧栏加一个面板：

```
agent-providers/client.js
  slots: sidebar.right.tab  → <AgentSessions />
  remote: agentProviders.watch(sessionId) → 流式状态的 AsyncIterable
```

直接抄 `dsh-acp-resume` 的 `lib/panel.js` + `lib/pool.js` 结构（它就是干这个的，只是暴露成工具而非 provider）。

---

## 5. 配置样例（对标你现在 `cordis.patch.yml` 里的 `providers:` 写法）

MVP（opencode，复用已有 Go 凭据）：

```yaml
- id: llm-agent-providers
  name: dsh-agent-providers
  config:
    agents:
      opencode-go:
        preset: opencode
        displayName: OpenCode Go
        credentials: { OPENCODE_API_KEY: CUSTOM_OPENCODE_API_KEY }
```

同一份配置里加第二、第三个 agent（都讲 ACP）：

```yaml
      claude:
        preset: claude-code          # → npx -y @agentclientprotocol/claude-agent-acp
        models:
          - { id: claude-opus-5,   name: Claude Opus 5,   contextWindow: 200000, maxTokens: 64000 }
          - { id: claude-sonnet-5, name: Claude Sonnet 5, contextWindow: 200000, maxTokens: 64000 }
      codex:
        preset: codex                # → npx -y @agentclientprotocol/codex-acp
        models:
          - { id: gpt-5.5-codex, name: GPT-5.5 Codex, contextWindow: 272000, maxTokens: 128000 }
```

再往下就是一个**不讲 ACP** 的 agent（将来的 trae），只写 recipe、不写代码：

```yaml
      trae:
        transport: cli
        format: jsonl
        command: trae
        args: ['run']
        models: [{ id: trae-pro, name: Trae Pro, contextWindow: 128000 }]
        cli:
          promptVia: stdin
          resumeArgs: ['--continue', '{session}']
          sessionIdPath: session_id
          modelArgs: ['--model', '{model}']
          jsonl:
            text: message.content
            error: { path: is_error, equals: 'true' }
            usage: { input: usage.input_tokens, output: usage.output_tokens }
```

配好之后：
- 模型选择器里多出 **OpenCode Go** / **Claude Code** / **Codex** / **Trae** 几个组
  （**和你现在的 opencode 组完全同构**）
- `agent-default-model.provider: opencode-go` 就能把默认模型指过去
- `subagent-model-selection-settings.allowedModels` 里也能列它们

---

## 6. 风险与取舍（诚实清单）

| # | 问题 | 影响 | 对策 |
|---|---|---|---|
| 1 | **DSH 的工具 / 审批 / 沙箱全部失效** | 外部 agent 用自己的权限模型干活，DSH 的 `approval`、`sandbox-policy`、`fs-observation-policy` 都管不着它 | 明确接受；用 `permission: reject` + agent 侧 `--sandbox read-only` / `--permission-mode plan` 收口。`dsh-subscription-agents` 的做法是**直接只允许 Full access，受限会话一律拒绝**（fails closed） |
| 2 | **上下文双份** | DSH 日志一份、agent 侧一份，token 花两遍 | resume 模式只发增量；replay 模式对老会话截断 |
| 3 | **首 token 延迟** | 冷启动 spawn + initialize + new session，5–15s 都可能 | 进程池 + 空闲保活（`dsh-acp-resume` 的 10 分钟空闲策略） |
| 4 | **辅助调用会误触** | `purpose: 'session-title'` / compaction 也会调 `stream()`，等于为了起标题去开一个 Claude Code | 在 `stream()` 里按 `purpose` 短路：非普通对话直接返回错误或纯启发式标题 |
| 5 | **模型目录探测成本** | 每次探测起一个进程 | 缓存 + 单飞 + 显式刷新 |
| 6 | **ACP 适配器质量参差** | codex-acp 自评"只过 mock，真机未验证" | 用户可切回 A 路线（裸 CLI）作为该 agent 的 `transport: cli` |
| 7 | **单写者** | 同一 DSH 会话不能被两个 step 同时驱动 | adapter 内按 `sessionId` 串行化，第二次进来直接拒绝 |
| 8 | **分叉后 DSH 不知情** | agent 侧 fork 出来的会话，DSH 没有对应 session | 面板里单独列出"外部孤儿会话"，只读 |
| 9 | **`refusal` / `max_turn_requests`** | 报成功会污染 DSH 会话 | 一律映射成 error finish |
| 10 | **图片** | ACP 支持 `ImageContent`；DSH 会把 image block 传给我们 | 转成 ACP image block；provider 不声明 image 模态时 DSH 会在发送前就拒绝 |

---

## 7. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | 单 agent 单 route、静态模型、replay、`permission: allow` | ✅ 已完成 |
| **M1** | resume + 绑定表 + 漂移检查；多 route；`registerConfigurableProviders`；`set_config_option` 换模型 | ✅ 已完成 |
| **M1.5** | **transport 抽象**（ACP + 配置驱动 CLI）、凭据注入、契约一致性测试 | ✅ 已完成 |
| **M2** | 会话管理：`session/list`/`fork`/`close`/`delete` → 侧栏面板 + HTTP 面 + 模型工具 `agent_sessions` | ✅ 已完成并真机启用 |
| **M3** | usage 计费口径（累计→单轮差分）、进程池、`mode` 选择器、侧栏的 fork 按钮 | ⏳ |

---

## 8. MVP：为什么选 opencode，以及实测拿到的结论

opencode 是这个需求最好的起点，因为它**同时满足三件事**：讲 ACP、有原生会话能力、
而且你这台机器上它的 Go 订阅凭据已经被 DSH 存好了。

### 8.1 `opencode acp` 实测握手（1.19.6）

```json
{ "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "sessionCapabilities": { "list": {}, "fork": {}, "resume": {}, "close": {} },
    "promptCapabilities": { "image": true, "embeddedContext": true } },
  "agentInfo": { "name": "OpenCode", "version": "1.19.6" } }
```

`session/new` 返回两个 `select` 型 configOptions：`id: "model"`（`category: "model"`）
和 `id: "mode"`（`category: "mode"`，`build` / `plan`）。模型值形如 `provider/model`。

→ 会话恢复、列表、分叉、关闭、图片、**会话内换模型**全部原生，不用自己造。

### 8.2 凭据复用：一行配置，实测有效

DSH 的 `custom-opencode` provider 用 `apiKeyEnv: CUSTOM_OPENCODE_API_KEY`，
值在 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下。把它作为 `OPENCODE_API_KEY`
交给子进程后，opencode 自己的模型目录变化：

| | 模型数 | 内容 |
|---|---|---|
| 不传 key | **12** | 只有 `opencode/*-free` |
| 传 Go key | **122** | `opencode-go/*` + `opencode/*` |

`opencode-go/*` 里的 `deepseek-v4.1-flash`、`glm-5.3`、`qwen3.8-max`、`kimi-k3`、
`minimax-m3`、`grok-4.7` …… **和你 profile 里 `custom-opencode.models` 列的是同一批**。
所以认证零成本：不用二次登录，不用把密钥写进 profile，插件启动时按引用解析即可。

对应的配置就三行：

```yaml
agents:
  opencode-go:
    preset: opencode
    credentials: { OPENCODE_API_KEY: CUSTOM_OPENCODE_API_KEY }
```

### 8.3 抽象：ACP 只是其中一个 transport

第一轮的骨架把 ACP 写死在适配器里。这一轮按你的要求抽开了：

```
adapter（会话绑定 / resume-replay / chunk 组装 / 串行化）  ← 不认识任何协议
        │  只认两个接口 + 七种事件
        ▼
transport/contract.js
        ├── transport/acp.js   使用官方 @agentclientprotocol/sdk
        ├── transport/cli.js   配置驱动：argv 模板 + 点号取值的 JSONL 解析
        └── transport/<你的>.js  未来
```

关键点是**能力位诚实降级**：

| 能力位 | 没有它时适配器的行为 |
|---|---|
| `RESUME` | 每轮新会话 + 全量重放，且不写会话绑定（不假装连续） |
| `LIST` | `list()` 返回 `[]`，不报错 |
| `SWITCH_MODEL` | 换模型等于换会话 |
| `IMAGES` | 图片降级成文字说明 |

于是「以后接 trae」变成三档工作量之一：**只改配置 / 写一个 recipe / 写一个 transport**，
适配器一行不动。详细清单见 `skeleton/docs/transport-contract.md`。

### 8.4 和第一轮方案的差异

| 第一轮 | 现在 |
|---|---|
| ACP 写在适配器里 | 抽象成 transport，ACP 只是其中一个实现 |
| 每个 DSH 会话一个子进程 | 每个 (route, cwd) 一个热进程，按 session id 多路复用 |
| 只有 ACP 一条路 | ACP + 配置驱动 CLI 两条路，共用一个契约测试 |
| 漂移检查对比整段历史摘要 | 只对比 **user 轮次前缀**（整段摘要永远不可能相等，是个原设计缺陷） |
| 静态模型表 | 向 agent 探测 + 缓存 + 失败缓存 |

---

## 9. 本目录里的东西

```
dsh-agent-providers/
├── RESEARCH.md                      ← 本文
└── skeleton/                        ← 可安装包（MVP：opencode 可跑通握手与会话）
    ├── README.md                    ← 安装、字段、设计决定、缺口
    ├── docs/transport-contract.md   ← ★ 再接一个 agent 要写多少代码
    ├── lib/
    │   ├── index.js                 ← 插件入口：路由 / 设置命名空间 / 热重载 / 生命周期
    │   ├── sessions.js              ← SessionAdmin：清单 / 分叉并重绑 / 关闭 / 删除
    │   ├── http.js                  ← 面板 HTTP 面（含跨站防护）
    │   ├── tools.js                 ← 模型工具 agent_sessions
    │   ├── client.js                ← 侧栏 Agent 会话栏
    │   ├── diagnostics.js           ← 冷启动失败的一行诊断
    │   ├── config.js                ← Config schema（agents 字典 = provider 组）
    │   ├── presets.js               ← opencode / claude-code / codex / gemini
    │   ├── adapter.js               ← LlmAdapter：绑定、resume/replay、chunk、串行化
    │   ├── render.js                ← 历史渲染 / 增量 / 漂移摘要（纯函数）
    │   ├── registry.js              ← DSH 会话 ↔ 外部会话 持久绑定
    │   └── transport/
    │       ├── contract.js          ← 契约：能力位 + 归一化事件 + 断言
    │       ├── acp.js               ← ACP 实现（官方 SDK，一进程多会话）
    │       ├── cli.js               ← 配置驱动 CLI 实现
    │       └── index.js             ← 工厂 + 凭据注入
    ├── scripts/link-dsh.mjs         ← 软链本机 DSH 包（只为跑测试）
    └── test/                        ← 70 个测试：契约 + ACP + CLI + 适配器 + 会话管理 + HTTP + 工具 + 配置
```

验证：`npm run link && npm test` → **70 passed / 0 failed，约 3s**。
测试里的 `fake-agent.mjs` 是真的讲 ACP 的 agent，`fake-cli.mjs` 是真的 CLI 子进程，
协议层没有被 mock 掉。

> 仍然未验证的一点：本机没有 opencode 的登录态，所以**没有真的向 opencode 发出过一次
> 模型请求**。握手、能力位、`session/new` 的 configOptions、模型目录 12→122 都是实测的，
> 但"一整轮对话真的跑通"还需要在装了 opencode 的环境里跑一次。

---

## 10. M2：真机启用记录

插件已经装进 profile 并启用（`include:llm-agent-providers`，active），配置一条：

```yaml
- id: llm-agent-providers
  name: dsh-agent-providers
  config:
    agents:
      opencode-go:
        preset: opencode
        command: /usr/local/bin/opencode
        connectTimeoutMs: 60000
        credentials: { OPENCODE_API_KEY: CUSTOM_OPENCODE_API_KEY }
```

线上实测（都是在这台机器上打的真实请求）：

| 面 | 结果 |
|---|---|
| `GET /agent-providers` | 200，`{route: opencode-go, capabilities: [fork, images, list, resume, stream, switchModel], sessions: 21}` |
| `GET /agent-providers/api/close?...` 无自定义头 | 403 `ACTION_HEADER` |
| 同上带 `x-dsh-agent-providers: 1` | 200 `{closed: true}`，opencode store 里真的少了一条 |
| 模型工具 `agent_sessions({action:'list'})` | 直接在本会话里调用成功，回 21 条真实会话 |
| 真实推理 | ✅ `OK`（`end_turn`，usage input 4214 / output 3，首 token +5.5s） |

### 真机跑出来的四个 bug（都已修 + 加了回归测试）

1. **preset 被 schema 默认值吞掉**：`args: z.array(...).default([])` 先物化成 `[]`，
   浅合并时盖掉 preset 的 `['acp']`，于是 opencode 启动的是 TUI 而不是 ACP server ——
   表现为 `initialize` 60s 超时。修法：agent entry 的字段不再带 schema default，
   默认值统一由 `resolveAgent` 在 preset 合并之后给。
2. **`ctx.credentials` 拿不到服务**：可选服务的正确访问是 `ctx.get('credentials')`；
   直接 `ctx.credentials.resolve(...)` 抛 TypeError 被自己的 catch 吞成"没配凭据"。
3. **插件路由只收 GET/HEAD**：POST 在插件代码运行前就被 `405 allow: GET, HEAD` 拦掉，
   动作改为带自定义头的 GET；同时 prefix 路由的 path 不能带尾斜杠，动作因此挂在
   `/agent-providers/api` 子路径下（否则和清单路由撞）。

4. **opencode 的 ACP 不认 `OPENCODE_API_KEY`**：设了它只会让模型目录出现
   `opencode-go/*`，**推理**读的是它自己的凭据文档（`auth.json`），于是每次
   prompt 都回 `Invalid credential`；而 `opencode run` 不走 ACP，所以"直接跑没问题"。
   定位过程：`opencode run` 成功 → 同一 ACP 路径换 cwd 仍失败 → opencode 日志显示
   先失败的是 `small=true agent=title` 子调用 → 写 `auth.json` 后 prompt 成功 →
   用 `OPENCODE_AUTH_CONTENT` 免落盘注入同样成功。
   修法：`credentials` 支持 `{ ref, template }`，把 key 包成
   `{"opencode-go":{"type":"api","key":"{value}"}}` 注入——插件里没有任何厂商分支。

另外补了一个 `launch.log`：冷启动失败时记下 executable / args / cwd / env **变量名** /
stderr 尾部，因为这类失败在浏览器里只剩一句错误。

### 第五个 bug：上下文窗口按 200k 计量

真机用起来之后暴露的：用量面板显示 `10.1K / 200K`，而 `deepseek-v4.1-flash` 是 1M。

根因：**ACP 不告诉客户端模型窗口**，`session/new` 的 configOptions 只有 id 和名字，
`usage_update`（唯一带 `size` 的事件）opencode 实测根本不发。于是探测出来的模型统一
落到兜底的 200k，DSH 就按 200k 计量并压缩。

修法（三级来源）：
1. `models:` 里该模型的 `contextWindow`；
2. agent 运行时报告的 `usage_update.size`（新增 `context` 事件，谁发听谁）；
3. route 的 `defaultContextWindow`；4. 兜底 200k。

同时加了 `catalog` 模式：`probe` = 探测目录 + 把 `models:` 当元数据覆盖，
这样钉一个模型的窗口不需要把 agent 的整个目录抄一遍。

### M3：交互与可用性（第六轮）

真机用起来之后继续收的一批：

| 项 | 做了什么 |
|---|---|
| 选择器区分 | 每个 agent 模型带 `badge`（`LlmModelInfo.badge`，选择器原生渲染成 Tag），可按 route 改文字/色调 |
| 套餐拒绝 | 模型报 `Model access is disabled` 后，目录里该模型变成 `无权限` 警告标签；之后成功回答会清掉 |
| 面板跟随会话 | 面板经 slot 的 `inject: (sessionId) => ({sessionId})` 拿到当前会话，高亮绑定的那一行并给出"分叉当前对话" |
| 冷启动反馈 | 未预热的 turn 先吐 `Starting <agent>…`；整条 chunk 流在测试里过真实 `BlockAssembler` 验证可装配 |
| 标题 | `session-title` 用本地启发式（首句前 48 字）回答，不再报错；其它辅助用途仍拒绝 |
| 用量映射 | 实测确认 agent 报的 `inputTokens` 已不含缓存，去掉错误减法；不硬凑 `totalTokens` |
| 图片 | 声明 `text,image` 的同时真正把当轮图片发给 agent；没有附件服务时只声明 `text` |

**做不了的一条**：面板 `工具 9.6K` 的虚高。`tools.restrict()` 要求 agent 作用域（拒绝全局限制），
`agent/pre-step` 的决策里没有工具集——插件层无法让某个 route 不组装工具。已记进 README 的缺口表。

### 发布前审计（第七轮）

按"隔离性 / 安装卸载 / 独立仓库"三个问题做的一次审计，改掉的：

| 发现 | 处理 |
|---|---|
| **子进程继承宿主全部环境变量**（含 `DEEPSEEK_API_KEY`） | 按宿主 subprocess seam 的规则洗白：丢 `KEY/PASSWORD/SECRET/TOKEN` 形状和全部 `DSH_*`，只保留 profile 显式映射的凭据。有端到端测试证明父进程的 `DEEPSEEK_API_KEY` 到不了 agent |
| **插件路由没有认证**（`GET /` 是 401，`GET /agent-providers` 是 200） | 两个路由都改成 raw handler 以便看到 peer 地址，非 loopback 一律 403 |
| `agent_sessions` 工具全局注册，可能撞名 | 加 `exposeTool` 开关和 `toolName` |
| 绑定表无上限 | 加 `maxBindings`（默认 1000，按最近使用淘汰） |
| 包在 `skeleton/` 子目录、无 LICENSE/CI/engines | 提到仓库根，补 LICENSE、`.gitignore`、CI、`engines.dsh`、`devDependencies`（CI 不需要本机 DSH） |

仍然没解决、并写进 README 缺口的：工具 schema 计入计量（插件层改不了）、
没改用 `ctx.subprocess` 的托管终止、同一进程内多会话并发无上限。

### 仓库化与本地化（第八轮）

按官方 bundle 的仓库约定逐项对齐（`dsh-experimental-liveshare` 等包的布局）：

| 项 | 处理 |
|---|---|
| 双语 README | `README.md`（英文，主）+ `README.zh.md`（中文），两边都有语言切换行 |
| 插件清单本地化 | `locale/en.json` / `locale/zh.json` 带 `meta.title` / `meta.description` / `meta.detail` |
| 详情页 | `docs/DETAIL.md` / `docs/DETAIL.zh.md`（各一行图片）+ `docs/preview.svg`（640×300，无文字，明暗主题都可读） |
| 清单字段 | `icon`、`exports["./locale/*.json"]`、`publishConfig.access`、`files` 显式列出 |
| 打包核对 | `npm pack --dry-run` → 28 个文件 / 64.7 kB，`probe/` 与内部调研不进包 |
| 变更记录 | `CHANGELOG.md` |
| 刻意不做 | `README.i18n.yaml`：官方仓库里它是 `verify-translation-pairing` 生成的标题哈希记录，手写只会像样但不可信，已写进 README 的发布待办说明原因 |

### 一次被纠正的错误结论

M2 第一次收尾时我判断"opencode 自己的网关连不上，与插件无关"——**这个结论是错的**。
当时三个"证据"都成立（key 直连端点 200、免费模型同样失败、opencode 日志 401），
但漏了关键一层：免费模型那两次运行其实也带着同一把 key（凭据被环境变量兜住了），
而 ACP 的推理根本不看环境变量。用户一句"key OK 的话不应该出现这个问题"把方向掰回来了。
教训记在这里：**"用另一条路径成功"不等于"当前路径的输入是对的"**，要控制变量重测。

**下一刀（M3）**：usage 差分、侧栏 fork 按钮；以及等 opencode 的网关鉴权可用（或换
Claude Code / Codex 的 ACP）之后再验证一整轮真实对话。
