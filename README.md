# dsh-agent-providers

**English** | [中文](README.zh.md)

Register a third-party coding agent — **OpenCode**, Claude Code, Codex, TRAE CLI, Gemini CLI,
Aiden Claude, or anything that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) — as a **model provider group** in
DeepSeek Harness. Its models appear in the picker under their own heading, exactly like
a normal provider. The agent does the work with its own tool loop; the harness keeps the
conversation, the session list, and the credential.

```
OpenCode Go              ← the group this plugin registers
  ├─ OpenCode-Go/DeepSeek V4.1 Flash   Agent
  ├─ OpenCode-Go/GLM 5.3               Agent
  └─ … 44 models, 33 on the Go plan
DeepSeek account         ← already there
opencode                 ← already there
```

A workspace under the composer shows durable execution records, tool details, plan status,
verified text-file results, and the agent's stored conversations. It keeps requested and confirmed
model selections separate and supports Stop and native session select options.

**Interaction/stability upgrade:** see [implementation, configuration, validation and limits](docs/INTERACTION_UPGRADE.md).
The historical measurements below describe upstream agent versions; they are not claims that this
working-copy upgrade was tested against every live agent. `npm test` includes new recovery and real
React component regression coverage. No external tool call is ever re-executed by the harness.

## Supported agents

Everything below was measured against the installed agent, not read from a README.

| Agent | Command | Sessions | Model choice | Credential |
|---|---|---|---|---|
| **OpenCode** 1.19.6 | `opencode acp` | list, fork, resume, close | 44 from the account, discovered | credential **document** (`OPENCODE_AUTH_CONTENT`) |
| **OpenCode v2** 2.3.2 | `opencode2 acp` | list, fork, resume, close | 49 from the account (`deepseek/…`, `gateway/…`, `opencode-go/…`), discovered | its own `~/.local/share/opencode/auth.json` — nothing mapped |
| **Claude Code** (`claude-agent-acp` 0.109.1) | `claude-agent-acp` | list, fork, resume, close, **delete**, title | `default` `opus` `fable` `sonnet` `haiku`; options `effort`, `fast`, `ultracode`, `mode` | `ANTHROPIC_API_KEY`, no sign-in call |
| **Codex** (`codex-acp` 2.9.0) | `codex-acp` | list, fork, resume, close, delete, title | account-derived (11 seen), only after sign-in | ACP `authenticate` with `api-key` |
| **TRAE CLI** (`traex`, traecli 0.216.0) | `traex acp serve` | list, fork, resume, close (**no delete**) | account-derived (12 seen) + `mode`, `collaboration_mode`, `reasoning_effort` options | its own `~/.trae` login, or `TRAECLI_PERSONAL_ACCESS_TOKEN` |
| **Aiden Claude** (`aiden x claude`, Aiden 2.0.6 / Claude Code 2.1.328) | `aiden x claude` | resume only, through Claude Code's session id (**no list/fork/delete**) | live gateway catalogue (`aiden x models --claude --json`, 7 seen); each `id` is what `--model` takes | Aiden's own ByteCloud sign-in, **nothing mapped** |

The five ACP routes accept image prompts; `aiden-claude` is text-only. Anything else that
speaks ACP works by writing the fields out.

```yaml
agents:
  opencode-go: { preset: opencode, displayName: OpenCode Go, defaultContextWindow: 1000000, catalog: probe }
  opencode-v2: { preset: opencode2, displayName: OpenCode v2 }
  claude:      { preset: claude-code, displayName: Claude Code }
  codex:       { preset: codex, displayName: Codex }
  trae:        { preset: traex, displayName: TRAE CLI }
  aiden:       { preset: aiden-claude, displayName: Aiden Claude }
```

### Two OpenCode binaries, two presets

