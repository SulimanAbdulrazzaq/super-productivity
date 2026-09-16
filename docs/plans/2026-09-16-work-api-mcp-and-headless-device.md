# Agent endpoint: capture first, full control on opt-in — plan

**Status:** Draft, revision 4 (2026-09-16), after an adversarial review whose verified findings are folded in (§11). Decisions in §8 are resolved. Nothing in this plan is implemented.

**Related:** [`ARCHITECTURE-DECISIONS.md`](../../ARCHITECTURE-DECISIONS.md) #3 (sync package boundary), #4 (upload safety), #8 (additive data-model evolution); [`docs/sync-and-op-log/contributor-sync-model.md`](../sync-and-op-log/contributor-sync-model.md); [`docs/long-term-plans/sync-core-simplification-roadmap.md`](../long-term-plans/sync-core-simplification-roadmap.md); [`docs/long-term-plans/android-background-sync-improvements.md`](../long-term-plans/android-background-sync-improvements.md); [`docs/supersync-encryption-at-rest-decision.md`](../supersync-encryption-at-rest-decision.md); [`docs/wiki/3.01-API.md`](../wiki/3.01-API.md); community MCP servers [organicmoron/SP-MCP](https://github.com/organicmoron/SP-MCP) and [b0x42/Super-Productivity-MCP](https://github.com/b0x42/Super-Productivity-MCP).

---

## 1. Goal and vision

**Goal for the first release:** a user dictates a task to the Claude, ChatGPT or Gemini app on their phone and it shows up in Super Productivity. Setup takes one minute and no technical knowledge.

**Vision:** users who want it get full control of their work through assistants — reading their day, planning, logging time, completing — behind explicit opt-in, with limits they understand. Users who do not want it never see the option again after dismissing it.

Both are served by **one endpoint**, reached through one URL, that starts as a write-only capture connector and, when a user opts in to full control, becomes a device that holds their data. The user never reconnects anything; the connector simply gains tools.

The strategic claim: Super Productivity's durable position is **the system of record for personal work that any assistant can use** — local-first, offline, open, with time tracking and tasks in one model. It is _not_ to become an automation platform or agent runtime.

### Why not the desktop app as the endpoint

Claude, ChatGPT and Gemini mobile apps only reach connectors on the public internet. The desktop app is on a laptop that sleeps. So the endpoint must be always on: hosted by the SuperSync operator or self-hosted. The desktop app's local REST API stays as it is for scripts (15 routes today) and is not the assistant surface.

### What exists today

- The **plugin API** is the only programmable surface. It runs in the renderer and has no scoping; `dispatchAction` is limited to an allowlist of about 24 actions.
- The **local REST API** is Electron-only, off by default, and duplicates the plugin bridge's write paths.
- Two **community MCP servers** run as plugins with `nodeExecution` and file-based IPC, granting everything or nothing. They prove demand and converged on the same tool set.

## 2. Principles

