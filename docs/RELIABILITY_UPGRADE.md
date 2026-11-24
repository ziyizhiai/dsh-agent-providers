# Production reliability and interaction follow-up

This follow-up builds on commit 738ca33. Runtime remains JavaScript ESM and ACP SDK 1.4.0; the external agent owns all tool execution. No parallel provider architecture, fabricated host tool calls, or automatic permission escalation was added.

## Implemented

- Runtime capabilities control image advertisement and session close. A static catalogue remains text-only before the backend is known; the host attachment reader must actually be available. `resume` advertised independently of `loadSession` uses the actual resume method.
- Model selection precedes dependent session options. Only returned config or standard config notifications confirm `currentValue`; an empty RPC acknowledgement never locally writes the requested value. `configWaitMs` bounds delayed confirmation (default 1000 ms). A backend model literally named `default` remains valid; the internal fallback uses `__dsh_backend_default__`.
- Missing ordinary options defer until a standard `config_option_update`; if absent by turn end they are reported as unapplied. Missing mode/permission/approval/sandbox options fail before execution. Only SDK-supported select/boolean config types are editable; boolean requests include the protocol's required type discriminator. Numeric or arbitrary custom types are not pretended to work.
- Session administration and prompts use the same conversation lock. Queued work counts as busy. Active ownership is maintained in memory even while the durable binding is invalidated; acquisition cannot replace a live handle.
- Stop enters `cancelling`. A timed-out shared-process Stop or unconfirmed prompt failure marks affected executions `unknown`, reports process interruption to sibling sessions, discards the process and does not automatically resubmit a prompt. Acknowledged cancellation remains cancelled. This does not roll back already executed tools or prove grandchildren/background jobs ended.
- Central sanitization covers structured records, JSON strings, titles, credential-shaped flags, bearer strings, errors, launch stderr, and previews. Resolved sensitive environment values are removed from diagnostics. Ambient AUTH/CREDENTIAL variables are not inherited. Native HOME login remains shared unless a user intentionally configures separate agent account storage.
- Launch diagnostics rotate at 256 KiB with one retained previous log. Lines remain valid JSON; instance-local writes are serialized.
- Warm processes and durable bindings carry an opaque credential/config generation. Changing a mapped credential invalidates the old process and binding. `accountScope` is an explicit native-account epoch for accounts whose identity is not exposed by the backend. No auth files, HOME contents, or passwords are copied or migrated.
- Live expanded tool details refresh by revision. Slow inventory does not block state rendering; quiet polling does not cancel explicit probes. A collapsed visible panel performs passive discovery (5 seconds when idle), never creates a backend session, and suppresses requests while hidden. Active clocks advance independently of event arrival and exclude route queue time once execution starts.
- Current session options are separate from immutable historical turn configuration. History is read-only; configuration changes persist in the actual current binding.
- Activity snapshots are deep detached copies. Each state file has local lock + fingerprint compare-and-swap writes and uniquely named temporary files. Stale instances fail rather than overwrite another writer. This is conflict prevention, not multi-writer merging or distributed storage.
- Malformed history/binding files are preserved and ignored for continuation; new records remain in memory with a persistence warning. Completion and persistence are independent: saving failure does not convert completed execution into an execution error or trigger a retry. Binding and activity files are not an atomic cross-file transaction.

## Configuration and operations

Use a separate absolute `stateDirectory` per DSH profile/process. No trustworthy profile identity is invented if the host omits it. `agents.<route>.accountScope` can be changed after an intentional native-account switch; it is not a credential and does not select an account. Existing configurations continue to work, except invalid direct values now fail validation.

If state is corrupt or conflicts with another process: stop the competing writer, preserve the original state files for inspection, and use a new profile-private stateDirectory. Do not rerun side-effecting tasks to repair UI history. Launch logs are best-effort and sanitized, not an exhaustive audit archive; sanitization cannot identify every arbitrary secret embedded in free-form text.

## Custom ACP onboarding SOP

1. Use an isolated profile and explicit cwd/stateDirectory. Start with reject or host-backed ask permissions appropriate to the test; do not borrow production secrets for a synthetic fixture.
2. Observe initialize and session/new using the pinned SDK. Record actual image, load/resume, list/fork/close/delete support and session model selector; never set a preset capability true merely because a method name exists.
3. Verify a requested model through config response/notification. Apply non-model options after model choice; test missing/late selectors and boolean types. Explicit safety intent must be honored before prompt.
4. Run normal, delayed, cancelled, silent, crashed and shared-session scenarios. Verify old requests are not reused after unknown execution, and output cannot feed another tool execution.
5. Exercise current/history config, live details, stale responses, refresh failure, text preview and process restart. Treat file existence separately from functional correctness.
6. Run `npm ci`, `npm test`, `npm run test:package`; use `probe:host` with a compatible DSH binary and `probe:ui` with test-only React UMD resources. Fixtures use standard protocol frames and are labelled synthetic; no vendor inference claims are made.

## Boundaries

No generic question/answer reply, plan approval execution gate, native chat cards, checkpoint rollback, cross-device stream replay, backend background-job management, or automatic account isolation was added. These require actual host/backend contracts. CI config covers Node 22/24 on Linux/macOS, but a workflow definition alone is not proof all remote CI jobs ran. Browser and compatible DSH smoke use synthetic ACP, not paid vendor inference or the user's live profile.