They are not the same program. `opencode` (1.x) is the older npm build whose ACP server ignores
`OPENCODE_API_KEY` for inference and reads a credential *document* instead — the trap
[below](#the-credential-trap-opencode-acp-ignores-opencode_api_key). `opencode2` (2.3.2) is the v2
binary: it signs in through its own `~/.local/share/opencode/auth.json` (providers seen here:
`deepseek`, `gateway`, `opencode-go`), so `preset: opencode2` maps **no** credential and therefore
also works on a machine that has no `CUSTOM_OPENCODE_API_KEY` stored — where `preset: opencode`
fails with "needs credential".

v2 reports disjoint usage already (measured: `inputTokens` 69 beside `cacheReadTokens` 59344), so it
does **not** set `inputTokensIncludeCache`; it does send `usage_update` (`size` 1048576 for the
default model), so the window is learnt at runtime.

Permissions: v2 **can** ask, but it auto-allows by default, so nothing prompts until its own config
says so. Put this in the project's `opencode.json` (or set the same keys in the global config):

```json
{ "permission": { "edit": "ask", "bash": "ask" } }
```

With that, a write arrives as `session/request_permission` carrying `allow_once` / `allow_always` /
`reject_once` and the target **path as the tool title**, and `permission: ask` turns it into a DSH
prompt reading `OpenCode v2 wants to edit files: through-plugin.txt`. Verified end to end: approving
wrote the file (`end_turn`), rejecting ended the turn (`cancelled`, `APPROVAL_REJECTED`).

`preset: codex` ships the sign-in request its source actually reads
(`_meta["api-key"].apiKey`); the credential comes from `OPENAI_API_KEY`.

`preset: traex` expands to `traex acp serve` — `acp` is a subcommand *group*, so `traex acp` alone
only prints help. It maps no credential by design: TRAE CLI signs in through its own store
(`~/.trae/traecli.toml`). `traex login status` answers "Logged in using Trae", and the plugin
reuses that sign-in — the child keeps `HOME`, so the store is reachable even though every
`KEY` / `PASSWORD` / `SECRET` / `TOKEN`-shaped name and every `DSH_*` name is scrubbed from its
environment. Its ACP `initialize` offers `trae-sso`, `trae-tob-browser`, and `trae-tob-pat`; the
last one needs `TRAECLI_PERSONAL_ACCESS_TOKEN` set *before* the process starts, so a
non-interactive profile maps it from a stored credential:

```yaml
credentials:
  TRAECLI_PERSONAL_ACCESS_TOKEN: { ref: TRAECLI_PERSONAL_ACCESS_TOKEN }
```

The plugin never writes the agent's own auth store; the environment is the only channel.

TRAE CLI publishes four session config options — `model`, `mode` (`default`, `plan`, `auto`,
`bypass_permissions`), `collaboration_mode`, and `reasoning_effort` (`low`, `medium`, `high`,
`max`) — settable from the profile by id:

```yaml
agents:
  trae:
    preset: traex
    configOptions: { mode: plan, reasoning_effort: high }
```

Model values are traex *config names*, not model ids (`Doubao-Seed-Evolving`,
`deepseek-v4.1-flash`, `DeepSeek-V4-Pro`, …), and the list is account-derived. Tool activity
arrives as `tool_call` / `tool_call_update` and is folded into the reasoning channel like every
other agent.

Every ACP preset ships `permission: ask`, so this is not TRAE CLI's private trick: when OpenCode,
Claude Code, Codex or Gemini asks the client before a gated tool, the question goes to the same DSH
approval prompt a harness tool call uses. The field is per route — `allow` auto-approves, `reject`
denies — and a hand-written route keeps the `allow` default.

For TRAE CLI the agent's own permission request becomes that DSH approval prompt, carrying its
explanation as `reason` plus a localized `displayReason` (`TRAE CLI wants to edit files: Editing
files`). TRAE CLI reports
only a generic title for edit requests, so the prompt cannot promise a file path. Approvals are
one-shot (`allowed-once`), so a second request asks again. A "no" selects its only non-grant option,
`abort`, and TRAE CLI **ends the whole turn** (`stopReason: cancelled`) rather than failing one
tool. The resulting failure names the tool and the reason: `APPROVAL_REJECTED`,
`APPROVAL_DISMISSED`, `APPROVAL_UNAVAILABLE` (e.g. `no approval channel answered for agent.edit`),
or `APPROVAL_DENIED` for `permission: reject`; a cancel the agent initiates for its own reasons
stays `ABORTED`. With no approval service, no agent to route to, or a question outside an open
turn, the transport denies and logs instead of granting; an unattended deployment should set
`permission: allow` (the old behaviour) or `reject` explicitly.

> An agent that needs a session to list models, and a session only after signing
> in, would otherwise advertise an empty group — nothing to select, so no way to
> reach the message explaining the sign-in. Such a route advertises one
> placeholder model (`default`, badge *sign-in required*) until the real
> catalogue can be read. Rename it with `fallbackModel: { id, name }`, or set
> `fallbackModel: false` to keep the group empty.

### Aiden Claude, through the company launcher

`preset: aiden-claude` is a `transport: cli` route, not ACP: it expands to the company launcher
in print mode, and Aiden owns the gateway:

```
aiden x claude --print --output-format stream-json --verbose --include-partial-messages \
  --permission-mode acceptEdits [--model <gateway-id>] '<prompt>'
```

This is a different route from `preset: claude-code`: that one talks ACP to the official
`claude-agent-acp` adapter and authenticates with `ANTHROPIC_API_KEY`, while this one lets Aiden
own both the gateway routing and the login.

Two things happen in two different places:

- **The model list is the gateway's, not a hard-coded table.** The preset ships
  `cli.catalogCommand: ['aiden', 'x', 'models', '--claude', '--json']`. The command prints pure
  JSON on stdout — `{ schema_version, source, fetched_at, models: [ { cli_type, id, series,
  alias, context_length, quota, ptu, capacity, status } ] }`, 7 models observed — while its
  `- Check user login status...` spinner goes to stderr. Each `id` is exactly the value
  `aiden x claude --model` accepts, and `context_length` is the gateway's authoritative window
  (`ark-deepseek-v4.1-flash-1017` → 936000), which `cli.catalogJson` maps onto the picker's
  window. `cli.catalogTimeoutMs` bounds the call (default 20000 ms). A recipe without
  `catalogCommand` keeps the declared `models:` as its catalogue, so no other preset changes.
- **The turn is one process, and the credential is Aiden's own.** No credential is mapped:
  `HOME` survives the environment scrub (every `KEY` / `PASSWORD` / `SECRET` / `TOKEN` shaped
  name and every `DSH_*` name is dropped), and with it intact Aiden reuses its ByteCloud
  login/token store. A non-interactive run with no cached session fails; establish that
  sign-in interactively first. `--model` is what makes a no-TTY run work at all.

Continuity is Claude Code's own: the first event carrying `session_id` (the `system:init` event
does) becomes the binding, and the next turn appends `--resume <session_id>`. That is the only
session capability this route has — a CLI process is one turn long, so there is no `list`,
`fork`, or `delete`, and a model change cannot be applied inside a live conversation: it starts
a new session and replays the transcript. Prompts are text only; there is no image input.

