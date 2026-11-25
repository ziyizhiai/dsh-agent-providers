# Unknown execution review and recovery workflow

This local follow-up is based on pushed commit f1a02c5. It adds interaction around uncertainty and persistence, not a task retry mechanism.

## User workflow

1. A Stop timeout or uncertain process interruption keeps the original execution marked unknown. Restarted active records are interrupted and require review. The next prompt on that DSH conversation/provider is blocked with REVIEW_REQUIRED until its outstanding records have been reviewed.
2. **Inspect execution evidence** checks only paths reported by edit tools. It verifies workspace containment, regular-file existence and size. It does not run shell commands, query external business systems, restore an agent conversation, or claim the task succeeded. Tools may already have run; no files does not mean no side effects.
3. After reviewing tool details, reported files and any relevant external-system results, the human explicitly chooses **I reviewed it; allow future turns**. This records an acknowledgement separately; unknown/interrupted status, tool states and plan states are not rewritten as successful. Confirmation does not itself start a turn.
4. The next explicit input can start; no previous prompt is resubmitted by the recovery action. Normal DSH transcript handling still applies. Unreviewed uncertainty records are not pruned away merely because newer runs exist; retention can exceed the nominal history count within the storage budget.

## Connection check

The session management panel exposes an explicit connection check. ACP starts/initializes the provider without calling session/new, session/load, catalog, or session/prompt. If configured, normal ACP authentication can be performed during startup; this is not a health check of a particular stored session, model access, inference or external background job. CLI reports recipe-only, not validated executable/login readiness.

## Saving and diagnostics

**Retry saving only** retries state writes without calling any agent. It refuses while active/queued provider work exists. CAS/lock checks stay in force: stale or corrupt files are not overwritten to make the warning disappear. Successful saving does not recover missing historical records or infer task success.

The diagnostic view/export is scoped to the current conversation and built from an allowlist. It includes status/timestamps, model reports, tool identities/types/status, reported result paths and review/persistence information. It excludes conversation text, launch environment, configuration values, raw tool input/output and arbitrary run titles. It is not a complete audit or event-replay archive. Exported paths/status may still be sensitive project information, so the user should review before sharing.

API routes retain loopback peer checks in the host registration, same-origin and client-header checks. Inspect/acknowledge use the same session lock as prompt; diagnostic reads are passive. Actions are not added to the model-facing tool, keeping human acknowledgement human-facing in normal usage. A same-origin client is trusted by the plugin; no stronger human attestation is invented.

## UI improvements and limits

Queue time and execution time are separate. Common lifecycle/config/storage errors have Chinese/English messages; arbitrary agent-provided text remains original. Diagnostic JSON is pure text and downloaded only after the human selects export. Current settings and historical read-only snapshots remain separate.

Review persistence can fail. The UI reports the failure, the original execution outcome is retained, and current-process review information remains available in memory. On restart, an unpersisted acknowledgement may require review again. This is intentionally conservative.

## Tests

`npm run test:recovery` covers no-reexecution, review-before-acknowledge, next-turn gating, restart retention, traversal/symlink boundaries, no-session handshake, CAS save failure, diagnostic scope/redaction and endpoint guards. `npm run test:ui` adds real React recovery and diagnostics interactions. `UI_RECOVERY_FIXTURE=1 npm run probe:ui` adds an explicitly synthetic unknown-result sample for browser validation.

No live vendor inference, automatic account migration, checkpoint rollback, generic question/reply channel, approved-plan executor, backend background-job management, distributed transaction or streaming event subscription was introduced.
