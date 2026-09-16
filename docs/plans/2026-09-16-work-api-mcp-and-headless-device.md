# Work API, MCP and the headless device — plan

**Status:** Draft for discussion (2026-09-16). Nothing in this plan is implemented.

**Related:** [`ARCHITECTURE-DECISIONS.md`](../../ARCHITECTURE-DECISIONS.md) #3 (sync package boundary), #8 (additive data-model evolution); [`docs/sync-and-op-log/contributor-sync-model.md`](../sync-and-op-log/contributor-sync-model.md); [`docs/long-term-plans/sync-core-simplification-roadmap.md`](../long-term-plans/sync-core-simplification-roadmap.md); [`docs/wiki/3.01-API.md`](../wiki/3.01-API.md); community MCP servers [organicmoron/SP-MCP](https://github.com/organicmoron/SP-MCP) and [b0x42/Super-Productivity-MCP](https://github.com/b0x42/Super-Productivity-MCP).

---

## 1. Problem

AI assistants are becoming a primary way people manage their work. An app that only has a GUI gets bypassed: the assistant keeps the list somewhere it can read. Super Productivity has valuable structured state (tasks, projects, tags, time, issues, calendar links, history) but no supported machine interface for it:

- The **plugin API** is the only programmable surface. It runs in the renderer, has no scoping, and exposes raw NgRx actions through `dispatchAction` and the `action` hook.
- The **local REST API** is Electron-only, off by default, covers nine routes, and duplicates the plugin bridge's write paths against `TaskService` and the store.
- Two **community MCP servers** exist. Both run as plugins with `nodeExecution` and talk to a separate process through files on disk, because nothing better is available. They grant everything or nothing.

Demand is demonstrated. The two community servers converged on the same tool set and have users. What is missing is a supported, scoped, plug-and-play way for an assistant to read and act on a user's work, on the desktop today and always-on later.

The strategic claim this plan rests on: Super Productivity's durable position is **the system of record for personal work that any assistant can use** — local-first, offline, open, with time tracking and tasks in one model. It is _not_ to become an automation platform or agent runtime. Those layers commoditise fast and are built better elsewhere.

## 2. Principles

Taken from the manifesto and applied to this feature:

1. **Plug and play over configuration.** A non-technical user connects an assistant in under a minute, without editing config files, copying tokens, or opening ports. Presets, not permission matrices.
2. **Calm defaults.** A new connection is read-only and sees only today's and scheduled work. Every widening is an explicit, understandable opt-in.
3. **Enforced, not declared.** Privacy limits are checked inside the app or device, per credential. A declaration the assistant makes about itself is not a control.
4. **One surface.** Every tool is defined once and appears identically in MCP, REST, and the plugin SDK. No adapter has its own vocabulary.
5. **No new synced entities, no schema bump.** Everything ships as additive, optional data or as unsynced device state (rule 10 and 11, decision #8).
6. **Sync stays dumb.** The SuperSync server never reads or interprets payloads. End-to-end encryption keeps working. The agent endpoint is a client, never the server (decision #3).
7. **Reversible.** Everything an assistant writes is attributable to it and can be undone as a batch.

## 3. Target shape

```
  Claude Desktop / Claude Code / Cursor / scripts / plugins / GUI
                         │
        ┌────────────────┼────────────────┐
        │  MCP adapter   │  REST adapter  │  Plugin SDK
        └────────────────┼────────────────┘
                         │
              ┌──────────▼──────────┐
              │  Work API           │  tools, queries, events
              │  + policy engine    │  per-credential limits
              └──────────┬──────────┘
                         │ dispatches the same actions the GUI dispatches
              ┌──────────▼──────────┐
              │  store + reducers   │  one intent = one action = one op
              │  op-log + sync      │
              └─────────────────────┘
```

The Work API runs in two hosts with the same code:

| Host                | Where                                    | Reaches                          | Ships in |
| ------------------- | ---------------------------------------- | -------------------------------- | -------- |
| **Desktop app**     | Electron main + renderer, localhost only | Assistants on the same machine   | Phase 1  |
| **Headless device** | Node process, self-hosted or hosted      | Cloud assistants, phone via sync | Phase 4  |

The headless device is a full sync client: it downloads ops, replays them into state with the same reducers, and writes ops with its own client id. To the rest of the system it is simply another device. This is what keeps end-to-end encryption, conflict detection, and attribution intact without any server change.

Feasibility check (2026-09): the 35 reducers under `src/app` and the task-shared meta-reducers import nothing from Angular (only `meta-reducer-registry.ts` does). `@sp/sync-core` already exposes `ActionDispatchPort` and a framework-agnostic replay coordinator, and `@sp/sync-providers` contains the SuperSync HTTP client with a fetch factory. The headless device is therefore a packaging and extraction task, not a rewrite.

## 4. User experience

This is the part that decides adoption. It is designed first; the architecture serves it.

### 4.1 Desktop: connect an assistant

One new settings section, **AI assistants**, replacing the current "Enable local REST API" toggle and token field (which stay available under Advanced for scripts).

1. User clicks **Connect an assistant** and picks a client: Claude Desktop, Claude Code, Cursor, or "Other (MCP)".
2. The app does the client-specific setup itself where the client allows it: writes the MCP entry into the client's config, or hands the client a one-click install bundle or deep link. For "Other", it shows one URL and one copy button.
3. A card appears: **Claude Desktop — Read only · Today and scheduled**. Status turns green when the client first connects.
4. On the card, an **Access** selector with three presets (see §6) and a link to **Fine-tune** for the few people who want it.

No port, no token, no JSON is shown on the default path. The credential is minted by the app, bound to the card, and revocable from it.

Rejected alternative: keep a token field and document the config snippet. That is what exists today and it is why the community servers ship shell scripts.

### 4.2 Always-on access

For assistants that do not run on the user's machine (cloud agents, phone workflows):

- **SuperSync users:** the same settings section offers **Always-on access**. Self-hosters add one container to their existing compose file. Hosted SuperSync can offer it as a paid option that runs the identical container. Pairing uses a short code shown in the app, never a copied token.
- **WebDAV / file sync users:** the device supports those providers as well, since it uses the same provider package. Setup is a container plus the same pairing code.
- **No sync:** always-on access is unavailable and the UI says so, with the desktop path still working.

The device shows up in the app's device list like a phone would, with a **Forget** button that revokes it.

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

Each phase ships on its own and is useful without the next. Order is chosen so the riskiest architectural work (Phase 0 and 4) has a shipped consumer before it is extended.

### Phase 0 — Work API extraction (no user-visible change)

- Extract the command and query logic from `src/app/plugins/plugin-bridge.service.ts` (2333 lines, grandfathered over the 1200-line service cap) into a `WorkApiService` under `src/app/core/work-api/`. Make the plugin bridge and `local-rest-api-handler.service.ts` consumers. Net effect: one write path, and the size-cap debt paid.
- Add `packages/work-api-contract/` holding pure TypeScript tool definitions: name, description, input and output types, required capability (`read`, `write`, `time`, …), entity type. No runtime dependencies. Validation uses the app's existing typia setup.
- Commands are thin: each dispatches exactly the action the GUI would dispatch. A command that fans out multiple dispatches is a bug (contributor sync model, rules 1–3).
- Exit: REST and plugin API behave identically to before; specs for `WorkApiService`; the grandfathered entry for the plugin bridge removed from `eslint.config.js`.

### Phase 1 — Local MCP over the desktop app

- The Electron local API server (`127.0.0.1:3876` today) additionally serves MCP over streamable HTTP at `/mcp`, generated from the contract. The protocol surface needed is small (`initialize`, `tools/list`, `tools/call`, `ping`) and is implemented in-repo, so no root dependency is added.
- `packages/sp-mcp/`: a tiny published stdio shim (`npx @super-productivity/mcp`) for clients that only speak stdio. It forwards to the local endpoint. Its own `package.json` may depend on the official MCP SDK; that dependency stays inside the package.
- Settings section from §4.1 with client-specific setup for Claude Desktop, Claude Code and Cursor. Credentials are per connection, stored in the same `0600` file scheme the REST token uses today.
- Wiki: `3.01-API.md` (new surface), `3.02-Settings-and-Preferences.md` (new section), a How-To for connecting an assistant.
- Exit: a non-technical user connects Claude Desktop in under a minute with no manual config; both community server authors have been contacted with the design and a migration path.

### Phase 2 — Policy, presets, audit, undo

- Policy engine in the Work API (§6), evaluated per credential before every query and command. Applies to MCP, REST and, in declared form, plugins.
- Three presets in the UI, fine-tune panel behind a link.
- Audit: per-connection log on the device of tool name, entity ids and timestamp. Never task text (rule 9). Viewable in the connection card, exportable, with "last used".
- Undo by principal: **Undo everything this assistant did today** on the connection card, implemented as a compensating batch built from the op log filtered by the connection's client id.
- Exit: the default preset provably cannot read notes, archive or config, and cannot write; a spec suite asserts each preset's allow and deny list.

### Phase 3 — Event contract and origin

- Publish the semantic event vocabulary as a mapping from op-log `ActionType` to dotted event names (`task.completed`, `time.started`, `day.finished`, …). Each event carries `origin: 'local' | 'remote' | 'replay'` and the originating client id.
- Plugin hooks become an adapter over this mapping. `ACTION` hook and `dispatchAction` are deprecated with a removal date.
- The `automations` plugin consumes the new events. Default: automations run only on `local` origin. Remote is opt-in per rule, with an idempotency key, because a rule evaluated on two synced devices would otherwise fire twice.
- No streaming transport yet. The headless device adds it in Phase 4.

### Phase 4 — Headless device

- `packages/headless-client/`: Node process composed from `@sp/sync-core` (replay coordinator, conflict resolution, encryption), `@sp/sync-providers` (SuperSync, WebDAV, file), the reducers, the Work API, and the MCP and REST adapters. Ships as a container next to `super-sync-server`.
- Reducer access: first via a dedicated build entry that bundles the existing reducer files from `src/app` for Node (low-risk, no file moves), then a physical move into a package once the bundle is stable. This aligns with the sync simplification roadmap's boundary work and should be sequenced with it.
- Pairing: the app mints a device credential and shows a short code; the container is started with it. The device registers with the sync backend as a normal client with its own client id.
- Logical day: the device must use the user's day boundary. The day-start offset (`startOfNextDayTime`) is synced global config and is read from state. The timezone is not synced, so pairing captures it from the app once and stores it with the device credential. The device never uses the container's clock settings.
- Streaming events over the MCP session and a webhook option, for `WHEN task.completed …` style consumers running elsewhere.
- Exit: a self-hoster runs one extra container and a cloud assistant can plan their day; a hosted variant is offered only if self-hosters ask for it.

### Phase 5 — Higher-level operations and propose mode

- Read-side: `get_planning_context`, `find_stale_tasks`, `summarize_project`.
- Propose mode without new entities: an assistant with the **Assist** preset writes new tasks into a designated inbox project tagged `AI proposed`; the user triages in the app they already use. A dedicated proposal store is added only if this proves too coarse.
- `propose_day_plan` returns a plan; it does not schedule. Accepting is a batch command by the user.

### Explicit non-goals

- Visual workflow builder. Automations stay code, in plugins.
- Server-side MCP in SuperSync. Reverses decision #3 and breaks end-to-end encryption.
- A query language. Typed query functions only.
- New synced entities (Proposal, TimeEntry, Agent). Time stays `timeSpentOnDay`; a derived view is exposed instead.
- Team or multi-user features.

## 6. Privacy and policy model

Policy is a property of a credential, checked in the Work API. Users choose a preset; the preset expands to a policy.

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

**Attribution and undo.** Every op the assistant writes carries its client id, so "what did agent X change" is a filter and "undo agent X today" is a compensating batch. This is the safety net that makes write access acceptable, and it comes almost free from the op log.

**Network posture.** Desktop binds `127.0.0.1` only. The headless device binds localhost by default; anything else requires TLS and the paired credential, behind the user's own reverse proxy in the self-hosted case. Neither makes outbound calls other than sync.

**Hosted variant honesty.** With end-to-end encryption on, a hosted device must hold the user's key to function. That is no longer server-blind. The offering is described as "a device we run for you", the self-hosted path stays first-class, and the policy engine is identical, so the hosted tier has no more access than the self-hosted one.

## 7. Sync-correctness risks

Every item below is a known failure mode and has an owner phase.

| Risk                                        | Consequence                                   | Mitigation                                                                                | Phase |
| ------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| Automation fires on both devices for one op | duplicate side effects                        | events carry origin; automations local-only by default; idempotency key for remote opt-in | 3     |
| Command fans out into several dispatches    | several ops per intent, replay divergence     | one command = one action, enforced by review and a spec per command                       | 0     |
| Device day boundary differs from the user's | "today" wrong on the device, tasks misplanned | day offset from synced config; timezone captured at pairing; never container time         | 4     |
| Vector clock growth from many devices       | pruning at `MAX_VECTOR_CLOCK_SIZE = 20`       | one headless device per user in v1; document the cap in setup                             | 4     |
| Assistant bulk write during a sync window   | interleaved ops                               | Work API commands honour the hydration guard the effects use                              | 0     |
| Revoked credential still holding a replay   | writes after revocation                       | policy checked per call; revocation invalidates the session immediately                   | 2     |
| Hosted device key handling                  | server-blind claim becomes false              | explicit product copy; self-host first; key never leaves the device process               | 4     |

Per the sync rules, each phase that touches ops starts from a reproducible failure: a spec or scripted E2E that shows the risk before the mitigation lands.

## 8. Open decisions

1. **MCP protocol in-repo vs SDK in Electron.** The plan implements the small streamable-HTTP subset in-repo to honour the no-new-root-dependency rule. If the protocol surface grows (resources, prompts, sampling), revisit.
2. **Reducer extraction timing.** Bundle-from-source first, physical move later. Needs agreement with the sync simplification roadmap so the two efforts do not cross.
3. **Inbox project for propose mode.** A per-user designated project versus the existing Inbox. Decide on user feedback from Phase 1.
4. **Hosted device.** Offer at all? Only with self-hoster demand and after the key-handling copy is agreed.

## 9. Success criteria (no telemetry)

The app has no analytics, so success is observed, not measured:

- Both community MCP servers deprecate toward, or wrap, the official adapter.
- Support issues about connecting an assistant concern client bugs, not setup steps.
- At least one plugin (the `automations` plugin) runs on the event contract with no use of `ACTION` or `dispatchAction`.
- A self-hoster runs the headless device from the documented compose file without a support thread.

## 10. First steps

1. Contact the authors of the two community MCP servers with §3 and §4.3 and ask which tools their users call. Their field data replaces guesswork for the v1 tool list.
2. Phase 0 as a series of small PRs against the plugin bridge, each moving one responsibility into `WorkApiService`, each reviewed under the size cap.
3. A design note for the policy engine's data shape before Phase 1 ships credentials, so Phase 2 does not have to migrate them.