**Permissions are the route's flags, because a `cli` route has no approval channel.** Claude
Code in print mode denies gated tools by default — a write answers
`Claude requested permissions to write to <path>, but you haven't granted it yet.` — so the
preset ships `--permission-mode acceptEdits`: file edits go through while other gated tools stay
denied. Nothing asks DSH for approval here, unlike `permission: ask` on the ACP presets. Widen it
deliberately, and only deliberately:

```yaml
agents:
  aiden:
    preset: aiden-claude
    extraArgs: ['--dangerously-skip-permissions']   # every gated tool, without a prompt
```

`args` and `extraArgs` are appended to the launcher's own argv, so a Claude Code permission flag
belongs there. Aiden rejects passthrough of `--model` / `--settings` / `--setting-sources` /
`--fallback-model` (its own `--model` wins); `--resume`, `--print`, `--output-format`,
`--verbose`, `--include-partial-messages`, `--permission-mode`, `--allowedTools`, and
`--dangerously-skip-permissions` do reach Claude Code.

Usage is already disjoint: the `result` event carries `usage.input_tokens` (uncached) beside
`usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`, and the recipe maps
them through `jsonl.usage` to `inputTokens` / `cacheReadTokens` / `cacheWriteTokens`, so no
`inputTokensIncludeCache` adjustment is needed. One trap: `result` also carries
`modelUsage.<id>.contextWindow`, but it was generically `1e6`; trust the catalogue's
`context_length` instead.

`probe/probe-aiden.mjs [model] [prompt] [cwd]` prints the live catalogue and runs one short turn
through this preset. It spends one model call and needs a logged-in `aiden`.

## Install and uninstall

### Install

Plugins page → **Add**, or:

```bash
dsh plugin add dsh-agent-providers
```

That adds the bundle row and registers an empty `llm-agent-providers` entry — **no provider yet**,
because agent configuration belongs to your deployment. Add it to the profile patch:

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

Saving applies through HMR — no restart. Nothing is spawned until a model is first used.

### Uninstall

Plugins page → **Remove**, or `dsh plugin remove dsh-agent-providers`.

Removal deliberately leaves these behind, because they may still be wanted:

| Leftover | Location | Notes |
|---|---|---|
| Bindings + launch diagnostics | `$DSH_HOME/profiles/<profile>/agent-providers/` | Safe to delete |
| The agent's own stored sessions | OpenCode's `~/.local/share/opencode`, Claude's `~/.claude`, … | Owned by the agent; this plugin never writes them |
| The `llm-agent-providers` row in your patch | `cordis.patch.yml` | Removed by the Plugins page; delete by hand if you added it by hand |

### Development install

```bash
git clone <repo> && cd dsh-agent-providers
npm install        # or npm run link to use an already-installed DSH
ln -s "$PWD" "$DSH_HOME/profiles/$DSH_PROFILE/node_modules/dsh-agent-providers"
# then add the same llm-agent-providers row to the profile patch
```

A symlink (not a `file:` dependency) means edited code takes effect at the next profile
recomposition, without reinstalling.

## Quick start: OpenCode, reusing the credential you already have

`preset: opencode` expands to `transport: acp`, `command: opencode`, `args: ['acp']`, and a
credential mapping. Three prerequisites: `opencode` is installed (`npm i -g opencode-ai`),
the harness already stores the key, and `opencode acp` runs.

### Why the key can be reused

The `custom-opencode` provider uses `apiKeyEnv: CUSTOM_OPENCODE_API_KEY`, whose value lives in
`$DSH_HOME/.credentials.yaml`. Handing the same key to `opencode acp` grows its model catalogue
from **12 to 44** (33 on the Go plan). The `opencode-go/*` entries are the same models your
`custom-opencode` list already names, so nothing is typed twice and no secret enters the profile.

> Setting `OPENCODE_API_KEY` alone lengthens the catalogue but is **not enough to infer** — see
> [the credential trap](#the-credential-trap-opencode-acp-ignores-opencode_api_key).

### What the agent advertises (measured on 1.19.6)

`loadSession`, `sessionCapabilities` `list` / `fork` / `resume` / `close`, image prompts, and two
session config options (`model`, `mode`). Session replay, listing, forking, image input, and
model switching are all native — nothing to invent.

## Session management

Three surfaces over one `SessionAdmin`:

| Surface | Where | What |
|---|---|---|
| **Sidebar strip** | under the composer | lists each route's sessions, highlights the one this conversation is bound to, forks the current chat, closes or deletes |
| **HTTP** | `GET /agent-providers`, `GET /agent-providers/api/{close,delete,fork}` | the panel's data source |
| **Model tool** | `agent_sessions({action: 'list'\|'fork'\|'close'})` | lets an agent tidy up or branch its own conversation |

`fork` is not an orphan copy: it points the **current conversation's binding** at the branch, so
the next turn continues there. `close` releases the agent's resources and keeps the history;
`delete` really removes it. Capabilities come from what the agent advertises — OpenCode and TRAE CLI have no
`sessionCapabilities.delete`, so no delete button appears for them.

Two implementation constraints worth knowing:

- **The host dispatches plugin routes for GET/HEAD only.** A POST is answered `405 allow: GET, HEAD`
  before plugin code runs, so actions travel as
  `GET /agent-providers/api/close?route=…&sessionId=…`, protected by an
  `x-dsh-agent-providers: 1` header a cross-site page cannot send.
- **A prefix route's path carries no trailing slash** and matches `p` and `p/<anything>`, so the
  actions need their own `/agent-providers/api` sub-path or they collide with the inventory route.

## Isolation boundaries

### The child process

- Its environment is **not** the host's. The base is scrubbed with the same rule the harness's
  own subprocess seam uses — every `KEY` / `PASSWORD` / `SECRET` / `TOKEN` name and every `DSH_*`
  name is dropped — and only what your profile explicitly maps is merged back. The agent never
  sees `DEEPSEEK_API_KEY`, `DSH_HOME`, or `DSH_SESSION_ID`.
- The working directory is that conversation's own cwd; the plugin never `cd`s elsewhere.
- The plugin **does not write** the agent's own config or credential store (`auth.json`,
  `~/.claude`). Credentials are passed through the environment only.
