# AUDA

**An always-on autonomous digital operator.**

AUDA is not a chatbot. It is a persistent entity with its own computer, memory,
responsibilities and rules. It keeps working after the conversation ends,
notices relevant changes on its own, acts within the permissions you give it,
and comes back only when your judgment is actually needed.

> “Keep this server healthy and tell me when you need me.”
> — and then you close the tab, and AUDA keeps going.

![AUDA Home](docs/images/home-approval.png)

## What's here

This repository is a working vertical slice, not a mockup:

| | |
|---|---|
| **Presence** | A morphing glyph (“the Aperture”) and a one-sentence narration derived from what AUDA is actually doing — never a spinner. |
| **Responsibilities vs tasks** | Ongoing goals (“keep demo-api healthy”) own watchers, schedules and triggers, spawn finite tasks, and return to *Watching* when a task ends. |
| **Durable task engine** | Leases, heartbeats, per-step checkpoints, retries with exponential backoff, crash recovery that resumes from the last completed step. |
| **Tool broker + policy engine** | Every side effect goes through capabilities with autonomy levels, natural-language rules compiled to policy, specific approval cards, idempotency keys and an audit log. |
| **AUDA's computer** | A persistent workspace with a terminal, filesystem, a real Chromium profile (live screencast in the UI), and one small service to look after. Watch it, take control, hand it back. |
| **Memory** | Typed memory (identity, preference, episodic, project, operational, semantic, relationship, procedural, working) with provenance, confidence, weight (*mentioned → established → defining*), expiry and consolidation. |
| **Scheduler & watchers** | Cron, intervals, one-offs and fuzzy windows (“tomorrow morning”); cheap edge-triggered watchers that wake responsibilities only on meaningful change. |
| **Supervisor** | An independent loop that detects dead task runs and a hung browser, and recovers them visibly. |
| **Connections** | AUDA's computer, inbound webhooks, GitHub (CI watching), Claude, and linked devices with explicit, revocable grants. |
| **Chat** | A control surface that maps language onto persistent state; created objects render inline and stay live. |

The whole product works **offline without any model** — the built-in playbooks
and intent compiler handle server health, page watching, CI, webhooks,
reports, reminders, rules and memory. Connect Claude to unlock open-ended work.

## Quick start

Requires Node.js ≥ 22.12 and (for the browser) Chromium.

```bash
npm install
npm run build        # build the UI
npm start            # AUDA core + process supervisor on http://localhost:4610
```

Development (hot reload for core and UI):

```bash
npm run dev          # UI on http://localhost:5173, API on :4610
```

### Try the vertical slice

1. In Chat (or the box on Home) say **“Keep the server healthy.”**
   AUDA creates a responsibility and starts watching `demo-api` on its own computer.
2. Open **Computer → Services** and switch `demo-api` to **debug** logging.
   The volume starts filling at ~450 KB/s; the gauge climbs on Home.
3. At 80% the watcher fires. AUDA investigates with real commands
   (`du`, `find`, growth sampling, `tail`, `cat config.json`), finds the cause and
   asks — once, specifically — whether it may delete old archives and switch logging back.
4. Approve. The card resolves, the task resumes, AUDA verifies the fix, writes an
   incident report, stores episodic + procedural memory and returns to **Watching**.
5. Switch to debug again: the next incident cites your earlier decision. After the
   second approval AUDA **suggests a rule** so it can handle it without asking next time.
6. **Computer → Reliability → Freeze the browser** to watch the supervisor recover it.

### Assign hard work

**Work → Assign work**: say what to do, add details, and — most importantly —
**done when**. AUDA publishes a live plan, splits independent parts across
parallel sub-agents, asks only for real decisions, and has the result
independently reviewed against your criteria before calling it finished.
(Open-ended work needs Claude connected; everything else works offline.)

### Tests

```bash
npm test               # unit tests: scheduler, rules, policy, broker idempotency, memory, reminders
npm run e2e:slice      # the vertical slice above, headless
npm run e2e:agent      # agent path with a scripted model: review/revise, sub-agents, loops, approvals, crash mid-command
npm run e2e:reliability# platform drills: DB corruption restore, poison quarantine, frozen-core watchdog, crash loop → safe mode
npm run e2e:lan        # LM Studio (faithful fake), discovery, pairing, uploads, team chat with @mentions
npm run e2e            # all of them
```

## Reliability

