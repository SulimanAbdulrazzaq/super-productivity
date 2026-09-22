# Local desktop MCP for Super Productivity

Implementation plan · 22 September 2026 · rev. 3. Checked against `2f4c660`/`6093901`, and against the MCP spec repository as of 2026-09-22.

**Decision.** Add an opt-in MCP endpoint to the running desktop app. It is served by the existing loopback listener and uses the same renderer query and command code as the REST API. The MCP handler is small and built in-repo, with no new dependency. There is one credential with explicit scopes. Bounded read access ships first, Inbox capture second. Editing waits until real usage shows a need.

Maintainer decisions (2026-09-22):

- Build the server in-repo instead of adding the SDK.
- One credential in v1.
- Add `network.server` to the Mac App Store build (see §9).

Companion: `2026-09-22-native-capture-plan.md` (only the shared capture command).

---

## 0. Changes from the first draft

"Verified" means a second, independent pass checked it.

| #   | First draft                                              | This plan                                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pin the official SDK                                     | **Build a small tools-only handler in-repo that serves both spec eras** (§3).                                                                                 | The AGENTS.md dependency rule. `@modelcontextprotocol/sdk@1.30.0` is only in the lockfile as a transitive dev dependency of `@angular/cli`. At runtime it needs 17 hard dependencies (express, hono, cors, jose, ajv, …). **Neither SDK 1.30 nor 2.0 implements the current spec revision 2026-07-28 yet**, so the SDK would not save the compatibility work.                                                                                 |
| 2   | Separate endpoint and port                               | **Put `/mcp` on the listener in `electron/local-rest-api.ts`, with its own enable flag and credential.**                                                      | That listener already has the Host allowlist, body and timeout limits, `EADDRINUSE` handling and keep-alive teardown (#7484). Verified.                                                                                                                                                                                                                                                                                                       |
| 3   | Add stdio only if a client needs it                      | **stdio is needed for Claude Desktop. Distribute it as a `.mcpb` Desktop Extension (Node type) that Claude Desktop runs, not by re-running SP's own binary.** | Claude Desktop's config accepts only stdio entries. Custom connectors connect from Anthropic's cloud and cannot reach localhost. Re-running SP's binary with `ELECTRON_RUN_AS_NODE` breaks on Linux: `superproductivity` is a shell wrapper (`tools/afterPack.js`), and under Snap on Wayland it injects `--ozone-platform=x11`, which Node rejects. It is also fragile on AppImage, the Windows portable build, appx, Snap, Flatpak and MAS. |
| 4   | Settings storage not specified                           | **Store settings in a 0600 file in main-process `userData`, never in `GlobalConfig`.**                                                                        | `misc.isLocalRestApiEnabled` is synced; `GLOBAL_CONFIG_LOCAL_ONLY_FIELDS` is dead code (all comments, no references). See §10.                                                                                                                                                                                                                                                                                                                |
| 5   | "Dataset generation" (rev. 2 used `clientId` as a proxy) | **Drop it, and drop `CONNECTION_STALE` with it.**                                                                                                             | `clientId` rotates on clean slate and backup import, but **not** on remote snapshot hydration, USE_REMOTE force-download or a remote SYNC_IMPORT. It is not a sound proxy. The credential holder also doesn't change when the data does, so the check gives no security.                                                                                                                                                                      |
| 6   | Cursor pagination                                        | **No cursors in v1.** Require filters, cap the limit, and return `truncated: true`.                                                                           | Assistants narrow queries well. Cursors over live state would need revision tracking that doesn't exist.                                                                                                                                                                                                                                                                                                                                      |
| 7   | New receipt persistence                                  | **Use `OperationWriteFlushService.flushPendingWrites()` plus an explicit success check** (§7).                                                                | The flush also resolves when a write **failed**: the effect decrements the pending count in a `finally`, and `markUnrecoveredPersistFailure()` is the only signal (`operation-log.effects.ts:152-163`). Verified.                                                                                                                                                                                                                             |
| 8   | Unbounded idempotency ledger                             | **Leave it out of v1.** Add a bounded in-memory TTL map only if duplicate captures are actually observed.                                                     | Rule: hardening needs an observed instance. A duplicate Inbox task is visible and harmless.                                                                                                                                                                                                                                                                                                                                                   |
| 9   | Several named connections                                | **One credential with scope checkboxes.** Keep the file shape ready for a list later.                                                                         | Maintainer decision.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 10  | (missing)                                                | **Readiness is `DataInitStateService.isAllDataLoadedInitially$` plus `!isApplyingRemoteOps()`, not `getIsAppReady()` or `isInSyncWindow()`.**                 | `getIsAppReady()` turns true in the `AppComponent` constructor, before data loads, and never resets on reload. `isInSyncWindow()` stays open for the whole sync, including up to 90 s of provider I/O, so reads would fail on every sync. Verified.                                                                                                                                                                                           |
| 11  | (missing)                                                | **Reject unknown input with `typia.validateEquals`.**                                                                                                         | The REST handler silently drops unknown keys (`pickAllowedFields`), and `typia.validate` accepts extra properties.                                                                                                                                                                                                                                                                                                                            |
| 12  | (missing)                                                | **Share read projections with REST by extracting them from `local-rest-api-handler.service.ts`.**                                                             | That file is 993 lines; `max-lines` for services is 1200 (error).                                                                                                                                                                                                                                                                                                                                                                             |
| 13  | (missing)                                                | **Mac App Store: add `network.server`** (§9). **Snap: add the `network-bind` plug explicitly.**                                                               | A sandboxed listener fails with EPERM without the entitlement, so the REST API is almost certainly broken on MAS today (inferred from config; not observed). electron-builder's default Snap plugs do not include `network-bind`. Today, listening may only work because `browser-support` allows it, which core24 drops.                                                                                                                     |
| 14  | rev. 2 security extras                                   | **Moved to "Known gaps"** (§8): IPC sender check, per-credential rate limit.                                                                                  | No observed attack path. Only the main window loads `preload.js`, and request IDs come from `randomUUID()`.                                                                                                                                                                                                                                                                                                                                   |

## 1. Does it earn its place?

**Demand.** There are two community MCP servers in `community-plugins.json`: SP-MCP (≈120★, a plugin plus an external server process) and Super-Productivity-MCP (≈81★). There is one closed issue, #4718, with no reactions.

**What only first-party can do:**

- **Scoped credentials.** Today the only token grants full CRUD, archive and timer control.
- **No Node install** for HTTP clients.
- **Bounded, content-minimal responses.**
- **A supported setup UI.**

**Alternatives considered:**

- **Scopes on REST tokens, leave MCP to the community.** This is leaner, but users would still need Node and a third-party server.
- **Plugin-hosted.** A plugin's Node scripts are single calls capped at 5 minutes, so it cannot own a listener.
- **Headless engine.** Rejected: it would break renderer authority.

## 2. Scope

| Topic        | Decision                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Host         | Electron desktop: DMG, MAS, Windows, Linux                                                                                       |
| Availability | SP must be running with data loaded. Tray or minimized is fine: `backgroundThrottling: false`, and close-to-tray only `hide()`s. |
| v1           | Read task summaries, a single task, projects and tags                                                                            |
| v2           | Capture into the Inbox via the shared capture command                                                                            |
| Network      | `127.0.0.1` only, bound explicitly (not `localhost`)                                                                             |
| Privacy      | No SP-operated service. Setup tells the user once that a cloud assistant sends tool results to its model provider.               |

## 3. Architecture

```
HTTP clients (Claude Code, Codex, Cursor, VS Code) ─┐
Claude Desktop → SP .mcpb (Node shim, stdio→HTTP) ──┴─ POST 127.0.0.1:3876/mcp
                         electron/local-rest-api.ts listener (Host/Origin/limits)
                         electron/mcp/ (protocol, credential, scopes)
                               │ typed IPC: closed union {tool, args}
                         renderer AssistantQueryService / capture command
                               │
                         NgRx → op-log → IndexedDB → sync (unchanged)
```

The renderer remains the authority. The design adds no reducers in Node and no second database. Action names and reducer payloads never cross IPC.

### Protocol handler (dual-era, tools-only, stateless)

Spec revision **2026-07-28** is current, and it broke compatibility: `initialize`, `ping`, sessions and the GET stream are gone. It adds a required `server/discover` method, per-request `_meta` protocol version, required `Mcp-Method` and `Mcp-Name` headers, and `resultType`. Official SDKs and most clients still speak **2025-11-25**, and the spec allows serving both eras on one endpoint.

**Legacy era (2025-11-25):**

- `initialize`: echo a supported version, otherwise return the latest.
- `notifications/*`: respond `202`.
- `ping`, `tools/list`, `tools/call`.
- Validate `MCP-Protocol-Version` on later requests.
- Batches: reject them (batching was removed in 2025-06-18).

**2026-07-28 era:**

- `server/discover`, `tools/list` (with `ttlMs` and `cacheScope`), `tools/call`.
- Validate the `Mcp-Method` and `Mcp-Name` headers against the body (400, `-32020`).
- An unsupported version returns 400 (`-32022`); an unknown method returns 404 (`-32601`).

**Both eras:**

- `GET` and `DELETE` on `/mcp` return `405`.
- Any Origin header, including `null`, returns `403`.
- Results carry `structuredContent` plus a text fallback.

**M0 decides whether the 2026 branch ships in v1**, based on what the target clients actually send. Keep version handling in one module so the older era can be dropped later.

### Claude Desktop extension (`.mcpb`)

A roughly 100-line Node script, packaged as a Desktop Extension of type `node`. Claude Desktop provides the Node runtime (verify in M0).

- **Settings:** `user_config` holds `token` (`sensitive: true`) and `port`. The token is passed as `env`.
- **Behaviour:** it forwards each stdio JSON-RPC message to `/mcp` and relays the response.
- **When SP is not running:** it returns "Super Productivity is not running".
- **Distribution:** attached to GitHub releases and offered for download from the settings page. SP does **not** write into other apps' config files, which also satisfies MAS guideline 2.5.2.

Fall back to running SP's own binary as the shim only if M0 shows `.mcpb` is not viable. That path would need per-package launch commands and would not work under Snap on Wayland.

### Code locations

- `electron/mcp/`: protocol, credential and scopes.
- `electron/shared-with-frontend/mcp.model.ts`: types shared with the renderer.
- `src/app/core/assistant-access/`: read projections and filters, extracted from the REST handler, plus the capture command adapter.
- `packages/mcpb-bridge/` or `tools/mcpb/`: the extension. Its build output is a release asset, not a root dependency.

## 4. Local settings, credential, scopes

- **File.** `userData/assistant-access.json`, 0600. It reuses the token-file helpers in `local-rest-api.ts`: an exclusive random temp file, verified mode, fsync, atomic rename, a dir fsync, and failing closed. Contents: `{enabled, verifierHash, scopes[], createdAt}`. It is not synced and not in backups or exports.
- **Credential.** 32 random bytes, shown once. Only the SHA-256 is stored, and it is compared in constant time. The credential goes in the client's header or env, never in a URL or argv.
- **Scopes** start unchecked. The persisted set is explicit, with no wildcard.

| Scope              | Allows                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `tasks:read`       | Title, isDone, due and deadline fields, projectId, tagIds, estimate and spent; project/tag id and title |
| `tasks:read_notes` | Notes via `get_task`. Requires `tasks:read`.                                                            |
| `tasks:capture`    | `create_task` only. Returns only the new id.                                                            |

- **Revoke or rotate.** Persist first, then swap the in-memory state, then call `closeAllConnections()`. Scopes are re-checked after the body is read and before dispatch, following the REST re-check at `local-rest-api.ts:605`.
- **UI** (Settings → Misc, below the REST API): enable, scopes, reveal/rotate, a copy snippet for Claude Code, Codex, Cursor and VS Code, a `.mcpb` download, "Test connection", and status. Status covers listening, port in use, **permission denied (EPERM)**, storage failure and data not loaded. Strings go through `T`, and user docs follow `docs/documentation-guide.md`.

## 5. Tools

| Tool                          | Input → result                                                                                | Scope                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| `get_status`                  | → `{ready, apiVersion, grantedScopes}`. No task data or counts.                               | any                          |
| `list_tasks`                  | `{query?, projectId?, tagId?, includeDone?=false, limit? ≤100 (50)}` → summaries, `truncated` | `tasks:read`                 |
| `get_task`                    | `{id, includeNotes?}` → projection. Notes capped at about 8 KB, with `notesTruncated`.        | `tasks:read` (+`read_notes`) |
| `list_projects` / `list_tags` | → id and title, capped                                                                        | `tasks:read`                 |
| `create_task` (v2)            | `{title ≤500, notes? ≤8 KB}` → `{id, status}`                                                 | `tasks:capture`              |

- Only active tasks, with no archive, attachments, timer or bulk operations.
- Response cap of about 256 KB.
- Input is validated with `typia.validateEquals`.
- Stable error codes. Messages never include task content or raw exception text.
- Without `tasks:read`, an error never confirms whether an id exists.

## 6. Consistency and untrusted content

- Results carry `{readAt, instanceId, lastSyncAt?}` and make no claim of account-wide freshness.
- `APP_NOT_READY` until `isAllDataLoadedInitially$`. While `isApplyingRemoteOps()` is true, briefly wait (≤2 s) and otherwise return `APP_BUSY`. Do **not** block for the whole sync window.
- Apply the same readiness gate to REST reads in the same PR. REST currently reads before data is loaded.
- Titles and notes are data. They never appear in tool descriptions or `instructions`, and never in logs (sync rule 9). Test fixtures should include prompt-injection text.

## 7. Capture (v2)

Shared contract: the title and notes are taken literally, the task goes into the Inbox backlog, there is no view context, and task defaults apply.

1. Dispatch through the normal service path.
2. `await flushPendingWrites()`.
3. Return `created` only if that operation has no persist failure. That needs a small per-action success signal from `OperationLogEffects`; today only the global `markUnrecoveredPersistFailure()` exists.
4. If the write failed, return `PERSIST_FAILED`. The task may still be visible in the UI, which is the existing optimistic-state behaviour for failed writes.

**Timeouts.** A flush can take 30 s to drain plus 30 s for the lock, which is more than the 15 s renderer timeout. The MCP call uses its own timeout (for example 45 s). If it runs out, the result is `OUTCOME_UNKNOWN` ("may have been created, check before retrying"), never "not created".

**Availability.** If the endpoint is up but the renderer is gone, return `APP_UNAVAILABLE`. If SP has quit, the connection is refused, or the extension returns its error. There is no background queue.

The existing `AppUriTaskActionsService` "add task" path is a candidate to share the capture command with.

## 8. Security acceptance criteria

- Bind `127.0.0.1`. Allow the Host values on the existing allowlist. `/mcp` rejects **any** Origin header. No CORS.
- A bearer credential on every `/mcp` request. Scopes are checked on list, on call, after the body is read and before dispatch.
- Reuse the body and timeout limits. The concurrency limit only counts requests forwarded to the renderer, so set `headersTimeout`/`requestTimeout` for `/mcp` bodies (for example 10 s). Response byte cap as in §5.
- On `render-process-gone` or a main-frame navigation, fail pending MCP requests immediately instead of waiting out the timeout.
- Keep credentials, titles and notes out of logs. Return stable codes only. REST forwards raw `error.message` in three places, and one of them is a `JSON.parse` error that can echo body text. MCP does not do this.
- Enablement and credentials never sync (§4, §10).

**Known gaps** (no observed instance; revisit if one appears):

- IPC responses aren't sender-checked.
- There is no per-credential rate limit.
- `getIsAppReady()` stays true across a renderer reload, which affects REST too.

## 9. Mac App Store: adding `com.apple.security.network.server`

**Why.** A sandboxed app cannot listen, even on loopback, without this entitlement. It also fixes the REST API toggle, which MAS users can see today but which almost certainly fails. That is inferred from config and not observed, so confirm it on a MAS build first; it is the observed instance that justifies the change.

**Problems to weigh, with mitigations:**

| Risk                                                                                                                                                        | Mitigation                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App Review rejection** under 2.4.5(i), "entitlement without matching functionality". There is a 2026 precedent: the Iris app was rejected twice for this. | Put it in a **dedicated release**, not bundled with other risky changes. The review notes name the feature: "Local REST API / assistant access, off by default, Settings → Misc, listens on 127.0.0.1 only". Include screenshots of the toggle. |
| **A rejection blocks every MAS update** until it is resolved                                                                                                | Ship the entitlement in its own small PR (see below). If Apple rejects it, revert only that PR and hide the REST and MCP toggles on MAS.                                                                                                        |
| **More attack surface for all MAS users**                                                                                                                   | Nothing listens unless the user enables it. The bind is explicit to `127.0.0.1`, so the macOS firewall shows no prompt; binding to `localhost` could also take `fe80::1` and trigger one. Auth, Origin and Host checks work the same as on DMG. |
| **The `process.mas` signal is "unreliable"** (`app.constants.ts:43`)                                                                                        | Not needed once the entitlement exists. The same code path runs everywhere.                                                                                                                                                                     |
| **2.5.2: no writing outside the container**                                                                                                                 | SP never edits client configs. It shows copy snippets and a `.mcpb` download.                                                                                                                                                                   |
| **2.4.5(iii): no processes that outlive the app**                                                                                                           | Nothing does. The listener dies with the app, and the `.mcpb` runs inside Claude Desktop, not as SP's process.                                                                                                                                  |
| **The shim can't run SP's MAS binary**                                                                                                                      | Not needed. The `.mcpb` runs in Claude Desktop's Node.                                                                                                                                                                                          |
| **A listen failure is invisible** (logged as a generic "Server error")                                                                                      | Report EPERM/EADDRINUSE to the renderer and show it in settings (§4). This applies to REST too.                                                                                                                                                 |

**Snap.** Add `network-bind` to the plugs in `electron-builder.yaml`. It auto-connects, so users are not prompted. Verify on core22 today; it is required before any move to core24.

## 10. Separate PR: make the REST API enable flag device-local

**Recommendation: yes, a small standalone PR, landed before M2.** It also creates the main-process local-settings pattern that MCP reuses.

**Problem (verified).**

- `misc.isLocalRestApiEnabled` syncs.
- On other desktops, a remote op does not notify main right away, because `notifyElectronAboutCfgChange` listens to `LOCAL_ACTIONS`.
- But on the next launch, the next local settings change or a full-state hydration, `updateLocalRestApiConfig` runs. It silently generates a token and starts listening.

**Severity: low.** The listener requires a token that only exists in that machine's 0600 file, so this is unwanted exposure, not an authentication bypass. Unauthenticated `/health` does reveal that SP is running.

**Shape:**

1. **Storage.** Main process keeps `enabled` in a 0600 local file next to the token.
2. **UI.** The toggle reads and writes it over IPC and is no longer part of the Formly-bound synced model.
3. **Migration, run once when the local file doesn't exist yet.** Seed it from the current synced value. This keeps existing users' scripts working. Devices that already received `true` through sync keep it once; the migration can't tell them apart, and that is acceptable.
4. **Legacy field.** Keep `isLocalRestApiEnabled?` in the model. It is optional and older clients still sync it (rule 11: don't remove persisted fields). New clients stop reading it after migration. No schema bump.
5. **Tests.** An electron `*.test.cjs` for the migration and persistence, plus a spec showing that a remote config op no longer affects the listener.

**Order:**

1. PR A: device-local REST flag, plus reporting listener status and errors to the renderer.
2. PR B: MAS `network.server` and Snap `network-bind`, in their own release.
3. The MCP milestones.

A and B are independent of each other.

## 11. Milestones

| Milestone             | Deliverable                                                                               | Exit                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pre**               | PR A and PR B (§10, §9)                                                                   | Flag no longer syncs; MAS listener works (built and tested on a MAS dev build)                                                                             |
| **M0** client spike   | `/mcp` legacy handshake, `get_status`, a dev credential, the `.mcpb` prototype            | Claude Code, Codex and Claude Desktop (`.mcpb`) connect. Record which protocol eras the clients send and whether Claude Desktop provides Node for `.mcpb`. |
| **M1** read seam      | `AssistantQueryService` extracted from REST, projections, readiness gate for REST and MCP | REST specs still pass; projection and readiness unit tests pass                                                                                            |
| **M2** access control | Settings file, credential, scopes, revocation, UI                                         | Unauthorized, revoked and capture-only callers can't read; settings survive restart; nothing in the op-log                                                 |
| **M3** read release   | Full read catalogue, docs, client matrix, `.mcpb` as a release asset                      | Lifecycle checks (tray, reload, quit, port in use, EPERM) on DMG, MAS, Windows NSIS and appx, AppImage, deb, Snap, Flatpak                                 |
| **M4** capture        | `create_task` with a per-op persist result and `OUTCOME_UNKNOWN`                          | Kill before and after the flush, quota failure, timeout, capture-only isolation                                                                            |
| **M5** editing        | Separate proposal                                                                         | Only after M3/M4 usage shows a need                                                                                                                        |

## 12. Verification

- **Unit tests:**
  - `electron/mcp/*.test.cjs`: both protocol eras, header and body mismatch, auth, Origin including `null`, scopes, limits.
  - `assistant-query.service.spec.ts`: projections, filters, truncation, readiness.
  - The capture persist-result spec.
- **Manual:** each client in the matrix, MCP Inspector, and the `.mcpb` on macOS and Windows.
- **Regression:** `local-rest-api.test.cjs` and the REST handler spec.

## Sources

**MCP spec:**

- `modelcontextprotocol/modelcontextprotocol`: `docs/specification/2026-07-28/{changelog,basic/transports/streamable-http,basic/versioning,server/discover}.mdx` and `2025-11-25/basic/transports.mdx`
- The 2026-07-28 announcement at blog.modelcontextprotocol.io

**Clients:**

- Claude Desktop custom connectors: support.claude.com/en/articles/11175166
- The `.mcpb` manifest: `modelcontextprotocol/mcpb/MANIFEST.md`
- Claude Code MCP docs
- Codex `codex-rs/config/src/mcp_types.rs` (`bearer_token_env_var`)
- Cursor and VS Code configuration docs (not verified: the pages could not be fetched)

**Apple:**

- The `com.apple.security.network.server` entitlement docs
- App Review Guidelines 2.4.5 and 2.5.2
- The Iris rejection report on mjtsai.com, 2026-05-25

**Snap:** snapd `interfaces/builtin/network_bind.go` and `browser_support.go`; electron-builder `targets/linux/snap/coreLegacy.ts`

**Repository:**

- `electron/local-rest-api.ts`, `src/app/core/electron/local-rest-api-handler.service.ts`
- `src/app/op-log/sync/operation-write-flush.service.ts`, `src/app/op-log/capture/operation-log.effects.ts`
- `src/app/op-log/apply/hydration-state.service.ts`, `DataInitStateService`
- `src/app/features/config/store/global-config.effects.ts`, `src/app/imex/sync/sync.const.ts`
- `build/entitlements.mas.plist`, `build/electron-builder.mas.yaml`, `electron-builder.yaml`
- `tools/afterPack.js`, `build/linux/snap-wrapper.sh`, `electron/plugin-node-executor.ts`
