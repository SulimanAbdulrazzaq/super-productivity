# Work API and the agent endpoint — plan

**Status:** Draft, revision 3 (2026-09-16). Decisions in §8 are resolved. Nothing in this plan is implemented.

**Related:** [`ARCHITECTURE-DECISIONS.md`](../../ARCHITECTURE-DECISIONS.md) #3 (sync package boundary), #8 (additive data-model evolution); [`docs/sync-and-op-log/contributor-sync-model.md`](../sync-and-op-log/contributor-sync-model.md); [`docs/long-term-plans/sync-core-simplification-roadmap.md`](../long-term-plans/sync-core-simplification-roadmap.md); [`docs/supersync-encryption-at-rest-decision.md`](../supersync-encryption-at-rest-decision.md); [`docs/wiki/3.01-API.md`](../wiki/3.01-API.md); community MCP servers [organicmoron/SP-MCP](https://github.com/organicmoron/SP-MCP) and [b0x42/Super-Productivity-MCP](https://github.com/b0x42/Super-Productivity-MCP).

---

## 1. Problem

AI assistants are becoming a primary way people manage their work. An app that only has a GUI gets bypassed: the assistant keeps the list somewhere it can read. Super Productivity has valuable structured state (tasks, projects, tags, time, issues, calendar links, history) but no supported machine interface for it:

- The **plugin API** is the only programmable surface. It runs in the renderer, has no scoping, and exposes raw NgRx actions through `dispatchAction` and the `action` hook.
- The **local REST API** is Electron-only, off by default, covers nine routes, and duplicates the plugin bridge's write paths against `TaskService` and the store.
- Two **community MCP servers** exist. Both run as plugins with `nodeExecution` and talk to a separate process through files on disk, because nothing better is available. They grant everything or nothing.

Demand is demonstrated. The two community servers converged on the same tool set and have users. What is missing is one supported, scoped, plug-and-play way for an assistant to read and act on a user's work.

The strategic claim this plan rests on: Super Productivity's durable position is **the system of record for personal work that any assistant can use** — local-first, offline, open, with time tracking and tasks in one model. It is _not_ to become an automation platform or agent runtime. Those layers commoditise fast and are built better elsewhere.

## 2. Principles

Taken from the manifesto and applied to this feature:

1. **One system.** One endpoint, one URL, one way to connect an assistant. No local variant, no relay, no tiers. A user never chooses between architectures; the only choice is who runs the container.
2. **Plug and play over configuration.** A non-technical user connects an assistant in under a minute, without editing config files, copying tokens, or opening ports. Presets, not permission matrices.
3. **Calm defaults.** A new connection is read-only and sees only today's and scheduled work. Every widening is an explicit, understandable opt-in.
4. **Enforced, not declared.** Privacy limits are checked in the endpoint, per credential. A declaration the assistant makes about itself is not a control.
5. **One surface.** Every tool is defined once and appears identically in MCP and the plugin SDK. No adapter has its own vocabulary.
6. **No new synced entities, no schema bump.** Everything ships as additive, optional data or as unsynced endpoint state (rule 10 and 11, decision #8).
7. **Sync stays dumb.** The SuperSync server never reads or interprets payloads. End-to-end encryption keeps working. The endpoint is a client, never the server (decision #3).
8. **Reversible.** Everything an assistant writes is attributable to it and can be undone as a batch.

## 3. Target shape

```
  Claude Desktop / Claude Code / Cursor / any MCP client
                         │  one URL, OAuth
              ┌──────────▼──────────┐
              │  Agent endpoint     │  Node container: hosted or self-hosted
              │  ├ MCP (HTTP)       │
              │  ├ Work API         │  tools, queries, events
              │  ├ policy engine    │  per-connection limits, audit, undo
              │  └ sync client      │  replays ops with the same reducers
              └──────────┬──────────┘
                         │ ops, encrypted, like any other device
              ┌──────────▼──────────┐
              │  SuperSync / WebDAV │
              └──────────┬──────────┘
                         │
          desktop · phone · web  (unchanged; plugins use the Work API in-process)
```

The agent endpoint is a full sync client: it downloads ops, replays them into state with the same reducers, and writes ops with its own client id. To the rest of the system it is simply another device. This is what keeps end-to-end encryption, conflict detection, and attribution intact without any server change.

There is exactly one endpoint implementation and one container image. The SuperSync operator runs it as a hosted option; self-hosters run the same image next to their sync server. Assistants running on the user's own machine connect to the same URL as assistants running in the cloud.

**What this gives up, on purpose (decision 5):**

- A user without sync has no assistant access. The endpoint needs a sync backend to be a device.
- A user who wants assistants but no readable copy of their data on any server must self-host the endpoint. There is no local-only path through the desktop app.
- When the endpoint is unreachable, assistants cannot act. The hosted option exists so that this is rare.

The local REST API on the desktop stays exactly as it is, for scripts. It is not the assistant surface and is not extended by this plan.

Feasibility check (2026-09): the 35 reducers under `src/app` and the task-shared meta-reducers import nothing from Angular (only `meta-reducer-registry.ts` does). `@sp/sync-core` already exposes `ActionDispatchPort` and a framework-agnostic replay coordinator, and `@sp/sync-providers` contains the SuperSync HTTP client with a fetch factory. The endpoint is therefore a packaging and extraction task, not a rewrite. Per decision 2 the extraction happens before the endpoint is built.

## 4. User experience

This is the part that decides adoption. It is designed first; the architecture serves it.

### 4.1 Turn on the endpoint

One new settings section, **AI assistants**.

- **Hosted SuperSync users:** one button, **Turn on**. The app provisions the endpoint, sends it the sync key over the authenticated channel, and shows a card with the endpoint status and a **Lock** button. Above the button, three sentences: this runs a copy of your data on our server so assistants can reach it at any time; we can technically read it; you can lock or turn it off whenever you like.
- **Self-hosters (SuperSync, WebDAV):** the same card shows a compose snippet for the container and a short pairing code. Starting the container with the code completes the setup. Nothing else to configure.
- **No sync configured:** the section explains that assistants need sync and links to the sync setup.

The endpoint appears in the app's device list like a phone would, with **Forget** to revoke it.

### 4.2 Connect an assistant

On the same card, **Connect an assistant** shows one URL. The user pastes it into their client (Claude Desktop custom connector, `claude mcp add`, Cursor). The client starts the standard MCP OAuth flow, which lands on the endpoint's approval page. The approval page shows the assistant's name and the three presets (§6), with **Read only** preselected. One click, done.

Each connected assistant gets its own card: **Claude Desktop — Read only · Today and scheduled**, with the **Access** selector, **Fine-tune** behind a link, last-used time, **Undo today**, and **Disconnect**.

No port, no token, no JSON is shown, ever. Credentials are minted by the endpoint, bound to the card, and revocable from it.

Rejected alternatives: a local MCP server on the desktop (a second architecture with its own setup path and its own limits), a relay that reaches the running desktop app (a third), a token field with a config snippet (what exists today and why the community servers ship shell scripts).

### 4.3 What the assistant experiences

A small, opinionated tool set with good descriptions beats a large one. Version 1:

| Category | Tools                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| Context  | `get_today_context`, `get_current_focus`, `get_unfinished_work`                                                      |
| Read     | `list_tasks` (project, tag, due, done filters), `get_task`, `list_projects`, `list_tags`, `get_worklog` (date range) |
| Write    | `create_task`, `update_task`, `complete_task`, `plan_for_today`, `schedule_task`, `add_note_to_task`                 |
| Time     | `start_tracking`, `stop_tracking`                                                                                    |

This is the intersection of what the two community servers exposed plus the three context bundles that let an assistant avoid pulling every task. Habits, counters, metrics, bulk operations and repeat configs are deliberately left for a later version, on evidence of use. Every write returns the resulting entity and the op id, so the assistant can reference what it changed.

## 5. Phases

Each phase ships on its own. The order puts the two extractions first because the endpoint cannot exist without them, and puts policy inside the endpoint phase because an internet-facing endpoint must not ship without it.

### Phase 0 — Work API package (no user-visible change)

- `packages/work-api/`: pure TypeScript, runnable in Node and in the browser. It holds the tool contract (name, description, input and output types, required capability, entity type), the queries as functions over state, the commands as functions that return the one action to dispatch, and the policy types. No Angular, no runtime dependencies beyond the workspace packages. Validation uses the existing typia setup.
- The app wraps the package in a thin Angular service. The plugin bridge (`plugin-bridge.service.ts`, 2333 lines, grandfathered over the 1200-line cap) and the local REST handler become consumers of that wrapper. Net effect: one write path, and the size-cap debt paid.
- Commands are thin: each returns exactly the action the GUI would dispatch. A command that fans out multiple dispatches is a bug (contributor sync model, rules 1–3).
- Exit: plugin API and local REST behave identically to before; specs for every query and command in the package; the grandfathered entry for the plugin bridge removed from `eslint.config.js`.

### Phase 1 — Work model extraction

- Move the reducers, meta-reducers, entity models and the pure utils they depend on from `src/app` into `packages/work-model`. The app imports them back from the package; behaviour does not change.
- Gate: a fixture replay test that feeds a real op log through the package and asserts state equality with the app's own replay. Written before the move, kept forever.
- Sequencing: coordinated with the sync simplification roadmap so the two efforts do not touch the same boundary at once.
- Exit: `packages/work-model` builds for Node with no Angular or browser globals; the fixture replay passes; the grandfathered list in `eslint.config.js` has not grown.

### Phase 2 — Agent endpoint

- `packages/agent-endpoint/`: Node process composed from `@sp/sync-core` (replay coordinator, conflict resolution, encryption), `@sp/sync-providers` (SuperSync, WebDAV, file), `@sp/work-model`, `@sp/work-api`, and the official MCP SDK (a dependency of this package only) serving streamable HTTP with OAuth. Ships as one container image.
- Policy engine (§6): presets, fine-tune dimensions, never-exposed list, evaluated per connection before every query and command.
- Audit: per-connection log of tool name, entity ids and timestamp. Never task text (rule 9). Viewable on the connection card, exportable, with last-used time.
- Undo by principal: **Undo today** on the connection card, implemented as a compensating batch built from the op log filtered by the connection's client id.
- Key lifecycle (§6.3): provisioned from the app, memory-only, sealed at rest outside the database, lock, auto-lock.
- Logical day: the day-start offset (`startOfNextDayTime`) is synced global config and is read from state. The timezone is not synced, so pairing captures it from the app once and stores it with the endpoint credential. The endpoint never uses the container's clock settings.
- Hosted provisioning in the SuperSync account, self-host compose file next to `super-sync-server`, and the settings section from §4.1 and §4.2.
- Wiki: `3.01-API.md` (new surface, REST section unchanged), `3.02-Settings-and-Preferences.md` (new section), a How-To for connecting an assistant, `3.06-User-Data.md` (where the endpoint keeps state).
- Exit: a hosted-SuperSync user turns the endpoint on and connects Claude Desktop in under a minute; a self-hoster does the same with one container; the default preset provably cannot read notes, archive or config and cannot write, asserted by a spec per preset; both community server authors have been contacted with a migration path.

### Phase 3 — Event contract and origin

- Publish the semantic event vocabulary as a mapping from op-log `ActionType` to dotted event names (`task.completed`, `time.started`, `day.finished`, …). Each event carries `origin: 'local' | 'remote' | 'replay'` and the originating client id.
- Plugin hooks become an adapter over this mapping. `ACTION` hook and `dispatchAction` are deprecated with a removal date.
- The `automations` plugin consumes the new events. Default: automations run only on `local` origin. Remote is opt-in per rule, with an idempotency key, because a rule evaluated on two synced devices would otherwise fire twice.
- The endpoint streams events over the MCP session and offers a webhook, for `WHEN task.completed …` style consumers running elsewhere. On the endpoint, every event is `remote` by definition; consumers there must opt in.

### Phase 4 — Higher-level operations and propose mode

- Read-side: `get_planning_context`, `find_stale_tasks`, `summarize_project`.
- Propose mode without new entities (decision 3): an assistant with the **Assist** preset writes new tasks into the Inbox project tagged `AI proposed`; the user triages in the app they already use. The target project can be changed in the fine-tune panel. A dedicated proposal store is added only if this proves too coarse.
- `propose_day_plan` returns a plan; it does not schedule. Accepting is a batch command by the user.

### Explicit non-goals

- A local MCP server in or beside the desktop app, stdio shims, or client bundles. One endpoint only (decision 5).
- A hosted relay to the running desktop app. Same reason.
- Visual workflow builder. Automations stay code, in plugins.
- Server-side MCP in SuperSync. Reverses decision #3 and breaks end-to-end encryption.
- A query language. Typed query functions only.
- New synced entities (Proposal, TimeEntry, Agent). Time stays `timeSpentOnDay`; a derived view is exposed instead.
- Team or multi-user features.

## 6. Privacy and policy model

Policy is a property of a connection, checked in the endpoint. Users choose a preset; the preset expands to a policy.

| Preset        | Read                                                                   | Write                                                                                      | Default for          |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| **Read only** | Today, scheduled, open tasks; projects; tags; titles and metadata only | none                                                                                       | every new connection |
| **Assist**    | Read only + notes, worklog last 30 days                                | create in inbox, update and complete tasks it created, plan for today, start/stop tracking | users who opt in     |
| **Full**      | Everything except the never-exposed list                               | all tools; delete stays off unless enabled separately                                      | power users          |

Fine-tune, behind a link, exposes the underlying dimensions:

- **Scope:** exclude projects, exclude tags, and a `private` tag that hides a task and its subtasks everywhere.
- **History:** archive on or off; worklog horizon in days.
- **Fields:** notes, attachments, imported issue content (which may belong to an employer).
- **Write guards:** delete, archive, "own tasks only", per-call size and hourly rate limits.

**Never exposed under any preset:** sync credentials, issue-provider tokens, OAuth secrets, plugin secrets, global config. Not a toggle; not in the contract.

**Attribution and undo.** Every op the assistant writes carries the endpoint's client id and the connection id, so "what did agent X change" is a filter and "undo agent X today" is a compensating batch. This is the safety net that makes write access acceptable, and it comes almost free from the op log.

### 6.3 Endpoint security design

SuperSync encryption is mandatory (`isEncryptionMandatory = true` in the provider), so every SuperSync user holds a key, and an endpoint that replays their ops must hold it too. Every user with assistant access therefore has a readable copy of their data on a server: their own if self-hosted, the operator's if hosted. The design minimises that exposure rather than hiding it.

- **Separate service.** The endpoint is not part of the sync server. It runs as its own process, on its own host where possible, and reaches sync only through the client API like any device. It has no database access. Decision #3 stays intact.
- **Key in memory.** The key is provisioned from the app over the paired, authenticated channel and held in process memory. At rest it is sealed with a per-user key from a key management service outside the database, so a database dump or disk snapshot yields nothing.
- **Lock.** One button in the app wipes the key from memory and the sealed copy. Auto-lock after a period without any of the user's own devices checking in (default 30 days). Unlock is one tap.
- **Minimised replay.** Envelope metadata is plaintext, so ops for entity types the policy excludes for every connection are dropped before decryption. A minimisation, not a guarantee.
- **Network.** TLS required. Hosted: behind the operator's edge. Self-hosted: behind the user's reverse proxy, with the compose file defaulting to localhost until a hostname is set. No outbound calls other than sync.
- **Product copy.** Hosted: this runs a copy of your data on our server so assistants can reach it at any time; we can technically read it; you can lock or turn it off whenever you like. Self-hosted: the same, with "your server".

**Upgrade path (revisit condition).** On a KVM host with SEV-SNP, TDX or Nitro Enclaves, the endpoint runs in an enclave and the app verifies the code by remote attestation before releasing the key. That restores a real technical guarantee for the hosted option. Not possible on the current OpenVZ host; aligned with the KVM note in [`docs/supersync-encryption-at-rest-decision.md`](../supersync-encryption-at-rest-decision.md). Per-scope encryption keys, which would let the endpoint receive keys only for assistant-visible projects, need an envelope change (rule 10) and are recorded as a known gap, not planned.

The wiki pages `2.08` and `2.09` still describe SuperSync encryption as optional; that is stale relative to the provider and should be corrected in a separate docs change.

## 7. Sync-correctness risks

Every item below is a known failure mode and has an owner phase.

| Risk                                          | Consequence                                     | Mitigation                                                                                | Phase |
| --------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| Automation fires on both devices for one op   | duplicate side effects                          | events carry origin; automations local-only by default; idempotency key for remote opt-in | 3     |
| Command fans out into several dispatches      | several ops per intent, replay divergence       | one command = one action, enforced by review and a spec per command                       | 0     |
| Reducer extraction changes replay             | silent state divergence across devices          | fixture replay equality test written before the move                                      | 1     |
| Endpoint day boundary differs from the user's | "today" wrong on the endpoint, tasks misplanned | day offset from synced config; timezone captured at pairing; never container time         | 2     |
| Vector clock growth from many devices         | pruning at `MAX_VECTOR_CLOCK_SIZE = 20`         | one endpoint per user; document the cap in setup                                          | 2     |
| Assistant bulk write during a sync window     | interleaved ops                                 | Work API commands honour the hydration guard the effects use                              | 0     |
| Revoked connection still holding a session    | writes after revocation                         | policy checked per call; revocation invalidates the session immediately                   | 2     |
| Operator or host can read a user's data       | privacy claim weaker for endpoint users         | memory-only key, sealed at rest, lock and auto-lock; explicit copy; enclave upgrade path  | 2     |
| Endpoint unreachable                          | assistant cannot act                            | hosted option; status on the card; MCP errors name the cause                              | 2     |

Per the sync rules, each phase that touches ops starts from a reproducible failure: a spec or scripted E2E that shows the risk before the mitigation lands.

## 8. Decisions (resolved 2026-09-16)

1. **MCP lives in the endpoint only.** The official SDK is a dependency of `packages/agent-endpoint` and nothing else. The desktop app contains no protocol code and is not an assistant surface. Rejected: a hand-written protocol subset in Electron (spec drift), the SDK as a root dependency (rule exception), and a stdio server or client bundle on the desktop (a second architecture, see decision 5).
2. **Reducers: extract to `packages/work-model` first.** A clean boundary before the endpoint exists, gated by a fixture replay equality test and sequenced with the sync simplification roadmap. Rejected: bundling from source first (hidden browser dependencies, a second move later) and running the real app headless (heavy image, effects need a headless mode).
3. **Proposals: Inbox by default, tagged `AI proposed`, target project changeable in fine-tune.** Rejected: an auto-created project the user did not ask for.
4. **Hosted: yes, as the primary way to run the endpoint,** with self-hosting of the identical image as the alternative. Key handling per §6.3, confidential computing as the revisit condition. Rejected: self-host only (leaves non-technical users without assistants).
5. **One system over options.** No local MCP, no relay, no tiers. Accepted costs, stated in §3: users without sync get no assistant access; users who refuse any server-side copy must self-host; an unreachable endpoint means no assistant. Rejected: a tiered design with a local server and a keyless relay, because it doubles the setup paths and the support surface for a small gain in coverage.

## 9. Success criteria (no telemetry)

The app has no analytics, so success is observed, not measured:

- Both community MCP servers deprecate toward the endpoint.
- Support issues about connecting an assistant concern client bugs, not setup steps.
- At least one plugin (the `automations` plugin) runs on the event contract with no use of `ACTION` or `dispatchAction`.
- A self-hoster runs the endpoint from the documented compose file without a support thread.
- A hosted-SuperSync user turns the endpoint on and connects an assistant without reading documentation.

## 10. First steps

1. Contact the authors of the two community MCP servers with §3 and §4.3 and ask which tools their users call. Their field data replaces guesswork for the v1 tool list.
2. Phase 0 as a series of small PRs, each moving one responsibility from the plugin bridge into `packages/work-api`, each reviewed under the size cap.
3. Write the fixture replay equality test against today's `src/app` reducers, so Phase 1 starts with its safety rail already green.
4. A design note for the policy and connection data shape before Phase 2 mints credentials, so nothing has to migrate later.
5. Correct the wiki's "optional encryption" wording for SuperSync in a separate docs change.