- Children are SIGTERM→SIGKILLed when the plugin unloads, and released after `idleReleaseMs` idle.

### The host

- Exactly three registrations, all namespaced: an LLM provider route set, `/agent-providers`
  routes, and one model tool. A route-name collision throws at registration and keeps the
  previous routes instead of silently taking over.
- The settings section uses `settings.configure({ auto: false })`, matching `dsh-llm-pi-ai`.
- Optional services are attached through `ctx.inject` rather than read ad hoc: `approval`, `agents`,
  `attachments`, `credentials`, `profileContext`, `subprocess`, and `workingDirectory` are visible
  exactly when the composition mounts them, and absent otherwise. A cordis fiber only sees its
  injected services, so this is what makes credentials resolve, images load, the cwd follow the
  session, and approval requests reach the host; `llm` remains the only hard dependency.
- State is confined to `$DSH_HOME/profiles/<profile>/agent-providers/` (0700 dir, 0600 files), and
  the binding store is bounded (`maxBindings`, default 1000, oldest evicted first).
- `agent_sessions` is **global** — every agent in the profile sees it. Turn it off with
  `exposeTool: false`, or rename it with `toolName`.

### The network

- Both `/agent-providers` routes answer **loopback peers only**; anything else gets 403.
- Mutations additionally require the `x-dsh-agent-providers: 1` header and a same-origin `Origin`.
- Known fact: these plugin routes are **not** behind whatever authenticates the app shell
  (`GET /` answers 401, `GET /agent-providers` answers 200). Do not expose DSH directly to the
  internet; put your own authentication in front if you need remote access.

## Telling agent models apart

Picking an agent-backed model looks identical to picking a normal one, and the difference matters:
the agent runs its own tools. With `permission: ask` its *permission requests* go through the
harness's approval prompt, but the sandbox the agent enforces is still its own, not the harness's.
Every model of an agent route therefore carries a badge — `LlmModelInfo.badge`, which the picker
already renders as a tag. No client code involved. Override per route:

```yaml
badgeText: external
badgeTone: warning    # neutral | info | success | warning
```

A model the plan refuses (`Model access is disabled`) keeps its place in the catalogue but gains a
`no access` warning badge; a later successful answer clears it.

## Context window

ACP does **not** tell the client a model's context window: `session/new` carries ids and names
only, and `usage_update` — the one event with a `size` — is not sent by OpenCode. Without
configuration every probed model would be metered at the 200k fallback, so a 1M model would be
counted and compacted against the wrong number.

A `cli` route can do better than a default when its catalogue command carries the window itself.
`aiden x models --claude --json` gives each model a `context_length` (936000 for
`ark-deepseek-v4.1-flash-1017`), and `cli.catalogJson.contextWindow: 'context_length'` puts it on
the model, so the gateway's own number is what the meter uses from the first turn. The `result`
event's `modelUsage.<id>.contextWindow` is not a substitute: it measured generically at `1e6`.

TRAE CLI does send it. Across four models the runtime `size` was 95% of the model's raw window:
`gpt-6.1-sol` 475,000 → 451,250; `gpt-5.6-sol` 272,000 → 258,400; `DeepSeek-V4-Pro` 216,000 →
205,200; `Doubao-Seed-Evolving` 1,000,000 → 950,000. Its `_meta` names both `rawContextWindow` and
`autoCompactBufferTokens` (40,960, subtracted once more to get its own `autoCompactTokenLimit` — not
the raw-to-`size` difference). The static catalogue value can be stale, too: `deepseek-v4.1-flash`
is listed with `_meta.trae.contextWindow: 200000`, while the runtime `usage_update` /
`_meta["_trae/contextUsage"]` for that same model reports `rawContextWindow: 1000000`,
`effectiveContextWindow: 950000`, and `autoCompactTokenLimit: 909040`; the harness adopts the
runtime 950000. Runtime outranks the catalogue for exactly that reason. The catalogue is still worth
reading first: `contextWindowMetaPath: 'trae.contextWindow'` makes `resolveModel` read each model's
advertised window, and it hydrates the catalogue itself when no window is known yet — so even a
headless run that never lists models meters `gpt-6.1-sol` at 475,000 and `Doubao-Seed-Code` at
116,000 from the start (previously 200,000 for every model). No `models:` pinning is needed for
`traex`, though a profile can still pin one, as below. The agent's own bookkeeping rides along: `session/prompt` results carry `_meta["_trae/tokenUsage"]`, while its
update stream carries `_meta["_trae/contextUsage"]` with per-category counts (`systemPrompt`,
`toolDefinitions`, `developerMessages`, `userMessages`, `assistantMessages`, `toolResponses`).

