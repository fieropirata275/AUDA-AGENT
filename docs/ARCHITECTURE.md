# AUDA — Architecture

> AUDA is a digital operator that lives alongside the user, keeps working when the
> conversation ends, remembers what matters, notices relevant changes, decides what
> to do next within its permissions, and comes back when human judgment is needed.

This document is the foundation the code is built on. It covers, in order:
architecture, the application state model, the task and responsibility lifecycles,
the database schema, the event model, the permission model, the design system,
the motion system and AUDA's visual identity.

---

## 1. Architecture

AUDA is a **modular monolith**: one Node.js process (`server/src/index.ts`) with hard
module boundaries, plus an outer process supervisor (`server/src/bin/auda.ts`) that
restarts the core if it dies. Nothing important lives only in memory: every
responsibility, task, step, schedule, approval and checkpoint is in SQLite (WAL mode),
so a restart resumes work rather than losing it.

```
                ┌───────────────────────────── clients ─────────────────────────────┐
                │  Web app (React)   ·   Device link (auda-link)   ·   Webhooks/API  │
                └──────────────┬──────────────────────┬──────────────────┬──────────┘
                               │ REST + WebSocket      │ WS               │ HTTP
┌──────────────────────────────▼──────────────────────▼──────────────────▼──────────┐
│ Gateway  (gateway/)      REST API · realtime fan-out · inbound hooks · static UI  │
├───────────────────────────────────────────────────────────────────────────────────┤
│ Agent Core (agent/)      chat → persistent state · intent compiler · agent loop   │
│ Responsibilities         long-lived goals; spawn tasks when woken                 │
│ Durable Task Engine      leases · checkpoints · retries/backoff · resumable steps │
│ Scheduler                cron · once · interval · fuzzy windows · deadlines       │
│ Watchers                 cheap edge-triggered probes; wake responsibilities       │
│ Event Bus                persisted events + in-process subscribers                │
│ Memory Service           typed memory · FTS retrieval · consolidation · expiry    │
│ Policy Engine            capabilities · rules · approvals · quiet hours · budgets │
│ Tool Broker              the only path to side effects; idempotency + audit       │
│ Connector Runtime        GitHub · Webhooks · AUDA's computer · linked devices     │
│ Computer Runtime         persistent workspace: terminal · filesystem · Chromium   │
│ Model Router             reasoning / utility / vision / coding / fallback roles   │
│ Notifications            importance levels, quiet hours, no spam                  │
│ Artifact Store           files with a "why" and an owner task                      │
│ Audit Log                every external mutation, with policy decision            │
├───────────────────────────────────────────────────────────────────────────────────┤
│ Supervisor (supervisor/) independent loop: dead leases, browser health, stuck     │
│                          tasks, circuit breakers, recovery records                │
├───────────────────────────────────────────────────────────────────────────────────┤
│ SQLite (data/auda.db) · Secret store (data/secrets, AES-256-GCM) · Workspace dir  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Rules of the boundaries**

* Only the **Tool Broker** performs side effects. Playbooks and the agent loop ask the
  broker for a *capability* (`terminal.exec`, `fs.delete`, `github.rerun_workflow`…).
  The broker asks the **Policy Engine**, records an **Audit** entry, deduplicates through
  the **actions** table (idempotency keys) and only then calls the connector/runtime.
* Models never see credentials. Connectors fetch secrets from the **Secret Broker** at
  call time; models only see capability names and results.
* Modules talk through the **Event Bus** for anything asynchronous (an approval granted
  wakes a task; a watcher firing wakes a responsibility). Direct calls are used only for
  synchronous queries.
* The UI is a projection. The realtime layer pushes entity upserts; the client never
  invents state.

**Deployment target.** Proxmox host → Ubuntu VM → `docker compose` (AUDA core + AUDA's
computer container) with persistent volumes. See `deploy/`. The computer runtime has
drivers: `local` (a sandboxed workspace directory — development), `docker` (a long-lived
container AUDA execs into) and `ssh` (a dedicated VM). The browser is a persistent
Chromium profile inside that environment.

---

## 2. Application state model

AUDA is one entity with continuous state:

| Concept | What it is | Lives in |
|---|---|---|
| Identity | name, presence, current narration | `identity` |
| Presence | derived: `available · thinking · working · browsing · coding · waiting · watching · scheduled · needs_you · blocked · idle · recovering` | computed from tasks/approvals/supervisor |
| Responsibility | an ongoing goal that stays alive | `responsibilities` |
| Task | finite unit of work, possibly spawned by a responsibility | `tasks`, `task_steps`, `task_runs` |
| Schedule / Trigger / Watcher | how AUDA wakes up | `schedules`, `triggers`, `watchers` |
| Memory | typed, scoped understanding | `memories` (+ FTS) |
| Approval | a specific decision only the human can make | `approvals` |
| Rule | natural-language policy compiled to structure | `rules` |
| Connector / Device | pieces of AUDA's environment | `connectors`, `devices` |
| Computer | AUDA's persistent desk | `computers`, `computer_sessions` |

**Presence derivation** (highest wins): `recovering` (supervisor repairing) → `needs_you`
(pending approval) → `blocked` → `browsing`/`coding`/`working` (a RUNNING task; the
running step's tool decides the flavour) → `thinking` (model call in flight) →
`waiting` (WAITING_EXTERNAL tasks) → `watching` (active responsibilities) →
`scheduled` (only future work) → `available` → `idle` (nothing at all for 30 min).

---

## 3. Task lifecycle

```
DRAFT → PLANNING → READY → RUNNING ─┬─→ COMPLETED
                     ▲      │       ├─→ WAITING_USER ──(approval)──→ READY
                     │      │       ├─→ WAITING_EXTERNAL ─(event/time)→ READY
                     │      │       ├─→ SCHEDULED ──(time)──→ READY
                     │      │       ├─→ RETRYING ──(backoff)──→ READY
                     │      │       ├─→ FAILED (after max retries / unrecoverable)
                     │      │       └─→ PAUSED ──(resume)──→ READY
                     │      └─(lease lost / crash)─→ RECOVERING ─→ READY
                     └──────────────── CANCELLED (from any non-terminal state)
