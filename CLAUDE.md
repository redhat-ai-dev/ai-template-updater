# CLAUDE.md

Guidance for agents working in this repo.

> **Single source of truth:** This repo is authoritative. Do NOT rely on the
> assistant's cross-session auto-memory. Put durable knowledge here or in the
> relevant `.claude/` agent/workflow file — never in a memory store.

---

## 1. What this project does

`agentic-template-ops` keeps the **RHDH AI templates** up to date. It:

1. Reads a list of templates (model servers + models) from a Google Sheet.
2. Scans each for version drift (server images on quay, models on HuggingFace,
   upstream releases on GitHub/PyPI).
3. Builds updated container images and pushes them to a personal quay namespace
   (staging), stages them on an `rhdh-ai-template` fork branch, and deploys a
   rolling demo to a ROSA cluster for verification.
4. After human verification, promotes images to the official quay namespace and
   opens PRs against `rhdh-ai-developer-images` and `rhdh-ai-template`.

The Python package does the drift scan + Sheet I/O. The `.claude/` workflows and
subagents do the build/stage/promote/deploy work (they shell out to `podman`,
`git`, `gh`, `make`, and the project's own generation scripts).

---

## 2. Repository layout

```
agentic_template_ops/          Python package (drift scan + Sheet I/O + reporting)
  cli.py                       Click CLI: investigate / setup / promote / configure / run
  config.py                    Dataclasses + constants (EnvConfig, AppConfig, SERVER_CONFIGS, …)
  gws_client.py                Google Sheet read/write via the `gws` CLI
  report.py                    Writes VERSION_STATUS.md + the "Version Status" sheet tab
  agents/drift_scanner.py      Orchestrates per-template version checks (threaded)
  server_agents/               One agent per server type (vllm, llamacpp, whispercpp, object_detection)
  model_agents/                HuggingFace model version agent
.claude/
  agents/impl-*.md             Subagents that build/stage/promote/deploy (see §6)
  workflows/setup.js           Phases 1-3+deploy (investigate → build → stage → deploy)
  workflows/promote.js         Phase 5 (retag to official quay, open PRs)
  workflows/stage-demo.js      Carve-out of setup's Stage+Deploy (skips investigate+build)
VERSION_STATUS.md              Generated snapshot of current versions (also written to the Sheet)
.env / .env.example            Local config (paths, quay namespaces, cluster) — read-only to agents
pyproject.toml                 Package; CLI entry point `agentic-template-ops`
```

---

## 3. End-to-end pipeline

| Phase | Where | What happens |
|-------|-------|--------------|
| 1. Investigate | `investigate` CLI / setup.js | Drift scan; results written to `VERSION_STATUS.md` + the Sheet's **Audit Log** (`built=FALSE`) |
| 2. (review) | — | **No approval gate** — every detected update flows through automatically |
| 3. Build | setup.js `impl-builder` | Build each updated image, push to personal quay (`quay.io/<QUAY_PERSONAL_NS>`) |
| 4. Record | setup.js → `record-builds` | Write each pushed `image_tag` + `built=TRUE` back to the Sheet's newest run |
| 5. Stage | setup.js `impl-template` | Read **built rows** from the Sheet, set `rhdh-ai-template` env files to the exact `image_tag`, regenerate, push a fork branch |
| 6. Deploy | setup.js `impl-rolling-demo` | Deploy rolling demo to ROSA (`make install-no-rhoai`) for verification |
| 7. Verify | human | Test the staged templates on the cluster |
| 8. Promote | promote.js `impl-builder` / `impl-devimages` / `impl-template` | Read built rows, retag `image_tag` → official quay, commit version dirs, open PRs |

**Source of truth after Investigate: the Sheet.** The build phase records exact pushed tags to the Audit Log (`record-builds`); Stage/Deploy/Promote read them back (`list-built`). No image tag is ever reconstructed by hand — this is what prevents tag mismatches (e.g. vllm's `v` prefix).

---

## 4. CLI commands (`agentic-template-ops`)

Defined in `cli.py`. Default spreadsheet id is hardcoded there; override with
`--spreadsheet-id`.

- `investigate` — Phase 1. Runs the drift scan, writes `VERSION_STATUS.md` and the
  Sheet. `--dry-run` skips the Sheet write.
- `setup` — Phase 3. Reads the latest audit run from the Sheet and builds/stages.
- `promote` — Phase 5. Reads the latest audit run and promotes + opens PRs.
- `record-builds --results '<json>'` — Write build outcomes to the Audit Log's
  newest run. Input: JSON array of `{component, server_type, version, image_tag,
  success}`. Successful builds set `built=TRUE` + `image_tag` on every matching
  row. (Also reads stdin if `--results` omitted.)
- `list-built` — Print the newest run's built rows as JSON (the staging/promote
  work-list, each with exact `image_tag`).
- `configure` — Generates `.claude/settings.local.json` (read perms + additional
  dirs) from `.env`.
- `run` — Full workflow (1→5) with a human confirmation before promote.

`--all` on setup/promote is a **deprecated no-op** (approval was removed; all
detected updates are always taken).

The Google Sheet is accessed through the `gws` CLI (uses existing OAuth). Image
build/stage/promote is driven by the `.claude/workflows/*` (preferred) which spawn
the `impl-*` subagents.

---

## 5. Workflows (`.claude/workflows/`)

Run with `/setup`, `/promote`, or `/stage-demo` (or `Workflow({name})`).

- **setup.js** — Pre-flight (config + quay auth) → Investigate → Build (parallel)
  → **Record** (`record-builds` writes tags to the Sheet) → Stage (reads built rows
  via `list-built`, uses exact `image_tag`) → Deploy rolling demo.
- **promote.js** — Config (`list-built`) → Promote (retag `image_tag`) → DevImages
  PRs → Template PR.
- **stage-demo.js** — Pre-flight → Read (`list-built`) → Stage → Deploy. Carve-out
  that skips investigate + build; it reads the built rows from the Sheet (no
  hardcoded image list). Canonical flow is `/setup`.

Work-lists come from the Sheet's newest run block (§9): build reads all detected
rows; stage/promote read only `built==TRUE` rows with their exact `image_tag`.

---

## 6. Subagents (`.claude/agents/impl-*.md`)

- **impl-builder** — Build container images from `rhdh-ai-developer-images` source and push
  to quay (personal for staging, official for promotion).
- **impl-template** — Update `rhdh-ai-template` env files with new quay tags,
  regenerate templates, manage the branch/PR lifecycle on a fork.
- **impl-devimages** — Post-verification: commit new version directories to the
  `rhdh-ai-developer-images` fork and open a PR.
- **impl-rolling-demo** — Deploy rolling demo to ROSA: generate `private-env` from
  `.env`, point `values.yaml` catalog at the staged branch, commit to the
  development branch, run `make install-no-rhoai`.

All four are pinned to `model: claude-sonnet-5[1m]` (see §10).

**PR footer (mandatory):** every PR opened by `impl-template` / `impl-devimages`
must end its body with a two-line footer — the `agentic-template-ops` tool link
(`https://github.com/redhat-ai-dev/ai-template-updater`) and the Jira ticket link
(`https://issues.redhat.com/browse/<JIRA_TICKET>`). `promote.js` reads
`JIRA_TICKET` from `.env` and passes it into both PR prompts (`PR_FOOTER`); it
warns if the var is unset. Keep the tool link even when no ticket is set.

---

## 7. Python modules

- **drift_scanner.py** — `DriftScanner.investigate(candidates)` fans out over
  templates with a `ThreadPoolExecutor`. `AGENT_MAP` routes each server type to its
  agent; models go through `HfModelAgent`.
- **server_agents/** — `vllm` (GitHub releases), `llamacpp` (PyPI
  `llama-cpp-python`), `whispercpp` (GitHub `whisper.cpp`), `object_detection`
  (quay tags). Each subclasses `BaseServerAgent`.
- **model_agents/hf_model_agent.py** — HuggingFace model revision/date checks.
- **gws_client.py** — `read_template_candidates` (input), `read_pending_updates`
  (work-list from the Audit Log's newest run).
- **report.py** — `generate_version_status` writes `VERSION_STATUS.md` and the
  "Version Status" sheet (formatting, run-history, row grouping).

---

## 8. Configuration

`.env` (copy from `.env.example`; **read-only to agents, never modify**):

| Var | Purpose |
|-----|---------|
| `DEVELOPER_IMAGES_PATH` | Local `rhdh-ai-developer-images` fork (absolute) |
| `AI_LAB_TEMPLATE_PATH` | Local `rhdh-ai-template` fork (absolute) |
| `QUAY_PERSONAL_NS` | Personal quay namespace (staging pushes) |
| `QUAY_OFFICIAL_NS` | Official quay namespace (default `redhat-ai-dev`) |
| `FORK_OWNER` | GitHub fork owner (for PRs) |
| `ROLLING_DEMO_GITOPS_PATH` | Rolling-demo gitops repo (ROSA deploy) |
| `CLUSTER_API` / `CLUSTER_TOKEN` | ROSA cluster access |
| `JIRA_TICKET` | Jira key for the current cycle, stamped into every promote PR body (§6) |

`config.py` constants: `SERVER_CONFIGS` / `SERVER_NAME_MAP` (tracked server types),
`SHEET_HIDDEN_SERVERS` (server types to hide from the Model Servers display —
currently empty, so all are shown), `AUDIT_SECTION_TITLE` / `RUN_MARKER_PREFIX`
(Audit Log markers).

---

## 9. Google Sheet structure

Two tabs (the old separate `ai audit log` tab has been removed):

**`Template List`** (input) — one row per template. Key columns: `Name (Link)`,
`Model (Link)`, `Model Server (Link)`, `Deployment Target`.

**`Version Status`** (output, written by `report.py`) — three sections:

1. **Model Servers** — one row per server type/version (vllm, llamacpp, whispercpp,
   object_detection). Hide any via `SHEET_HIDDEN_SERVERS` (currently none hidden).
2. **Models (HuggingFace)** — one row per model.
3. **Audit Log** — run history. Each run = a bold summary row
   `▶ RUN <timestamp> · N updates · M checks`, followed by one item row per update,
   collapsible via row grouping. Newest run on top; capped at 20 runs.

Item-row columns (`config.AUDIT_ITEM_FIELDS`) are the machine-readable contract:
```
template, component, server_type, current_version, latest_version,
source_url, notes, built, image_tag
```
- `built` (`TRUE`/`FALSE`) + `image_tag` track build state. `investigate` writes
  `FALSE`/empty; `record-builds` flips them after a push.
- `read_pending_updates()` returns the newest run's rows (build work-list);
  `read_built_updates()` returns only `built==TRUE` rows (stage/promote work-list).
- **No approval checkbox** — every detected item is built; every built item is
  staged/promoted.

---

## 10. Vertex model configuration (IMPORTANT)

Runs against Google Vertex (`CLAUDE_CODE_USE_VERTEX=1`, project
`itpc-ca-40fc187f02`, region `global`). The **main loop** and the **workflow
subagent path** have different model availability, so they use different models:

**Orchestrator (main loop):** latest **Opus** (Opus 4.8). Set in
`.claude/settings.json` as `"model": "opus"` (resolves to `claude-opus-4-8[1m]` via
`ANTHROPIC_DEFAULT_OPUS_MODEL`). This runs the workflow control flow + the inline
runner agents' *dispatch*; the main loop can reach Opus.

**Subagents (the `impl-*` workers AND the workflow's inline runner agents):**
`claude-sonnet-5[1m]`.

- **impl-* agents pin `model: claude-sonnet-5[1m]`** in each
  `.claude/agents/impl-*.md` frontmatter; the workflow's inline `agent()` runner
  calls pin the same id. This is the reliable "sonnet 5" here.
- **Opus is NOT available on the subagent path** — `claude-opus-4-8[1m]` fails there
  with "not available." Never pin a subagent (impl-* or runner) to opus, even though
  the orchestrator uses it.
- Base `claude-sonnet-5` is flaky on this deployment — do not use it.
- `model: sonnet` (alias) resolves to **base** `claude-sonnet-5`, NOT the env
  default `claude-sonnet-5[1m]`. Write the exact id, not the alias.

**Stale agent-definition cache (read this):** editing `.claude/agents/*.md`
frontmatter mid-session does NOT reliably reload — some subagents keep firing the
*previous* edit's model id. Telltale symptom: the "model not available" error names
a model you already edited away from. **Fix: restart the Claude Code session after
editing agent frontmatter.** A single-agent probe can pass while a real (parallel)
run still uses stale defs, so don't trust one green probe — restart.

---

## 11. Operational gotchas

- **Quay login pre-flight:** setup verifies `podman login --get-login quay.io`
  before building. Builds can succeed while pushes fail if auth is missing — check
  first and prompt to `podman login quay.io`.
- **No approval gate:** every detected update auto-flows into build/stage/promote.
  Acceptable because staging pushes go to a personal quay namespace.
- **`.env` is read-only** to agents. Never modify it during a run.
- **Rolling-demo `private-env` is merge-in-place, never overwritten.** It holds
  secrets not in `.env` (GITHUB_APP_*, QUAY_DOCKERCONFIGJSON, KEYCLOAK_*, DB
  passwords, …). The deploy syncs ONLY `CLUSTER_API`/`CLUSTER_TOKEN` from `.env`
  plus `RHDH_CLUSTER_ROUTER_BASE` **derived from the live cluster**
  (`oc get ingresses.config/cluster -o jsonpath='{.spec.domain}'`) and
  `GITHUB_APP_WEBHOOK_URL` **derived from the live PAC controller route**
  (`oc get route pipelines-as-code-controller -n openshift-pipelines
  -o jsonpath='{.spec.host}'`). Both move with the cluster or the RHDH route /
  GitHub webhook land on a dead domain (DNS fails); delete the stale
  `rolling-demo-backstage` route so it regenerates. `GITHUB_APP_WEBHOOK_URL` is
  the ONLY `GITHUB_APP_*` line the deploy may touch — every other secret stays
  untouched. Never copy the `.env` path/quay block into `private-env`. After the
  deploy, `/stage-demo` returns the **webhook URL** and **callback URL**
  (`<rhdh_base>/api/auth/oidc/handler/frame`) to apply on the GitHub App.
- **Never read whole log files.** Container builds, `make install-no-rhoai`, and the
  generation/run scripts emit huge logs — reading them in full blows the context
  window. Always inspect with `rg`/`grep`/`tail`: filter to the signal (e.g.
  `tail -n 100 <log>`, `grep -C 5 -iE 'error|fail' <log>`). Never `cat`/`Read` a
  log over ~100 lines; quote only the shortest decisive lines. Applies to every
  subagent (impl-* and workflow runners).