Four sources, highest first:

1. the model's own `contextWindow` under `models:`
2. the `usage_update.size` the agent reports at runtime (honoured when present)
3. the window a catalogue entry advertises in `_meta`, read through `contextWindowMetaPath`
4. the route's `defaultContextWindow`
5. the 200 000 fallback

`hy3` and `iceman-*` are really 256k; pin them if you use them:

```yaml
catalog: probe
models:
  - { id: opencode-go/hy3, contextWindow: 256000, maxTokens: 131072 }
```

> `catalog: probe` asks the agent for its catalogue and treats `models:` as metadata overrides, so
> pinning one model does not mean re-declaring all 33.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `preset` | — | `opencode` / `opencode2` / `claude-code` / `codex` / `gemini` / `traex` / `aiden-claude` / `cli-jsonl` |
| `transport` | `acp` | `acp` or `cli` |
| `command` / `args` | — | how to start the agent |
| `env` | `{}` | literal child environment, highest precedence |
| `credentials` | `{}` | child variable → credential. A bare ref injects the secret; `{ ref, template }` fills `{value}` into a template |
| `cwd` | the session's cwd | working directory override |
| `permission` | `allow` (`ask` in every ACP preset) | `allow` auto-approves the agent's permission requests; `reject` denies; `ask` routes them to the harness approval prompt (denies when none is available) |
| `continuity` | `auto` | `resume` sends only new input; `replay` replays the transcript; `auto` follows the transport |
| `eventTimeoutMs` | 600000 | silence bound between two agent events in one prompt; suspended while an approval waits on a human |
| `connectTimeoutMs` | 120000 | spawn + initialize + session creation bound |
| `idleReleaseMs` | 600000 | release a warm process after this idle |
| `catalog` | `auto` | `auto` / `probe` (probe + overrides) / `declared` |
| `auth` | — | `{ methodId, ref, params }` for an agent that refuses `session/new` until `authenticate`; `{value}` in `params` is the credential |
| `configOptions` | `{}` | session configuration applied after create/load, and re-applied when an existing session is resumed, by option id: `{ effort: high, mode: plan }` |
| `fallbackModel` | `true` | the placeholder a route advertises while its catalogue is unreadable |
| `models` | `[]` | model table / overrides |
| `defaultContextWindow` | `200000` | window for models that declare none |
| `defaultMaxTokens` | — | output cap for models that declare none |
| `badgeText` / `badgeTone` | `Agent` / `info` | the picker tag |
| `showToolActivity` | `true` | fold tool activity into the reasoning channel |
| `inputTokensIncludeCache` | `false` | the agent folds cached tokens into `inputTokens`; subtract `cachedRead` + `cachedWrite` so the harness's counts stay disjoint |
| `contextWindowMetaPath` | — | dotted path inside a catalogue entry's `_meta` where the agent reports the model's window, e.g. `trae.contextWindow` |
| `cli.catalogCommand` / `cli.catalogJson` / `cli.catalogTimeoutMs` | — / — / 20000 | a `cli` recipe's live catalogue: the argv to run, the JSON paths naming each entry (`entries`, `id`, `name`, `contextWindow`), and the timeout. Without a command the declared `models:` are the catalogue |
| `exposeTool` / `toolName` | `true` / `agent_sessions` | the global session tool |
| `maxReplayChars` (top level) | 400000 | replay truncation, oldest first |

## Using an agent as a subagent (delegation)

Two different seams, and only the first one belongs to this plugin:

- **The agent as a model.** Covered here. A route is a provider, so a child agent created by the
  harness's own delegation tool can *use* it — `subagent-model-selection-settings.allowedModels`
  treats these routes like any other provider (`trae/deepseek-v4.1-flash`). Nothing to configure
  beyond the route itself.
- **The agent as the subagent backend.** The harness hands a task to a child that is an external
  process driven over ACP. DSH ships that backend as `@deepseek-ai/dsh-subagent-acp`, a named
  provider on `ctx.subagents`; it wants configuration, not code, and the same two rows work for
  every ACP agent in the table above.

### Wiring it

```bash
dsh plugin --profile <profile> add @deepseek-ai/dsh-subagent-acp@0.2.2-rc.1
```

```yaml
- insert:
    - id: subagent-acp-traex
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: traex            # the name the delegating tool asks for
        command: traex
        args: ['acp', 'serve']
        permission: allow              # or reject (the default) — see below
    - id: tool-subagent-traex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: traex                # must match providerName
        toolName: traex_subagent       # one instance per provider, distinct name
        maxDepth: 'provider-managed'   # required — see the first trap
```

Two traps, both hit on the first wiring:

1. **`maxDepth: 'provider-managed'` is mandatory.** An ACP backend advertises no start
   capabilities — it cannot enforce depth, tool filters, persona or structured output — and the tool
   refuses to activate without the acknowledgement: `provider "traex" cannot enforce maxDepth (no
   depthLimit capability)`.
2. **Peer dependencies are not installed for you.** `@deepseek-ai/dsh-subagent-acp` peers on six
   `@deepseek-ai/dsh-*` packages at the harness's own version, and a pnpm-hoisted profile does not
   pull them in: the row then fails to import with
   `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-subagent` (with another layer under it, `dsh-scope`).
   Add them explicitly (`dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-subagent`, `dsh-subprocess`,
   `dsh-timeout`, `cordis`) or re-run the install with `--config.auto-install-peers=true`.

### What a subagent run is *not*