```

* A task owns a **plan** (ordered steps). Each step is executed at most once
  successfully; the step index and step outputs are the **checkpoint**.
* A worker **claims** a READY task by atomic state change, opens a `task_run` with a
  30-second **lease** and heartbeats every 5s. If the process dies, the supervisor sees
  the expired lease, records a recovery, and moves the task `RECOVERING → READY`. The
  next worker resumes from `current_step`.
* Side-effecting steps carry an **idempotency key** (`task:step:capability:hash`).
  The broker refuses to repeat an action already marked `done` and returns the stored
  result instead, so a retry can never send the same email or delete twice.
* Progress is honest: we show `3 of 7 known steps`, never invented percentages.

## 4. Responsibility lifecycle

```
DRAFT ──activate──→ WATCHING ──trigger──→ HANDLING ──task done──→ WATCHING
                       │  ▲                  │
                       │  └──── approved ────┤──→ NEEDS_USER (task waits for you)
                       ├──pause──→ PAUSED ──resume──→ WATCHING
                       └──stop───→ ENDED
```

A responsibility owns its wake-up sources (watchers, schedules, triggers) and spawns
tasks through its **playbook**. When the task finishes, the responsibility records
`last_outcome`, updates operational memory and returns to WATCHING. It never ends just
because a task ended.

---

## 5. Database schema

See `server/src/core/schema.sql` (authoritative). Entities: `identity, spaces,
conversations, messages, responsibilities, tasks, task_runs, task_steps, schedules,
triggers, watchers, events, activity, memories (+memories_fts), artifacts, connectors,
secrets, permissions, rules, approvals, computers, computer_sessions, notifications,
audit_log, actions, model_calls, settings, devices`.

Relationships: a Space scopes conversations, responsibilities, tasks, memories,
artifacts, rules and permission overrides. A Responsibility has many Watchers,
Schedules, Triggers and Tasks. A Task has Steps, Runs, Approvals, Artifacts and
Activity. Approvals point at a specific Step and capability. Audit entries and actions
point at the task/step that caused them.

---

## 6. Event model

Events are persisted in `events` and dispatched in-process. Types:

```
task.created  task.started  task.step.completed  task.waiting  task.resumed
task.completed  task.failed  task.recovering  task.cancelled
responsibility.created  responsibility.triggered  responsibility.updated
approval.requested  approval.granted  approval.rejected
watcher.fired  watcher.error  schedule.fired
connector.webhook.received  connector.github.workflow_failed  connector.state
computer.session.started  computer.session.crashed  computer.session.recovered
computer.control.changed
memory.created  memory.updated  memory.consolidated
rule.activated  notification.created  presence.changed
```

Triggers subscribe responsibilities to event patterns (`connector.webhook.received`
with `{slug:"deploys"}`), so a webhook wakes exactly the responsibility that cares.

---

## 7. Permission model

Every tool is a **capability** with a default level:

| Level | Meaning | Examples |
|---|---|---|
| `autonomous` | do it, record it | read files, `terminal.exec` (read-only commands), browse, research, write own reports |
| `rule` | allowed when an active rule matches; otherwise ask | restart a container, compress logs, archive newsletters |
| `approval` | always pause with a specific approval card | delete outside scratch, send externally, spend money, push to main, privilege changes |
| `deny` | never | as set by rules ("Never spend money") |

Evaluation order: explicit **deny rules** → **allow rules** (scope, resource glob,
time window, budget) → **permission overrides** (per space/connector) → capability
default. Quiet-hours and budget rules are conditions on rules. Every decision is
written into the audit log with the rule that produced it.

Rules are written in natural language, compiled to structure
(`{effect, capabilities, resource, conditions}`), shown back as an interpretation, and
only become active after the user confirms.

---

## 8. Design system — modern skeuomorphism

Material cues, not cosplay. Surfaces are a warm ceramic in light mode and graphite in
dark mode. Hierarchy comes from **elevation**: `well` (inset, −1), `surface` (0),
`raised` (+1, cards), `lifted` (+2, being manipulated), `floating` (+3, sheets).
Each level is a pair of shadows (ambient + contact) plus a 1px top edge highlight.
One restrained accent (ember). Semantic colors are muted and few: *attention*
(amber), *settled* (sage), *problem* (clay). Personality comes from shape and motion.
Typography: Instrument Sans (UI), Instrument Serif (AUDA's voice / large headings),
JetBrains Mono (raw logs only). Tokens live in `web/src/design/tokens.css`.

## 9. Motion system

* One spring solver (`web/src/motion/spring.ts`) used for glyphs; `motion` springs for
  layout. Presets: `snap` (micro, ~160ms), `settle` (~280ms), `glide` (~450ms),
  `expressive` (~650ms).
* **Stroke-morph icons**: every status icon is the same structure — three centerline
  strokes of 24 points with round caps. A dot is a stroke of zero length. Morphing
  any icon to any other is per-point interpolation, so *dots → waveform → orbit →
  check*, *clock → progress → tick*, *plug → linked* are continuous.
* Elements lift 1–2px when AUDA starts work on them, settle into the surface when
  inactive, and physically depress when pressed.

## 10. AUDA's visual identity — the Aperture

AUDA's glyph is a three-layer fluid aperture: three closed polar curves
`r(θ) = R · (1 + Σ aₖ·sin(kθ + φₖ(t)))` rendered as a lens. Every presence state is a set
of parameter targets (radius, harmonic amplitudes, rotation speed, layer separation,
breathing rate). Springs drive the parameters, so state changes are always continuous
morphs, never icon swaps. Idle breathes; listening expands; thinking reorganises its
inner harmonics; working orbits; waiting slows and settles; needs-you pulses softly;
completion briefly resolves into a perfect circle; trouble deforms gracefully and
exposes a notch — never red shaking.

---

## 11. Reliability model

AUDA cannot promise that nothing ever fails — no system can, least of all
against failures nobody has seen yet. It is built so that failures are
**expected, detected, contained, recovered where safe, and explained** when not.
Each failure class has a specific defence, and each defence has a test.

| Failure | Defence | Where | Tested by |
|---|---|---|---|
| Worker/process dies mid-step | Leases + heartbeats; resume from last completed step | `tasks/engine.ts` | `e2e-agent` (SIGKILL mid-command) |
| A step hangs forever | Per-step time budget; abort signal passed to models and tools; retried as transient | engine `stepTimeoutMs` | unit + engine |
| Same action repeated by a retry | Idempotency keys; completed actions replay their stored result; unknown-state external actions never repeat without you | `tools/broker.ts` | `npm test` |
| Retrying something that can't succeed | Error classification: transient → backoff with jitter; permanent → stop now with a plain diagnosis; unknown → bounded retries | `tools/errors.ts` | `e2e-agent` |
| One bad task crash-loops the core | Recovery counter; quarantined after 3 crashes, everything else keeps running | `abandonRun` | `e2e-reliability` |
| Core crash loop (any cause) | Process supervisor backs off and boots **safe mode** (UI/API up, nothing executes) after 5 crashes in 5 min | `bin/auda.ts` | `e2e-reliability` |
| Core frozen (event loop blocked) | Supervisor health-probes every 10 s; 3 misses → kill and restart | `bin/auda.ts` | `e2e-reliability` (SIGSTOP) |
| Memory leak | Graceful restart above `AUDA_MAX_RSS_MB` | `bin/auda.ts` | — |
| Signal lost between "happened" and "handled" | Event outbox: persisted before dispatch, marked after handlers settle, replayed on boot; wake-ups are idempotent per event | `core/bus.ts` | `e2e-agent` |
| Database corruption | `quick_check` at boot; corrupt file kept aside; newest passing backup restored automatically | `core/db.ts` | `e2e-reliability` |
| Data loss | Hourly online backups (`VACUUM INTO`), newest 48 kept | `core/db.ts` | `e2e-reliability` |
| Disk full / slow loop | Supervisor alerts with specifics | `supervisor/` | — |
| Parallel agents colliding on the browser | Browser access is serialised | `computer/browser.ts` | — |
| Flaky external service | Circuit breaker per connector (5 failures → 5 min cooldown) | `connectors/runtime.ts` | — |

### Agents doing hard work

| Typical agent failure | Defence |
|---|---|
| Claims "done" without doing it | Independent reviewer checks the result against **done when** before completion; up to two revise rounds; otherwise marked *not fully verified* |
| Endless loops | Identical-call detection (warn at 3, stop at 5; bookkeeping calls get 2× slack); hard turn cap |
| Context overflow on long tasks | Handoff to a fresh context with a structured progress summary (append-only — never rewrites history) |
| Giant tool outputs | Outputs over 12 k chars saved as files; the agent gets head + tail + a pointer |
| Malformed tool calls | Schema validation; errors returned to the model, not thrown |
| Prompt injection via web content | Web/file content wrapped as `<untrusted_content>`; all side effects still pass the policy engine |
| Too big for one agent | `spawn_subtasks`: up to 6 parallel sub-agents (depth ≤ 2), each with its own workspace; parent waits durably and joins results; stopping the parent stops the children |
| Agents trampling each other's files | Per-task workspace `~/work/<task>` |

The scripted model (`scripts/mock-model.mjs`, enabled with `AUDA_MOCK_MODEL`)
lets the whole agent path run deterministically without an API key.

---

## 12. Local models, the LAN and the team

* **Model providers.** The router speaks Anthropic (official SDK) and any
  OpenAI-compatible server (`models/openai.ts`), with tool calling translated
  both ways. LM Studio is detected on the usual addresses, connected after a
  real tool-calling probe, and health-checked; a circuit breaker protects it.
* **Discovery.** Each instance has a stable id and a name, advertises
  `_auda._tcp` over mDNS, answers `AUDA_DISCOVER` UDP broadcasts on port 4611,
  and serves `GET /api/discover` (no secrets).
* **Pairing.** Apps request pairing → a 6-digit code appears in Connections →
  approval issues a token once (stored hashed, revocable). With
  `security.requirePairing` (or `AUDA_TOKEN`), only paired clients and the local
  machine may use the API.
* **Team chat.** The `group` conversation holds you, AUDA and every agent.
  Agents post lifecycle updates; `@mentions` go into a task's inbox and are
  appended (never rewriting history) at the agent's next turn; agents answer
  with `reply_to_user`. Mentioning a finished agent starts a follow-up with its
  context. Uploads stream into `~/inbox/<date>/…`, folder structure kept, each
  file recorded with why it exists.

## 13. Organization, plugins, custom agents and learning

* **Identity per request.** `resolveUser` maps every request to a person:
  `AUDA_TOKEN` → owner; a session (`sess_…`, cookie or bearer) → its user; a
  paired client → the member who approved it; otherwise, with the organization
  off, the local owner. The handler runs inside `runAs(userId)`
  (AsyncLocalStorage), and the task engine runs each task as its `owner_id`, so
  every layer below — memory, plugin credentials, knowledge — can ask
  `currentUserId()` without threading it through. Realtime batches and the
  bootstrap snapshot are filtered per viewer by `canSee`; plugin and agent views
  are re-projected per viewer (connection state, edit rights).
* **Plugins** (`plugins/`). A plugin row is org-level config (OpenAPI-style
  tools or an MCP URL, auth endpoints, client id, client secret in the secret
  broker); `plugin_connections` is per person. OAuth uses authorization code +
  PKCE (S256) with a one-time `state` that also identifies the person on the
  open callback route; refresh is single-flight per connection, retried once on
  a 401, and a refused refresh marks the connection *expired* (the agent gets a
  permanent "reconnect" error instead of retrying). MCP uses Streamable HTTP
  (session id, JSON or SSE responses, re-initialise on 404) and discovers auth
  via protected-resource metadata → authorization-server metadata → dynamic
  client registration (public client). Calls go through the broker as
  `plugin.read` (autonomous) or `plugin.write` (approval, `external` risk), so
  rules, approvals, idempotency and audit apply; a per-plugin circuit breaker
  and timeouts contain failing services, and responses are wrapped as untrusted
  content.
* **Custom agents** (`agents/agents.ts`). Identity + instructions + config
  (allowed plugins, default "done when", sources, learning flags, re-ranker
  weights). Tasks carry `agent_id` and `owner_id` (the person who asked); the
  agent playbook adds the agent's instructions, `search_knowledge` and `learn`
  tools, the runner's plugin tools (`p_<app>_<id>__<tool>`), and seeds the first
  message with the top passages from its knowledge base.
* **Knowledge** (`agents/knowledge.ts`). Documents → ~1,200-character passages
  (150 overlap, sentence-aware) → FTS5 + vectors. Candidates get features
  `[bm25, cosine, helped-before, is-lesson, confidence, freshness]` scored by a
  per-agent logistic regression; at most two passages per document. Every
  retrieval is logged with its features.
* **Learning** (`agents/learning.ts`). On `task.completed/failed`: label each
  logged retrieval by whether its distinctive terms appear in what the agent
  itself produced (reasoning, tool inputs, answer, files — never the retrieval
  output), run online SGD on new labels, then reflect (model or heuristics) into
  deduplicated lessons and skills. Feedback overrides labels and turns comments
  into lessons; hourly maintenance decays unhelpful lessons and re-reads
  sources whose content hash changed. Covered end to end by
  `scripts/e2e-org.mjs`.