AUDA can't promise nothing ever fails; it is built so failures are expected,
detected, contained, recovered where safe, and explained when not — step time
budgets, error classification, idempotent actions, poison-task quarantine, an
event outbox, a watchdog with safe mode, automatic backups with corruption
restore, and agent guards (review before done, loop detection, context handoff,
output capping, untrusted content). The full matrix, with the test for each
defence, is in [`docs/ARCHITECTURE.md` §11](docs/ARCHITECTURE.md#11-reliability-model).
Live state: **Settings → Reliability**.

## Configuration

| Variable | Default | |
|---|---|---|
| `AUDA_DATA` | `./data` | Database, workspace, browser profile, secrets key |
| `AUDA_PORT` | `4610` | |
| `AUDA_PUBLIC_URL` | `http://localhost:4610` | Used for webhook URLs and device links |
| `AUDA_TOKEN` | — | Require a token for the UI and API |
| `AUDA_MASTER_KEY` | generated | Key for the encrypted secret store |
| `ANTHROPIC_API_KEY` | — | Optional; Claude can also be connected in the UI |
| `AUDA_CHROMIUM` | auto-detected | Chromium executable for AUDA's browser |
| `AUDA_COMPUTER_DRIVER` | `local` | `local` · `docker` · `ssh` |
| `LMSTUDIO_URL` | auto-detected | LM Studio server address(es), comma-separated |
| `AUDA_DISCOVERY` | on | Set `0` to stop advertising on the LAN |
| `AUDA_MAX_RSS_MB` | `2048` | Supervisor restarts the core gracefully above this |
| `AUDA_STEP_TIMEOUT_MS` | `600000` | Default time budget per task step |
| `AUDA_AGENT_MAX_TURNS` | `80` | Hard cap on model turns per agent task |

## Deploying

* **Docker:** `docker compose -f deploy/docker-compose.yml up -d`
* **Proxmox VM:** see [`deploy/proxmox`](deploy/proxmox/README.md) (cloud-init included)
* **systemd:** [`deploy/auda.service`](deploy/auda.service)

All state lives in `AUDA_DATA`; back it up (or snapshot the VM) and AUDA resumes
exactly where it was — responsibilities, memory and unfinished tasks included.

## Local models with LM Studio

Run `lms server start` (LM Studio's headless server) on this machine or another
one on your network. AUDA finds it automatically and tells you. In
**Connections → LM Studio**: pick a model, choose what to use it for (agents &
chat, summaries & rules, code, images), and **Test & connect**. AUDA runs a real
tool-calling probe: models that can call tools drive agents end to end; models
that can't are used for text tasks only, and AUDA says so. Local-model quirks
(malformed JSON arguments, tool calls written as text, `<think>` blocks) are
handled, and context limits trigger the agent's context handoff earlier.
Set `LMSTUDIO_URL` to point at a non-default address.

## The Android app

`android/` contains the AUDA app (Kotlin + Jetpack Compose, the same design
system). It **finds AUDA instances on your network by itself** (mDNS
`_auda._tcp`, UDP broadcast on port 4611, subnet sweep), pairs with a 6-digit
code you approve in Connections, and gives you Home, Chat, **Team** (a group
chat with every agent: `/task` to assign, `@agent` to steer one mid-task, attach
files and whole folders) and Work (tasks, reviews, sub-agents, approvals,
Assign work). CI builds installable APKs on every push — see
[`android/README.md`](android/README.md).

## Linking one of your machines

Connections → *Your devices* → name it → run the printed command on that machine:

```bash
node scripts/auda-link.mjs --server ws://auda.local:4610 --token <token> --allow terminal
```

Nothing is granted until you switch it on, the device enforces grants locally too,
and revoking closes the link immediately.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): module boundaries, state model,
task and responsibility lifecycles, schema, events, permission model, design system,
motion system and the glyph.

```
server/src/
  core/            db (SQLite/WAL), event bus, change feed, activity
  agent/           chat → state, intent compiler, presence
  tasks/           durable task engine
  responsibilities/
  playbooks/       server.health · web.watch · github.ci · routine.* · webhook.react · agent
  scheduler/       cron, fuzzy schedules
  watchers/        edge-triggered probes
  memory/          typed memory, recall, consolidation
  policy/          capabilities, policy engine, rules compiler
  tools/           tool broker (idempotency, approvals, audit)
  computer/        drivers, terminal, files, browser, services
  connectors/      runtime + circuit breakers, GitHub, devices
  supervisor/      recovery loop
  models/          model router (Claude, local OpenAI-compatible), budgets
  gateway/         REST, realtime WebSocket, inbound hooks
web/src/
  motion/          spring solver, stroke-morph icons, the Aperture
  design/          tokens (light/dark), materials, components
  pages/           Home · Chat · Work · Computer · Memory · Connections · Activity · Settings · Spaces
```