| | Provider route (this plugin) | Subagent backend (`dsh-subagent-acp`) |
|---|---|---|
| Context | the DSH conversation, resumed or replayed | **fresh process and session**; inherits only the parent's cwd |
| Permissions | `ask` reaches the harness approval prompt | `allow` / `reject` only, answered by the backend — **no human prompt**, and `reject` is the default |
| Metering | disjoint usage; window learnt from `usage_update` | none of it: only the child's final text comes back |
| Model | picked per turn in the picker | the child's own default model |
| Process | one warm process per route + cwd | one new process per run, no pooling |

Because `permission` is answered rather than asked, a `traex` subagent needs `allow` to write files
or run commands at all; the default `reject` denies every gated tool. The same rows work for
`opencode2` (`args: ['acp']`), which asks only when its own config says so.

Verified end to end on a real harness profile: a parent session called `traex_subagent` once with
"reply with exactly SUBAGENT_OK", TRAE CLI answered, and the parent reported `SUBAGENT_OK`.

## Key design decisions

1. **Never emit `tool-call-delta`.** The agent owns its tools; a tool call here would make the
   harness execute the agent's internal tools. Tool activity is folded into the reasoning channel.
   An id-shaped tool title (`call_00_…`) falls back to the ACP kind, so a breadcrumb reads
   `→ Editing files` rather than `→ call_00_…`, and the cold-start note sits on its own line.
2. **One DSH step = one assistant message.** The agent finishes inside one prompt turn and
   `end_turn`s, so the harness turn ends immediately.
3. **Resume is the default, replay is the escape hatch.** Resume only when the binding provably
   still matches: same cwd, the already-forwarded user turns are still the request's leading user
   turns, and their digest matches. Compaction, forks, and rewrites all fail this and replay.
4. **Capabilities drive degradation.** A transport without `RESUME` gets a replay per turn and no
   binding; without `IMAGES`, images degrade to a note. Nothing is claimed that is not delivered.
5. **`session/load`'s replay is dropped.** The harness session is the authoritative copy; emitting
   it again would duplicate every message.
6. **Auxiliary calls are answered locally.** A title is derived from the user's own words instead
   of spending an agent run; anything else (a compaction summary) is refused rather than faked.
7. **One process serves many sessions, one prompt at a time per conversation.** ACP addresses
   sessions by id, so one warm process per route+cwd is enough; turns are serialized per
   (Session, route).

## The credential trap: OpenCode ACP ignores `OPENCODE_API_KEY`

Worth knowing because it costs an afternoon:

- `OPENCODE_API_KEY` only affects the **catalogue** — set it and `opencode-go/*` appears.
- **Inference** reads the agent's own credential document (`auth.json`). The environment variable
  path does not work in ACP mode, so every prompt answers `Invalid credential`.
- `opencode run` does not go through ACP and works fine, which is why "running it directly" looks
  healthy.

The fix is to wrap the key into the document without touching the user's `auth.json`:

```yaml
credentials:
  OPENCODE_AUTH_CONTENT:
    ref: CUSTOM_OPENCODE_API_KEY
    template: '{"opencode-go":{"type":"api","key":"{value}"}}'
```

The `opencode` preset already ships this, so the profile only needs `preset: opencode`.
`OPENCODE_AUTH_CONTENT` is OpenCode's own variable; `{value}` is replaced by the resolved secret.
There is no vendor-specific branch in the plugin — a different agent just needs a different template.

## The usage trap: ACP does not promise disjoint token counts

Worth its own heading because it silently doubles the meter:

- ACP leaves the relationship between `inputTokens` and the cache counters open.
- OpenCode reports the **uncached** prompt count and the cache separately, so the harness's
  "`inputTokens` excludes the cache" rule already holds.
- TRAE CLI folds cache read **and** write into `inputTokens`. One measured turn:
  `{ totalTokens: 49481, inputTokens: 49394, outputTokens: 87, cachedReadTokens: 24624, cachedWriteTokens: 24764 }`
  — so `inputTokens` = 24624 read + 24764 write + 6 new tokens. Taken literally, the harness
  would count the prompt ~2× and then add the cache on top.
- `inputTokensIncludeCache: true` says which reading the agent uses; the transport subtracts
  `cachedReadTokens` + `cachedWriteTokens` from `inputTokens`. The same kind of turn through the
  preset reported `{ inputTokens: 103, outputTokens: 2, cacheReadTokens: 22656 }` —
  103 + 22656 = the raw 22759.

This is a generic knob, not a vendor branch: an agent that folds the cache in just sets the same
field. The `traex` preset ships it; every other preset keeps the default `false`.

The `cli` route has the same disjointness obligation with a simpler answer: Claude Code already
reports `usage.input_tokens` uncached beside `usage.cache_read_input_tokens` and
`usage.cache_creation_input_tokens`, so `aiden-claude` maps those two paths to
`cacheReadTokens` / `cacheWriteTokens` and keeps `inputTokensIncludeCache` off.

## Verification

```bash
npm test        # 153 tests, ~11s
```

Coverage: transport conformance (one suite runs against ACP and CLI), the adapter (chunk pairing,
no `tool-call-delta`, resume/delta, drift → replay, serialization, usage mapping including the
cache-folded reading, approval routing, its fail-closed path, and the failure codes that name the
tool, the silence watchdog with its approval suspension, catalogue-window precedence, badge,
image forwarding, cold-start note validated against the real `BlockAssembler`), the CLI catalogue
command (mapped entries, id de-duplication, a document behind banner text, failure by command
name, timeout, abort), its cache-token usage, the window it publishes reaching the meter before
the picker opens, and the `aiden-claude` preset's measured invocation,
session administration, the HTTP surface (headers, origin, peer, argument bounds), the tool, config
resolution including preset expansion, the scrubbed environment, and the pure render helpers.