1. **One endpoint, staged.** One URL and one connection per assistant. Capability grows by opt-in; architecture never changes from the user's point of view.
2. **Plug and play over configuration.** No tokens, ports, config files or JSON. Presets, not permission matrices.
3. **Calm defaults.** The default level can only create tasks. Every widening is explicit and explained in one sentence.
4. **Enforced, not declared.** Limits are checked in the endpoint per connection.
5. **Honest about exposure.** Capture exposes only what the user dictates. Full control puts a readable copy of their data on a server, and the product says so in plain words.
6. **Sync stays dumb.** The SuperSync server never reads or interprets ops. The endpoint is a client, never the server (decision #3). The capture queue is a separate, plaintext side channel and is described as such.
7. **No new synced entities, no schema bump.** Everything is additive, optional, or endpoint-local (rules 10 and 11, decision #8).
8. **Ship value before the big extraction.** Capture ships without extracting the sync engine. Full control waits for it.

## 3. Target shape

```
   Claude · ChatGPT · Cursor · Claude Code · any MCP client
                     │  one URL, OAuth 2.1
        ┌────────────▼────────────┐
        │  Agent endpoint         │  packages/agent-endpoint, one container
        │  ├ MCP server (HTTP)    │
        │  ├ policy: per connection
        │  ├ Stage A: capture     │  create_task → capture queue  (no key, no state)
        │  └ Stage B: device      │  full sync client, replays ops (holds key)
        └──────┬─────────────┬────┘
   capture     │             │ ops, encrypted, like any device (Stage B only)
   queue       ▼             ▼
        ┌──────────────────────────┐
        │  SuperSync server        │  + one table, two routes for the queue
        └──────┬───────────────────┘
               │ normal sync; devices claim queue items and create the task locally
      desktop · Android · iOS · web
```

**Stage A — capture.** `create_task` writes a capture item (title, notes, project name, tag names, due date, all optional except title) to a per-user queue on the SuperSync server. The user's own devices fetch the queue during their normal sync cycle, claim an item, resolve names to ids, and create the task through the ordinary add path, so the op is captured and synced like any local edit. The endpoint holds no key and no state. The queue item is deleted on acknowledgement.

**Stage B — full control.** On explicit opt-in the endpoint becomes a sync device for that user: it holds the encryption key in memory, replays ops with the extracted work model and sync engine, and serves reads and all writes as ops. This stage depends on extraction work that is large and is scheduled after capture ships (§5, §11).

**What the single-endpoint choice gives up, on purpose:** users without SuperSync have no assistant access in v1; an unreachable endpoint means assistants cannot act; full control requires trusting whoever runs the endpoint with a readable copy of the data.

## 4. User experience

### 4.1 Turn it on

One new settings section, **AI assistants**, visible only when SuperSync is configured (otherwise it explains that assistants need SuperSync and links to setup).

1. **Turn on.** One button. The app registers the endpoint for this account and shows a card with one URL and **Copy**.
2. Under the URL, one sentence: _Assistants you connect can add tasks to your Inbox. They cannot read anything._
3. **Full control** is a separate switch below, off. Turning it on shows three sentences before confirming: _this keeps a readable copy of your data on the server so assistants can read and change it at any time; whoever runs the server can technically read it; you can lock or turn it off whenever you like._ On confirm, the app sends the key to the endpoint over the authenticated channel and the card gains **Lock**.

Self-hosters see the same card; the endpoint is a container in the same compose file as their SuperSync server, and the card's URL points at it.

### 4.2 Connect an assistant

The user pastes the URL into their assistant as a custom connector. The assistant starts the standard OAuth flow, which lands on the endpoint's sign-in page backed by the SuperSync account (passkey or magic link), then an approval page naming the assistant and its level: **Capture** (preselected) or, if full control is on, **Assist** or **Full**. One tap.

Each connected assistant gets a card: name, level, last used, **Disconnect**. With full control on, the card also has **Fine-tune**, **Undo today (best effort)**, and the audit view.

No port, no token, no JSON is ever shown.

**Client support (to verify before the wiki quotes it; the docs sites were unreachable from the drafting session):** Claude mobile and desktop apps support custom remote MCP connectors with OAuth on paid plans, and expect dynamic client registration. ChatGPT supports custom MCP connectors on paid plans, initially behind a developer-mode setting; mobile write support is uncertain. The Gemini consumer app does not accept user-defined connectors as of drafting; Gemini users need a different capture path (share sheet, the existing URL-scheme action) or must wait for support. Team and Enterprise plans may need admin allowlisting.

### 4.3 Tools

**Stage A (capture):**

| Tool          | Input                                                                    | Behaviour                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_task` | `title`, `notes?`, `project?` (name), `tags?` (names), `due?` (ISO date) | Enqueues a capture item; returns the item id. Names are resolved on the user's device; unknown names fall back to Inbox and are kept in the notes. |

That is the whole tool list. `tools/list` advertises nothing else until full control is on, so assistants do not attempt reads that cannot work.

**Stage B (full control), per level:**

| Category | Tools                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Context  | `get_today_context`, `get_current_focus`, `get_unfinished_work`                                                                                |
| Read     | `list_tasks` (project, tag, due, done filters), `get_task`, `list_projects`, `list_tags`, `get_worklog` (date range)                           |
| Write    | `create_task` (now an op, not a queue item), `update_task`, `complete_task`, `plan_for_today`, `schedule_task`, `add_note_to_task`, `log_time` |

`start_tracking` and `stop_tracking` are not offered: the current task is an unsynced UI pointer and the timer is an app-side service, so an endpoint cannot drive them. `log_time(task, date, duration)` emits the additive time op that devices already understand.

Every tool output wraps user content in a marked data block and every tool description states that task text is content, never instructions (§6.4).

## 5. Phases

### Phase 0 — Contract and the create command (small)

- `packages/work-api-contract/`: tool definitions (name, description, input and output types, level required). Pure TypeScript, no runtime deps. The endpoint's `tools/list` and the app's queue consumer both read from it.
- In the app, a `createTaskFromCapture` command in a small `WorkApiService` wrapper that resolves names and calls the existing add path. This is the first responsibility extracted from the plugin bridge; the rest of that extraction continues in the background and is not on the critical path.
- Exit: contract package builds; the create command has specs including name-resolution fallbacks and idempotency (task id derived from the capture item id, so a double claim cannot create twice).

### Phase 1 — Capture connector (first user-visible release)

- **Server:** one table `capture_items` (user, id, payload, created, claimedBy, claimedAt) and routes to enqueue (endpoint), list-and-claim with a short lease, and acknowledge (devices). Per-user caps on items per hour and payload size. Items are deleted on acknowledgement and expire unclaimed after 30 days. The payload is plaintext to the operator and the plan says so.
- **Client:** a pull step in the sync cycle after download: list pending, claim, create via the Phase 0 command, acknowledge. Android's native background poll continues to handle notifications only; capture items are created when a device runs a web sync, so a phone that is not opened sees the task after another device has synced it. This latency is documented on the card.
- **Endpoint:** `packages/agent-endpoint/`, Node, built on the official MCP SDK (a dependency of that package only): streamable HTTP, OAuth 2.1 with PKCE and dynamic client registration, sign-in backed by SuperSync auth, short-lived access tokens with refresh, revocation from the card. Reports an app semver so the server's per-device checkpoint gate treats it as a current client. Rate-limited and abuse-guarded like any public OAuth server.
- **App:** the settings section from §4.1 and the connection cards from §4.2, with the full-control switch present but disabled and labelled "coming later".
- **Docs:** `3.01-API.md`, `3.02-Settings-and-Preferences.md`, a How-To for connecting an assistant, `3.06-User-Data.md` (the queue is server-side, plaintext, transient).
- Exit: a hosted-SuperSync user turns it on, connects the Claude mobile app, dictates a task, and sees it on their desktop after the next sync; the same for a self-hoster with one container; both community server authors contacted with a migration path.

### Phase 2 — Extraction for full control (large; honest inventory)

Prerequisite for Stage B. Verified size as of 2026-09:

- **Work model.** The 35 reducers and the task-shared meta-reducers import nothing from Angular directly, but their transitive closure is about 240 files and includes module-scope browser access (`localStorage` in the focus-mode reducer, `navigator` and `window.ea` in `app.constants.ts`, `window` in native-dialog utils), a runtime import of `@super-productivity/plugin-api` from `task.model.ts`, `@ngx-formly`, Angular locale data, `chart.js`, an Angular pipe reached via the entity registry, and the op capture meta-reducer, which is an injectable service. Gate: `node -e "require('@sp/work-model')"` succeeds, then a fixture replay equality test against the app.
- **Sync engine.** Download, upload, conflict resolution, superseded-op handling, full-state import and hydration are about 16,000 lines in `src/app/op-log/sync/*.service.ts` with dialogs, snackbars and translation injected. `@sp/sync-core` provides batch replay, encryption, vector clocks and import filtering, not the engine. This work is the sync simplification roadmap's phases 2 and 3 and must land there first; this plan does not duplicate it.
- **Archive.** Archived tasks and worklog data live in IndexedDB via `ArchiveOperationHandler`, outside NgRx. The endpoint needs an archive store, or `get_worklog` and done-task queries are wrong.
- Exit: a Node process can replay a real op log fixture, including archive-affecting ops, to state equal to the app's.

### Phase 3 — Full control

- Endpoint gains Stage B: per-user worker process with `TZ` set from the latest device check-in (refreshed on every app sync, not captured once), because all date keys are computed from local `Date` components.
- **Non-interactive sync policy, fixed:** always accept remote full-state ops (`SYNC_IMPORT`, `BACKUP_IMPORT`, `REPAIR`); never force-upload local state; never choose "use local" in a conflict. Write responses say "accepted, pending sync", not "done", because capture deferral means the op id is known only after the buffer flushes.
- Policy engine with the levels and fine-tune dimensions of §6, evaluated per connection before every call.
- Attribution by the endpoint's single client id; per-connection detail (which assistant, which tool) in the endpoint's own store keyed by op id. No envelope field is added: the server's upload schema strips unknown keys and one client id per connection would push real devices out of the 20-entry vector clock.
- Undo: the endpoint stores a pre-image per write. **Undo today** is labelled best effort with a per-tool table (§6.3).
- Key lifecycle and privacy per §6.2.
- Exit: the Assist level provably cannot delete, archive, or touch tasks it did not create; a spec per level; lock and auto-lock covered by tests.

### Later, on demand (not scheduled)

- Event contract with origin, webhooks, remote automations. Plugin hooks already fire only on local actions, so the double-fire risk does not exist today; this phase would create it. Parked until a consumer asks.
- Proposal mode beyond "Assist writes to Inbox". Higher-level tools (`propose_day_plan`, `find_stale_tasks`).
- WebDAV and local-file backends for the endpoint (self-host only; the endpoint would need the WebDAV password, and local-file cannot be hosted).
- Confidential computing for the hosted endpoint (§6.2).

### Non-goals

- A local MCP server in or beside the desktop app; a relay to the running desktop app.
- Visual workflow builder. Server-side MCP inside SuperSync. A query language. New synced entities. Team features.

## 6. Privacy and policy model

### 6.1 Levels

| Level       | Requires     | Can read                                                         | Can write                                                              |
| ----------- | ------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Capture** | nothing      | nothing                                                          | create tasks into Inbox (or a named project)                           |
| **Assist**  | full control | today, scheduled, open tasks; projects; tags; notes; worklog 30d | create, update and complete tasks it created, plan for today, log time |
| **Full**    | full control | everything except the never-exposed list                         | all tools; delete and archive off unless enabled in fine-tune          |

Fine-tune (full control only): exclude projects or tags; a `private` tag hiding a task everywhere; archive on or off; worklog horizon; imported issue content on or off (**off by default at every level**, because it is stranger-authored); delete and archive; "own tasks only"; per-call size and hourly write caps.

**Never exposed:** sync credentials, issue-provider tokens, OAuth secrets, plugin secrets, global config.

### 6.2 Exposure, stated honestly

- **Capture:** the operator (or self-hoster) sees the tasks dictated through assistants while they wait in the queue, and nothing else. The assistant vendor sees them too, by definition.
- **Full control:** the endpoint holds the user's key and their decrypted state. SuperSync encryption is mandatory in the client (`isEncryptionMandatory = true`), so this cannot be server-blind. Mitigations, none of which makes it blind: key and state in process memory only; state cache ephemeral; key sealed at rest with a per-user key from a key management service outside the database; **Lock** wipes key, state cache and audit; auto-lock after 7 days without any of the user's devices checking in; no request or response bodies in logs; crash dumps and swap disabled on the host; the assistant vendor sees everything it reads and no preset changes that. Confidential computing (SEV-SNP, TDX, Nitro) with remote attestation is the upgrade path once the host moves off OpenVZ, aligned with the encryption-at-rest decision. Per-scope encryption keys would need an envelope change (rule 10) and are a recorded gap.
- Product copy for full control is the three sentences in §4.1; for capture, the one sentence.

### 6.3 Undo table (full control)

| Tool                              | Undo                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `create_task`                     | delete; lossy if the user edited or tracked time since     |
| `update_task`                     | restore pre-image; lossy if the user edited the same field |
| `complete_task`                   | restore pre-image; after day-finish needs archive restore  |
| `schedule_task`, `plan_for_today` | restore prior `dueDay` / `dueWithTime` from pre-image      |
| `add_note_to_task`                | restore pre-image; lossy if the user edited notes since    |
| `log_time`                        | negative delta; can go negative under concurrency, clamped |

### 6.4 Prompt injection

Task titles and notes routinely contain text written by strangers through issue import. Minimum measures, all in Phase 3: imported issue content off by default at every level; tool outputs wrap user text in a marked data block; every tool description carries a fixed note that content is data, not instructions; hourly write caps as calm defaults; a quiet, non-alerting badge in the app when an assistant has written since the user last looked.

## 7. Sync-correctness risks

| Risk                                                   | Consequence                              | Mitigation                                                                            | Phase |
| ------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------- | ----- |
| Two devices claim the same capture item                | duplicate task                           | atomic claim with lease; task id derived from item id, so a second create is rejected | 1     |
| Device crashes between claim and create                | lost capture                             | lease expires, item becomes claimable again                                           | 1     |
| Reducer or engine extraction changes replay            | silent divergence across devices         | Node import smoke test, then fixture replay equality, before any move lands           | 2     |
| Endpoint hits a full-state import or conflict          | dropped writes, or a blocked dialog path | fixed non-interactive policy; write responses are "pending sync"                      | 3     |
| Endpoint day boundary or timezone wrong                | tasks misplanned                         | per-user worker `TZ` from latest device check-in; day-start offset from synced config | 3     |
| Vector clock growth                                    | pruning at `MAX_VECTOR_CLOCK_SIZE = 20`  | one client id per endpoint, never per connection                                      | 3     |
| Command fans out into several dispatches               | replay divergence                        | one command = one action, spec per command                                            | 0     |
| Revoked connection still holding a session             | writes after revocation                  | policy checked per call; revocation invalidates tokens immediately                    | 1     |
| Operator or host can read a user's data (full control) | privacy claim weaker for those users     | §6.2 mitigations, explicit copy, enclave upgrade path                                 | 3     |

Per the sync rules, each phase that touches ops starts from a reproducible failure: a spec or scripted E2E that shows the risk before the mitigation lands.

## 8. Decisions (resolved 2026-09-16)

1. **MCP lives in the endpoint only.** The official SDK is a dependency of `packages/agent-endpoint` and nothing else; the app contains no protocol code.
2. **Reducers and engine are extracted before full control**, in step with the sync simplification roadmap, gated by a Node import test and a fixture replay equality test. Full control does not start before that.
3. **Captured and assisted tasks land in Inbox by default**, project changeable per call by name and, under full control, in fine-tune.
4. **Hosted is the primary way to run the endpoint**, self-hosting the identical image is the alternative. Full control on the hosted endpoint is a separate opt-in with key handover and plain copy.
5. **One endpoint, no local variant, no relay.** Accepted costs in §3.
6. **Staged capability, not staged architecture.** Capture ships first without any key or state on the endpoint; full control is added to the same endpoint and the same connection when the extraction lands. Rejected: shipping full control first (multiple quarters before value), and a separate capture product (a second thing to explain).

## 9. Success criteria (no telemetry)

- A hosted-SuperSync user connects the Claude mobile app and captures a task without reading documentation.
- Support issues about connecting an assistant concern client bugs, not setup steps.
- Both community MCP servers deprecate toward the endpoint.
- A self-hoster runs the endpoint from the documented compose file without a support thread.
- Full control ships only after the fixture replay equality test has been green on the extracted packages for a release cycle.

## 10. First steps

1. Verify current connector support in the Claude, ChatGPT and Gemini mobile apps and record it in §4.2 with dates.
2. Contact the authors of the two community MCP servers with §3 and §4.3 and ask which tools their users call.
3. Phase 0: the contract package and the create-from-capture command, with specs.
4. Phase 1 server routes and the client pull step behind a feature flag, then the endpoint package.
5. Write the Node import smoke test and the fixture replay equality test now, so Phase 2 starts with its gates in place.
6. Correct the wiki's "optional encryption" wording for SuperSync in a separate docs change.

## 11. Review record

An adversarial review on 2026-09-16 found the previous revision's feasibility claims false and its endpoint under-specified. Verified findings and what changed:

- Reducer closure is about 240 files with browser access at module scope → Phase 2 inventory; capture no longer depends on it.
- Sync engine is not in `sync-core`; archive is outside NgRx → Phase 2 names both; gated on the sync roadmap.
- Headless client cannot answer sync dialogs → fixed non-interactive policy in Phase 3.
- Start and stop tracking cannot be reducer-driven → dropped; `log_time` added.
- No envelope slot for a connection id; server strips unknown keys → attribution by endpoint client id, detail endpoint-local.
- Undo is not free → pre-images and a best-effort table.
- Plugin hooks are already local-only → events phase parked.
- Timezone cannot be "captured once" → per-user worker `TZ` refreshed on check-in.
- Encryption mandatory only for SuperSync; WebDAV optional → v1 SuperSync only.
- "Drop excluded ops before decryption" unsound → removed.
- Privacy gaps beyond the key → §6.2 expanded; auto-lock 7 days; lock wipes state.
- Prompt injection absent → §6.4.
- Hydration-guard row was a category error → replaced by capture-deferral wording.
- Client OAuth needs dynamic client registration and an identity layer → Phase 1 endpoint scope.
- Missing billing, rate limits, token semantics, checkpoint gate → Phase 1 scope; billing model is a product decision outside this plan.
- REST API has 15 route matches, not nine; `dispatchAction` is allowlisted → §1 corrected.
