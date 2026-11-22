# dsh-agent-providers

**English** | [中文](README.zh.md)

Register a third-party coding agent — **OpenCode**, Claude Code, Codex, Gemini CLI, or anything
that speaks the [Agent Client Protocol](https://agentclientprotocol.com) — as a **model provider
group** in DeepSeek Harness. Its models appear in the picker under their own heading, exactly like
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

A strip under the composer also lists the agent's stored conversations and marks the one the
open conversation is bound to.

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
`delete` really removes it. Capabilities come from what the agent advertises — OpenCode has no
`sessionCapabilities.delete`, so no delete button appears for it.

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
the agent runs its own tools and the harness's approval and sandbox do not apply. Every model of an
agent route therefore carries a badge — `LlmModelInfo.badge`, which the picker already renders as
a tag. No client code involved. Override per route:

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

Three sources, highest first:

1. the model's own `contextWindow` under `models:`
2. the `usage_update.size` the agent reports at runtime (honoured when present)
3. the route's `defaultContextWindow`
4. the 200 000 fallback

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
| `preset` | — | `opencode` / `claude-code` / `codex` / `gemini` / `cli-jsonl` |
| `transport` | `acp` | `acp` or `cli` |
| `command` / `args` | — | how to start the agent |
| `env` | `{}` | literal child environment, highest precedence |
| `credentials` | `{}` | child variable → credential. A bare ref injects the secret; `{ ref, template }` fills `{value}` into a template |
| `cwd` | the session's cwd | working directory override |
| `permission` | `allow` | auto-approve the agent's permission requests, or `reject` |
| `continuity` | `auto` | `resume` sends only new input; `replay` replays the transcript; `auto` follows the transport |
| `eventTimeoutMs` | 600000 | idle bound between two agent events in one prompt |
| `connectTimeoutMs` | 120000 | spawn + initialize + session creation bound |
| `idleReleaseMs` | 600000 | release a warm process after this idle |
| `catalog` | `auto` | `auto` / `probe` (probe + overrides) / `declared` |
| `models` | `[]` | model table / overrides |
| `defaultContextWindow` | `200000` | window for models that declare none |
| `defaultMaxTokens` | — | output cap for models that declare none |
| `badgeText` / `badgeTone` | `Agent` / `info` | the picker tag |
| `showToolActivity` | `true` | fold tool activity into the reasoning channel |
| `exposeTool` / `toolName` | `true` / `agent_sessions` | the global session tool |
| `maxReplayChars` (top level) | 400000 | replay truncation, oldest first |

## Key design decisions

1. **Never emit `tool-call-delta`.** The agent owns its tools; a tool call here would make the
   harness execute the agent's internal tools. Tool activity is folded into the reasoning channel.
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

## Verification

```bash
npm test        # 92 tests, ~3s
```

Coverage: transport conformance (one suite runs against ACP and CLI), the adapter (chunk pairing,
no `tool-call-delta`, resume/delta, drift → replay, serialization, usage mapping, badge, image
forwarding, cold-start note validated against the real `BlockAssembler`), session administration,
the HTTP surface (headers, origin, peer, argument bounds), the tool, config resolution, the
scrubbed environment, and the pure render helpers.

`test/fake-agent.mjs` is a real ACP agent over stdio and `test/fake-cli.mjs` is a real child
process, so the protocol layer is not mocked.

### Measured live

| Scenario | Result |
|---|---|
| Real inference (no env var, no `auth.json`) | ✅ `OK`, `end_turn`, real usage |
| Two turns (resume + delta only) | ✅ second turn answers correctly, binding not rebuilt |
| `session/fork` + rebind | ✅ new session, both in the agent store, branch inherits history |
| A model the plan denies | ✅ `Model access is disabled`, catalogue marks it `no access` |
| An image through the adapter | ✅ the model read the screenshot |
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
├── test/                 # 92 tests, runs in CI
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
| `probe-context.mjs` | read the live profile, print resolved window / modalities / badge |

## Before publishing

| Item | Status |
|---|---|
| CI | `npm install && npm test` works from `devDependencies`; no local DSH needed |
| Version policy | ACP SDK pinned at `1.4.0` (matches the DSH tree); moving to 2.x needs ACP v2 work |
| `README.i18n.yaml` | Official bundles carry a heading-hash pairing record produced by their own `verify-translation-pairing` tool. Not shipped here rather than hand-writing hashes that would only look authoritative |

## Known gaps

| Gap | Notes |
|---|---|
| Tool schemas are metered | The panel's `工具 9.6K` counts schemas the agent never receives. `tools.restrict` requires an agent scope and `agent/pre-step` carries no tool set, so a plugin cannot suppress them |
| Managed subprocess | The plugin spawns and scrubs itself; `ctx.subprocess.spawn` would additionally give managed-range teardown |
| No concurrency cap | One process serves a route+cwd; several conversations may prompt at once and the agent queues them |

## Risks

- The agent uses its own permission model, so **the harness's approval and sandbox do not apply**.
  Use `permission: reject` plus the agent's own read-only flags, or accept full access deliberately.
- First-token latency includes a cold process start (2–15s). A note is emitted while it happens.
- A catalogue may list models the plan does not grant; they fail only when selected (now badged).
