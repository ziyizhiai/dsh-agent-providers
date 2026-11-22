# Changelog

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
