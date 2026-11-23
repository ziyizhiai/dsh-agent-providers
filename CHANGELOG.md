# Changelog

## Unreleased

- **Docs: an agent as a subagent** — a new README section separates the two seams: a route is a
  *model* a child agent can use (`subagent-model-selection-settings.allowedModels`), while making the
  agent the *subagent backend* is `@deepseek-ai/dsh-subagent-acp` (config only, two loader rows).
  Documents the two traps — `maxDepth: 'provider-managed'` is mandatory for a backend that enforces
  no depth budget, and the backend's `@deepseek-ai/dsh-*` peers are not installed by a pnpm-hoisted
  profile — plus what a subagent run does **not** inherit (fresh process and session, `allow`/`reject`
  permissions answered by the backend with no human prompt, no harness metering or model choice).
- **Aiden Claude** — the `aiden-claude` preset registers the company-internal Aiden launcher
  (`aiden x claude`, Aiden 2.0.6 / Claude Code 2.1.328) as a `cli` route behind the
  `aiden-aiproxy.bytedance.net` gateway. Models are the gateway's own
  (`aiden x models --claude --json`, 7 seen; each `context_length` is the authoritative window),
  continuity is Claude Code's own session id plus `--resume`, and Aiden's own ByteCloud sign-in is
  reused with no credential mapped. Print mode denies gated tools by default, so the preset ships
  `--permission-mode acceptEdits`; a `cli` route has no approval channel, so widening it is a
  deliberate `args`/`extraArgs` choice. No `list`/`fork`/`delete`, a model change starts a new
  session with replay, and there is no image input.
- **CLI catalogue command** — a `cli` recipe can ask a command for its live model catalogue
  (`catalogCommand`), map each entry (`catalogJson.entries`/`id`/`name`/`contextWindow`), and bound
  the call with `catalogTimeoutMs` (default 20 s). A recipe without it keeps the declared `models:`
  as its catalogue, so no other preset changes.
- **Cache-token usage on CLI routes** — `jsonl.usage` gains optional `cacheRead`/`cacheWrite`
  paths, reported as disjoint `cacheReadTokens`/`cacheWriteTokens`. Claude Code already reports
  uncached input, so `aiden-claude` needs no `inputTokensIncludeCache` adjustment.
- **TRAE CLI** — the `traex` preset (`traex acp serve`) registers the company-internal coding
  agent through its own ACP server. It ships its own `~/.trae` sign-in (or an enterprise PAT via
  `TRAECLI_PERSONAL_ACCESS_TOKEN`), publishes four session config options (`model`, `mode`,
  `collaboration_mode`, `reasoning_effort`), and reports `usage_update`, so a stale context window
  is corrected at runtime.
- **Disjoint usage** — a new optional `inputTokensIncludeCache` agent field (default `false`) says
  the agent folds cached tokens into `inputTokens`; the ACP transport then subtracts
  `cachedReadTokens` + `cachedWriteTokens` so the harness's counts stay disjoint. The `traex`
  preset ships it; existing agents are unchanged.
- **OpenCode v2 preset** — `preset: opencode2` targets the v2 binary (`opencode2 acp`, 2.3.2). It is a
  different program from `opencode` 1.x: it signs in through its own
  `~/.local/share/opencode/auth.json`, so no credential is mapped (and it works where `preset: opencode`
  fails for a missing `CUSTOM_OPENCODE_API_KEY`), its usage is already disjoint (no
  `inputTokensIncludeCache`), it lists 49 provider-qualified models, and it sends `usage_update`. It also
  sends `session/request_permission` (allow once / always / reject, target path as the tool title) once its
  own `permission` config asks — verified end to end: approve wrote the file, reject ended the turn.
- **Approval routing on every ACP preset** — `opencode`, `claude-code`, `codex`, `gemini` and
  `traex` all ship `permission: ask` now, so an agent's own permission question reaches the harness
  approval prompt instead of being auto-approved. The plumbing is one generic transport path; the
  per-route field still selects `allow`/`reject`, and a hand-written route keeps the `allow` default.
  OpenCode definitely asks (its ACP server calls `connection.requestPermission` and answers `reject`
  when the client offers neither).
- **Approval routing** — `permission` gains `ask`: an agent's own permission request goes through
  the harness approval service, so it reaches the same prompt a tool call uses with the agent's
  `reason` and a localized `displayReason`. A rejection — or the absence of an approval channel —
  fails closed, never silently granting, and the failure names the tool (`APPROVAL_REJECTED`,
  `APPROVAL_DISMISSED`, `APPROVAL_UNAVAILABLE`, `APPROVAL_DENIED`; `ABORTED` stays for an
  agent-initiated cancel). The `traex` preset ships `ask`.
- **Catalogue context windows** — a new `contextWindowMetaPath` agent field reads each model's
  advertised window from a catalogue entry's `_meta` (e.g. `trae.contextWindow`), and `resolveModel`
  hydrates the catalogue itself when no window is known yet — so even a headless run that never
  lists models is metered correctly from the start. Precedence: profile-declared → runtime
  `usage_update` → catalogue `_meta` → route default → 200 000 fallback.
- **Optional-service wiring** — `approval`, `agents`, `attachments`, `credentials`, `profileContext`,
  `subprocess`, and `workingDirectory` are attached through `ctx.inject` instead of read ad hoc. A
  cordis fiber only sees its injected services, so they previously all read as absent: preset
  credentials never resolved, images never loaded, the cwd fell back to the process directory, and
  approval was dead by default.
- **DSH compatibility floor** — `engines.dsh` widened to `>=0.2.2-rc.1 <0.3.0-0` (peers
  `^0.2.2-rc.1`). The narrower floor made DSH on the installed `0.2.2-rc.1` silently disable the
  provider row (`disabling profile plugin row "llm-agent-providers" … incompatible` → `NO_ADAPTER`);
  the row now mounts and a real headless turn answers, with no version exemption.
- **Breadcrumbs** — an id-shaped tool title (`call_00_…`) falls back to the ACP kind, so the
  reasoning channel shows `→ Editing files` instead of `→ call_00_…`, and the cold-start note sits
  on its own line.

## 0.1.0

First public release.

- **Provider groups** — an ACP agent becomes a model-provider group in the picker; models are
  discovered from the agent or declared, and each carries a configurable badge.
- **Two transports** — `acp` (official SDK, one process serving many sessions) and `cli`
  (configure-driven, for agents without ACP). Both satisfy one contract, checked by one
  conformance suite.
- **Credential reuse** — child variables are filled from harness credential refs, either directly
  or through a `{value}` template for agents that read a JSON credential document. The child
  environment is scrubbed of credential-shaped and `DSH_*` names first.
- **Session management** — inventory, fork-and-rebind, close, and delete over a sidebar strip, an
  HTTP surface (loopback-only, header-guarded), and a model tool.
- **Continuity** — resume with a drift check that falls back to a full replay, so compaction and
  forks never feed an agent the wrong history.
- **Context windows** — declared per model, learned from `usage_update`, or defaulted per route,
  instead of silently metering every model at 200k.
