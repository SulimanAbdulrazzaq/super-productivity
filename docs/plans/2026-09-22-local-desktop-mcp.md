# Local desktop MCP for Super Productivity

Implementation plan · 22 September 2026 (revised after a repository review of `2f4c660`)

**Decision:** Add an opt-in MCP endpoint to the running desktop app, served by the existing loopback listener and backed by the same renderer query and command code as the REST API. Ship bounded, read-only access first. Add Inbox capture next. Leave editing out until real usage shows a need.

Companion: `2026-09-22-native-capture-plan.md` (shared capture command only).

---

## 0. What changed versus the first draft, and why

| #   | First draft                                                                                                                | Revision                                                                                                                                                                               | Evidence                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pin the official MCP SDK in Electron main                                                                                  | **No new root dependency.** Build a small, in-repo MCP server that only exposes tools. Adding the SDK needs an explicit maintainer exception.                                          | AGENTS.md "Dependencies" rule. `@modelcontextprotocol/sdk` is in the lockfile only as a transitive **dev** dependency of `@angular/cli`. At runtime it would bring in express, hono, cors, jose, ajv and eventsource.                                                                  |
| 2   | Dedicated endpoint and port                                                                                                | **Reuse the listener in `electron/local-rest-api.ts` at a new path, `/mcp`.** MCP gets its own enable flag and its own credentials.                                                    | That listener already handles Host checks, body/concurrency/timeout limits, `EADDRINUSE`, and keep-alive teardown on disable (#7484). A second port means a second copy of all of that.                                                                                                |
| 3   | stdio "only if a client needs it"                                                                                          | **Expect stdio to be needed for desktop GUI clients.** Plan a bundled stdio→HTTP shim, run with the app's own binary through `ELECTRON_RUN_AS_NODE`. M0 confirms whether it is needed. | GUI clients such as Claude Desktop have historically run local servers over stdio. Their "remote" connectors connect from the vendor's cloud and cannot reach `127.0.0.1`. The RunAsNode fuse is already on (`plugin-node-executor.ts`).                                               |
| 4   | Settings "per installation" (storage not specified)                                                                        | **Keep enablement, grants and verifiers in main-process files under `userData`, like the REST token. Keep them out of `GlobalConfig`.**                                                | `misc.isLocalRestApiEnabled` sits in synced global config and `GLOBAL_CONFIG_LOCAL_ONLY_FIELDS` is empty. Enabling the REST API on one device therefore also turns on the listener on every synced desktop. Main-process storage also avoids any persisted-model or sync-surface cost. |
| 5   | New "dataset generation" concept                                                                                           | **Use the sync `clientId` as the generation.**                                                                                                                                         | Clean-slate and backup import already rotate `clientId` atomically (`clean-slate.service.ts`, `operation-log.effects.ts:241`). No new persisted state.                                                                                                                                 |
| 6   | Cursor pagination tied to generation and query revision                                                                    | **v1 has no cursors.** Filters are required, the limit is capped, and the result says `truncated: true` with a hint to narrow the filter.                                              | Assistants narrow filters readily. Cursors over live in-memory state need revision tracking that nothing else in the app uses.                                                                                                                                                         |
| 7   | New receipt-persistence integration                                                                                        | **The durable boundary is `OperationWriteFlushService.flushPendingWrites()`.** Nothing new is persisted.                                                                               | It already guarantees that the op reached IndexedDB. Sync conflict detection depends on it.                                                                                                                                                                                            |
| 8   | Idempotency ledger kept until the connection retires, even after the task is deleted; writes rejected when storage is full | **Not in v1.** If duplicate captures are actually observed, add a bounded in-memory TTL map (key → taskId).                                                                            | "Hardening needs an observed instance." A duplicate Inbox task is visible and harmless. The draft's ledger grows without bound, and its fail mode is "capture stops working".                                                                                                          |
| 9   | Several named connections in v1                                                                                            | **Leaner option: one MCP credential with scope checkboxes.** Keep the storage shape ready for more connections later. Your call.                                                       | Every added connection adds settings UI. Rotating the one credential revokes everything.                                                                                                                                                                                               |
| 10  | Not addressed                                                                                                              | **Mac App Store build cannot listen.** Exclude the feature there or add `com.apple.security.network.server`. Check Snap `network-bind`.                                                | `build/entitlements.mas.plist` only has `network.client`. Snap plugs are `default` plus a few others and do not list `network-bind`.                                                                                                                                                   |
| 11  | Not addressed                                                                                                              | **Validate the IPC sender** on responses. Today `handleResponse(_event, …)` ignores the sender.                                                                                        | `electron/local-rest-api.ts`                                                                                                                                                                                                                                                           |
| 12  | Not addressed                                                                                                              | **Share query code with the REST API instead of copying it.** Pull projections and filters out of `local-rest-api-handler.service.ts` into a small query service.                      | That service is 993 lines, and the service size cap is 1200. MCP code must not be added to it.                                                                                                                                                                                         |

---

## 1. Does it earn its place?

**Demand.** Two community MCP servers are listed in `community-plugins.json`: SP-MCP (≈120★) and Super-Productivity-MCP (≈81★). Only one issue exists (#4718, closed, no reactions).

**What users can already do.** Community servers run the full REST API through one all-access token. That token can create, update, archive, restore and control the timer. Users also have to install Node themselves.

**What a first-party endpoint adds that community servers cannot:**

- scoped credentials, so a client can have read-only or capture-only access instead of full CRUD
- no Node install
- bounded, content-minimal responses
- a supported setup UI

If those four points are not wanted, the leaner alternative is to leave MCP to the community and only add scopes to REST tokens. **Recommendation: build it, limited to read access and capture.**

**Alternatives rejected:**

- **An MCP plugin.** Plugin Node scripts are single calls with a timeout (maximum 5 min). They cannot host a long-lived server, and plugins cannot hold scoped credentials.
- **A headless or second state engine.** It would break the renderer-authority invariant below.

## 2. Product scope

| Topic        | Decision                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Host         | Electron desktop only (not the MAS build unless its entitlement is added)                                                  |
| Availability | SP running, renderer alive (tray and minimized are fine, because `backgroundThrottling: false`)                            |
| v1           | Read task summaries, a single task, projects and tags                                                                      |
| v2           | Capture Inbox tasks through the shared capture command                                                                     |
| Later        | Specific edits, each behind its own grant                                                                                  |
| Network      | `127.0.0.1` only, on the existing REST listener                                                                            |
| Privacy      | No SP-operated service involved. Setup states once that a cloud-hosted assistant sends tool results to its model provider. |

## 3. Architecture

```
MCP client ──HTTP /mcp──┐
                         ├─ electron/local-rest-api.ts listener (Host/Origin/limits)
stdio shim ──HTTP /mcp──┘        │
                          electron/mcp/ (JSON-RPC, auth, scope check)
                                 │ typed IPC (sender-validated)
                          renderer: AssistantQueryService / capture command
                                 │
                          NgRx store → op-log → IndexedDB → sync (unchanged)
```

- **The renderer stays the authority.** No reducers in Node, no second DB, and no action names or reducer payloads cross IPC. The bridge carries a closed union of `{tool, validatedArgs}` only.
- **`electron/mcp/`** (new): protocol handling, credential verification, scope enforcement, and the stdio shim entry point.
- **`src/app/core/assistant-access/`** (new): read projections and filters, pulled out of the REST handler so REST and MCP share them. Readiness uses `getIsAppReady()` plus `HydrationStateService.isInSyncWindow()`.
- **`electron/shared-with-frontend/mcp.model.ts`**: IPC request, response and error-code types.

### Minimal protocol implementation (instead of the SDK)

The server is tools-only and stateless, using Streamable HTTP with JSON responses:

- **`POST /mcp`** handles JSON-RPC:
  - `initialize`: negotiate `protocolVersion` against the pinned supported list. If the client's requested version is supported, echo it. Otherwise return the newest supported version.
  - `notifications/initialized` and other notifications: `202`.
  - `ping`.
  - `tools/list`: only tools the credential is granted.
  - `tools/call`: returns `structuredContent` plus a text fallback.
- **`GET` and `DELETE /mcp`**: `405`, because there is no SSE stream and no session.
- **Batches**: reject JSON-RPC batch arrays, unless a pinned protocol version requires them.
- **`MCP-Protocol-Version` header**: validate it on requests after `initialize`.

This is roughly a few hundred lines. It is tested with unit tests (`electron/mcp/*.test.cjs`), MCP Inspector, and the M0 reference clients. Record the supported protocol versions in code and in the client matrix.

**If the maintainer grants a dependency exception,** swap in the SDK behind the same module boundary. Nothing else changes.

### stdio shim

`electron/mcp/stdio-shim.ts` is bundled with the app and started by the client with the SP binary and `ELECTRON_RUN_AS_NODE=1`. It reads newline-delimited JSON-RPC from stdin, POSTs each message to `http://127.0.0.1:<port>/mcp` with the bearer token taken from an env var, and writes the responses to stdout.

- It holds no state and runs no daemon.
- If SP is not running, it returns a JSON-RPC error saying "Super Productivity is not running".
- The setup UI generates the exact config snippet for each platform, including binary paths with spaces and the macOS `.app/Contents/MacOS` path.

## 4. Local settings, credentials, permissions

- **Storage.** Use a 0600 file in `userData`, and reuse the token-file helpers in `local-rest-api.ts`: mode verification, atomic rename, dir fsync, fail closed. The file holds `{enabled, connections: [{id, name, verifierHash, scopes[], clientIdAtCreation, createdAt}]}`. **Never in GlobalConfig.** It is not synced and not exported.
- **Credential.** 32+ random bytes, shown once. Store a SHA-256 verifier and compare in constant time. Rotating replaces the verifier. The credential goes only in the client's header or env config, never in URLs or argv.
- **Scopes** (all unchecked by default; the persisted set is explicit, and there is no wildcard):

| Scope              | Allows                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `tasks:read`       | Title, isDone, dueDay/dueWithTime, deadline, projectId, tagIds, time estimate/spent; project and tag id+title |
| `tasks:read_notes` | Notes via `get_task` (requires `tasks:read`)                                                                  |
| `tasks:capture`    | `create_task` only. Returns the new id only. Never reveals existing data.                                     |

- **Revocation.** Persist first, then update the in-memory set, then close open sockets (`closeAllConnections`, as on disable). Scopes are checked again after the body is read and again immediately before dispatch, following the existing "re-check after body" pattern.
- **Generation binding.** Store `clientId` at creation. If the current `clientId` differs (clean slate or backup import), return `CONNECTION_STALE` and have the user re-confirm in settings.
- **Setup UI** (Settings → Misc, next to the REST API): enable toggle, scope checkboxes, credential reveal/rotate, a copy-config snippet for each supported client, "Test connection", and status (listening, port conflict, storage failure, renderer not ready). Follow the TRANSLATING rules for strings, and add user docs per `docs/documentation-guide.md`.

## 5. Tool catalogue (v1 + v2)

| Tool                          | Input → result                                                                                        | Scope                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| `get_status`                  | → `{ready, apiVersion, grantedScopes}`. No task data, no counts.                                      | any                           |
| `list_tasks`                  | `{query?, projectId?, tagId?, includeDone?=false, limit?≤100 (default 50)}` → summaries + `truncated` | `tasks:read`                  |
| `get_task`                    | `{id, includeNotes?}` → one projection; notes capped (e.g. 8 KB) with `notesTruncated`                | `tasks:read` (+ `read_notes`) |
| `list_projects` / `list_tags` | → id+title, capped                                                                                    | `tasks:read`                  |
| `create_task` (v2)            | `{title ≤ 500 chars, notes? ≤ 8 KB}` → `{id, created: true}`                                          | `tasks:capture`               |

- Reads cover active tasks only: no archive, attachments, timer or bulk.
- Total response size is capped (e.g. 256 KB).
- Unknown input fields fail with `INVALID_INPUT` (typia, as the REST handler does).
- A single error catalogue is used. Error text never contains task content. A client without `tasks:read` never gets an error that confirms whether an id exists.

## 6. Read consistency and untrusted content

- Every result carries `{readAt, instanceId (non-secret), lastSyncAt?}` and makes no claim of account-wide freshness.
- Return `APP_NOT_READY` when `!getIsAppReady()` or `isInSyncWindow()`. Never read half-hydrated state.
- Titles and notes are data. They are returned only inside tool results, never in tool descriptions or `instructions`, and never logged (sync rule 9).
- Prompt-injection fixtures in titles and notes must not change server behavior. The server has no content-driven actions to begin with.

## 7. Capture (v2)

Use the shared capture contract with native capture:

- Title and notes are literal.
- The task goes to the Inbox backlog. No project, tag or Today membership comes from the current view.
- Task defaults apply.

The command dispatches through the normal service path, awaits `OperationWriteFlushService.flushPendingWrites()`, and only then returns `created`. "Created" means durable locally. It does not mean uploaded.

- The endpoint is up but the renderer is gone: `APP_UNAVAILABLE`.
- SP has quit: connection refused, or the shim error.
- No background queue is added.
- A lost response after dispatch may already have committed. The error says "may have been created; check before retrying". Add an idempotency key only if duplicates are observed (see §0 #8).

## 8. Security acceptance criteria

- **Listener.** Bind `127.0.0.1` only. Allow Host from the existing allowlist. **Reject any Origin header for `/mcp`, including `null`.** No CORS.
- **Auth.** Bearer is required on every `/mcp` request. Scopes are checked on list, on call, after the body is read, and before dispatch.
- **Limits.** Reuse the body, concurrency and timeout limits. Add a per-credential rate limit and a response-byte cap.
- **IPC.**
  - Accept MCP responses only when `event.sender === getWin().webContents` and the sender is the main frame. Correlate by requestId.
  - On renderer reload or crash (`render-process-gone`, `did-start-navigation`), fail pending requests.
  - Apply the same sender check to the existing REST response handler in a separate small PR.
- **Logs.** No credentials, titles or notes. Stable public error codes, with no raw exception messages. The REST handler currently forwards `error.message`; MCP must not.
- **Local-only.** Nothing here syncs. Fixing the synced `isLocalRestApiEnabled` toggle is a separate follow-up, not part of this plan.
- **Packaging.** MAS is excluded or gets the entitlement. Snap `network-bind` is verified on a real install.

## 9. Milestones

| Milestone                   | Deliverable                                                                                              | Exit                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** client spike (≈days) | `/mcp` with `initialize`, `tools/list` and `get_status`, a hard-coded dev credential, and the stdio shim | Claude Code (HTTP), Codex (HTTP) and one GUI client (probably via the shim) connect. Protocol versions and GUI transport are recorded. Decide whether an SDK exception is needed. |
| **M1** read seam            | `AssistantQueryService` pulled out of the REST handler, projections, limits, readiness                   | REST tests still pass. Projections have unit tests. No raw store objects are returned.                                                                                            |
| **M2** access control       | Main-process settings file, credential, scopes, revocation, IPC sender check, settings UI                | Unauthorized, revoked and capture-only callers cannot read. Settings survive restart. Nothing appears in the op-log.                                                              |
| **M3** read release         | Full read catalogue, docs, client matrix                                                                 | Real-client queries plus lifecycle checks (tray, reload, quit, port conflict) on macOS DMG, Windows and Linux (AppImage/deb, Snap, Flatpak)                                       |
| **M4** capture              | `create_task` on the shared capture command plus flush                                                   | Crash before and after flush, capture-only isolation, stale clientId                                                                                                              |
| **M5** editing              | Separate proposal                                                                                        | Only after M3/M4 usage shows a need                                                                                                                                               |

M1 can start in parallel with M0. M4 depends on the shared capture command from native N1, but not on its journal.

## 10. Verification

- **Unit tests.** `electron/mcp/*.test.cjs` (protocol, auth, origin, scopes, limits, sender check) and `assistant-query.service.spec.ts` (projections, filters, truncation, readiness).
- **Manual.** Run each client from the matrix, MCP Inspector, and the stdio shim on each OS.
- **Regression.** `local-rest-api.test.cjs` and the REST handler spec stay green after the query code moves out.

## 11. Open questions for the maintainer

1. Grant an SDK dependency exception, or build it in-repo (recommended)?
2. One credential in v1 (recommended) or several named connections?
3. MAS: exclude, or add `network.server` and accept App Review risk?
4. Should the REST API's synced enable flag be moved to local storage in a separate PR?

## Sources

- MCP spec: Streamable HTTP transport, tools, lifecycle/version negotiation. Revalidate the current protocol revision in M0; the first draft cited `2026-07-28`, which this review did not verify.
- Claude Code and Codex MCP configuration docs. Check GUI clients' current local-server support in M0.
- Repo: `electron/local-rest-api.ts`, `src/app/core/electron/local-rest-api-handler.service.ts`, `src/app/op-log/sync/operation-write-flush.service.ts`, `src/app/op-log/apply/hydration-state.service.ts`, `src/app/imex/sync/sync.const.ts` (`GLOBAL_CONFIG_LOCAL_ONLY_FIELDS`), `build/entitlements.mas.plist`, `electron-builder.yaml`, `electron/plugin-node-executor.ts`.