`test/fake-agent.mjs` is a real ACP agent over stdio and `test/fake-cli.mjs` is a real child
process, so the protocol layer is not mocked.

`probe/probe-dsh-headless.mjs` goes one level up: it drives the `traex` preset through a real
headless DSH profile — throwaway `DSH_HOME`, symlink + patch, never `~/.dsh` or `~/.trae` — prints
every `--json` event with arrival timings, and asserts the file the agent wrote. `--model` picks
another model; `--no-approver` reproduces the fail-closed path.

### Measured live

| Scenario | Result |
|---|---|
| Real inference (no env var, no `auth.json`) | ✅ `OK`, `end_turn`, real usage |
| Two turns (resume + delta only) | ✅ second turn answers correctly, binding not rebuilt |
| `session/fork` + rebind | ✅ new session, both in the agent store, branch inherits history |
| A model the plan denies | ✅ `Model access is disabled`, catalogue marks it `no access` |
| An image through the adapter | ✅ the model read the screenshot |
| Claude Code: handshake → catalogue → model selection → prompt | ✅ 5 model ids, `delete` advertised, a bad key reports the agent's own HTTP 403 verbatim |
| Codex: ACP `authenticate` → catalogue | ✅ 11 account models appeared **only after** signing in, so the `_meta` shape is right |
| TRAE CLI: handshake → catalogue → prompt | ✅ 12 account models (e.g. `Doubao-Seed-Evolving`, `gpt-6.1-sol`, `deepseek-v4.1-flash` as default); handshake 0.5–1.4s, cold first answer 4–5s (its own system prompt is ~22–24k tokens) |
| TRAE CLI: model switch | ✅ `set_config_option model` → `gpt-6.1-sol` in 163 ms, first token 4108 ms, total 4493 ms; → `Doubao-Seed-Evolving` switch 83 ms, first token 10.5s |
| TRAE CLI: resume | ✅ `session/load` in 168 ms, same session id, `resumed=true`; the second turn recalled a stored codeword, and its `inputTokens` was 61 (only the new user turn forwarded; the prior context came from the agent's store, 22912 cache-read tokens) |
| TRAE CLI: fork | ✅ `session/fork` returned a distinct id and the fork inherited history (answered the codeword correctly, 2586 ms) |
| TRAE CLI: catalogue windows with no model listing | ✅ a headless run that never called `listModels()` still resolved `gpt-6.1-sol` 475000 and `Doubao-Seed-Code` 116000 from `_meta` (previously 200000) |
| TRAE CLI: approval through a real DSH profile | ✅ answerer `allowed-once` → `approval/request "agent.edit" -> allowed-once`, file written (16 bytes), turn completed, exit 0; `--no-approver` → `APPROVAL_UNAVAILABLE: no approval channel answered for agent.edit, so the agent stopped this turn`, exit 1, no file |
| TRAE CLI: approval allow | ✅ an edit request arrived with options `approved` (allow_once) + `abort` (reject_once, "No, provide feedback"); the harness outcome `allowed-once` selected `approved`, the file was created, `end_turn` |
| TRAE CLI: approval reject | ✅ `rejected` selected `abort`; TRAE CLI aborted the whole turn — `stopReason: cancelled` (not just the tool) |
| TRAE CLI: headless multi-turn resume | ✅ turn B forwarded only 330 new input tokens and recalled the codeword; turn C switched to `gpt-6.1-sol` with 120 input tokens (also proves `resume()` re-applies `configOptions`) |
| TRAE CLI: image | ✅ a 256×256 solid-red PNG was read as "Red" by both `gpt-6.1-sol` (4.4s) and `deepseek-v4.1-flash` (2.2s) |
| TRAE CLI: unauthenticated (empty `HOME`, real login untouched) | ✅ `initialize` still succeeds with the three auth methods, but `session/new` and `session/list` answer `{"code":-32000,"message":"Authentication required"}`; the fallback keeps the group selectable as `TRAE CLI (sign-in required)` with the warning badge |
| TRAE CLI: usage through the preset | ✅ raw `inputTokens 49394` = 24624 read + 24764 write + 6 new; the plugin reports `{ inputTokens: 103, outputTokens: 2, cacheReadTokens: 22656 }` |
| TRAE CLI: window learned from `usage_update` | ✅ runtime `size` = 95% of the raw window across four models; `deepseek-v4.1-flash` is listed as 200000 but runtime reports 950000 (raw 1000000), adopted without `models:` pinning |
| Aiden Claude: live catalogue | ✅ `aiden x models --claude --json` → 7 gateway models, pure JSON on stdout and Aiden's login spinner on stderr; `ark-deepseek-v4.1-flash-1017` carries `context_length: 936000` |
| Aiden Claude: one tool-using turn | ✅ `--print --output-format stream-json --verbose --include-partial-messages`: event mix observed in one tool-using turn (`system:hook_started` ×8, `system:hook_response` ×8, `system:init` ×1, `system:status` ×2, `stream_event` ×39, `assistant` ×3, `user` ×1, `system:thinking_tokens` ×24, `result:success`), exit 0 |
| Aiden Claude: resume | ✅ `--resume <session_id>` continued the same conversation (recall verified) |
| Aiden Claude: permissions in print mode | ✅ default denied a gated write (`Claude requested permissions to write to <path>, but you haven't granted it yet.`); the same write succeeded with `--permission-mode acceptEdits` |
| Panel HTTP (fork/close/delete/unknown/cross-site) | ✅ 200 / 200 / 200 / 404 / 403 |

## Repository layout

```
dsh-agent-providers/
├── package.json          # manifest: dsh.bundle, dsh.client, engines.dsh, exports
├── cordis.patch.yml      # bundle patch: inserts the llm-agent-providers row (no config)
├── icon.svg
├── locale/               # meta.title / meta.description / meta.detail per language
├── lib/                  # runtime code
├── docs/                 # DETAIL pages, preview, transport contract, research notes
├── test/                 # 153 tests, runs in CI
├── probe/                # live verification scripts (not published)
├── scripts/link-dsh.mjs  # dev-only: link an installed DSH
└── .github/workflows/ci.yml
```

## Probes

`probe/` holds the scripts used for live verification (dev only, not published):

| Script | Purpose |
|---|---|
| `probe-acp.mjs <cwd>` | time one ACP handshake per step |
| `probe-turn.mjs <model> <prompt> <cwd> [preset]` | one real turn through the plugin's own credential path |
| `probe-usage-cumulative.mjs` | three turns in one session, to see whether usage is per-turn |
| `probe-fork.mjs` | real `session/fork` + rebind + continuation |
| `probe-extras.mjs` | denied-model badge and images through the adapter |
| `probe-vision.mjs <image>` | read an image with a multimodal model |
| `probe-agent.mjs <command> [args…]` | describe any ACP agent: capabilities, session options, modes, store |
| `probe-agents.mjs [preset…]` | drive the Claude Code / Codex presets end to end |
| `probe-traex.mjs [model] [prompt] [cwd]` | one real turn through the `traex` preset: capabilities, account catalogue with per-model windows, the four config options, disjoint usage |
| `probe-dsh-headless.mjs [--model m] [--task t] [--no-approver]` | drive the `traex` preset through a real headless DSH profile in a throwaway `DSH_HOME`; timestamped `--json` events, asserts the written file; `--no-approver` reproduces fail-closed |
| `probe-aiden.mjs [model] [prompt] [cwd]` | the live Aiden gateway catalogue, then one short turn through the `aiden-claude` preset; needs a logged-in `aiden` and spends one model call |
| `probe-context.mjs` | read the live profile, print resolved window / modalities / badge |

## Before publishing

| Item | Status |
|---|---|
| CI | `npm install && npm test` works from `devDependencies`; no local DSH needed |
| Version policy | ACP SDK pinned at `1.4.0` (matches the DSH tree); moving to 2.x needs ACP v2 work |
| DSH floor | `engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0` and the `@deepseek-ai/dsh-*` peers are `^0.2.2-rc.1`. A narrower floor (the old `>=0.2.2-rc.3`) made DSH on the installed `0.2.2-rc.1` silently disable the provider row — `disabling profile plugin row "llm-agent-providers" … incompatible` → `NO_ADAPTER` |
| `README.i18n.yaml` | Official bundles carry a heading-hash pairing record produced by their own `verify-translation-pairing` tool. Not shipped here rather than hand-writing hashes that would only look authoritative |

## Known gaps

| Gap | Notes |
|---|---|
| Tool schemas are metered | The panel's `工具 9.6K` counts schemas the agent never receives. `tools.restrict` requires an agent scope and `agent/pre-step` carries no tool set, so a plugin cannot suppress them |
| Managed subprocess | The plugin spawns and scrubs itself; `ctx.subprocess.spawn` would additionally give managed-range teardown |
| No concurrency cap | One process serves a route+cwd; several conversations may prompt at once and the agent queues them |

## Risks

- The agent runs its own tools in its own sandbox, so **the harness's sandbox still does not apply**.
  Its *permission requests*, however, can go through the harness approval prompt: `permission: ask`
  (what `traex` ships) does that, `allow` auto-grants, `reject` denies. When no approval service
  exists, no agent can be routed to, or the question lands outside an open turn, it fails closed
  (denies, never grants) — a headless deployment should set `allow` or `reject` explicitly.
- TRAE CLI's own approval options for an edit are `approved` (allow once) and `abort` (reject once,
  "No, provide feedback"); it has no other non-grant path, so a denial — or an unavailable approval
  channel — ends the whole turn (`stopReason: cancelled`) instead of failing one tool. Its
  `mode: bypass_permissions` ("Full Access") is the agent's own setting. Under `permission: allow`,
  its own sandbox may first deny a gated write and then escalate to the approval request, so one
  failed tool event shows up in the reasoning channel before the retry — cosmetic, not a plugin bug.
- A catalogue is account-derived: TRAE CLI listed 12 models on one internal account, and another
  account or region can list a different set with different config names. The table above is
  evidence, not a contract.
- First-token latency includes a cold process start (2–15s). A note is emitted while it happens.
- A `cli` route has no approval channel: `aiden-claude` ships `--permission-mode acceptEdits`, so
  file edits go through while other gated tools stay denied. Widening it
  (`--dangerously-skip-permissions`) or narrowing it is a deliberate flag in `args` /
  `extraArgs`, and neither DSH's sandbox nor its approval prompt applies to that child.
- A catalogue may list models the plan does not grant; they fail only when selected (now badged).
