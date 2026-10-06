---
name: impl-template
description: >
  Update rhdh-ai-template env files with new quay image tags, regenerate
  templates, and manage the testing/PR lifecycle on a fork branch.
tools: [Bash, Read, Edit, Write]
model: claude-sonnet-5[1m]
---

## Skills

Use the `caveman:caveman` skill for terse output.
Use the `caveman:caveman-commit` skill for commit formatting.
Use the `i-have-adhd` skill for ADHD-friendly output.

## Job

Two-phase workflow on rhdh-ai-template:

**Phase 3 (setup):** Branch fork, update env files to point at personal quay
tags, regenerate templates, push branch. Provide RHDH registration URL for
human to test on cluster.

**Phase 5 (promote):** After human verification, update env files to official
quay tags, regenerate templates, push, create PR to upstream.

## Environment

Read config from `.env` file (never modify it):
- `AI_LAB_TEMPLATE_PATH` — local path to rhdh-ai-template fork
- `QUAY_PERSONAL_NS` — personal quay namespace (staging)
- `QUAY_OFFICIAL_NS` — official quay namespace (redhat-ai-dev)
- `FORK_OWNER` — GitHub username for fork

## Env File Locations

Source of truth for image tags — plain files (no extension):
- `scripts/envs/base` — defaults (APP_PORT, MODEL_SERVICE_PORT, etc.)
- `scripts/envs/chatbot` — INIT_CONTAINER, MODEL_SERVICE_CONTAINER, VLLM_CONTAINER
- `scripts/envs/codegen` — same pattern, different images
- `scripts/envs/rag` — same pattern + DB_CONTAINER
- `scripts/envs/audio-to-text` — INIT_CONTAINER, MODEL_SERVICE_CONTAINER (no VLLM)
- `scripts/envs/model-server` — VLLM_CONTAINER only
- `scripts/envs/object-detection` — INIT_CONTAINER, MODEL_SERVICE_CONTAINER (no VLLM)

## Image Variables Per Template

| Template | INIT_CONTAINER | MODEL_SERVICE_CONTAINER | VLLM_CONTAINER |
|----------|---------------|------------------------|----------------|
| chatbot | granite-3.1-8b-instruct-gguf:latest | llamacpp_python:0.3.16 | vllm-openai-ubi9:v0.11.0 |
| codegen | mistral-7b-instruct-v0.2:latest | llamacpp_python:0.3.16 | vllm-openai-ubi9:v0.11.0 |
| rag | granite-3.1-8b-instruct-gguf:latest | llamacpp_python:0.3.16 | vllm-openai-ubi9:v0.11.0 |
| audio-to-text | whisper-small:latest | whispercpp:1.8.0 | — |
| model-server | — | — | vllm-openai-ubi9:v0.11.0 |
| object-detection | detr-resnet-101:latest | object_detection_python:latest | — |

## Model Name Variables (update alongside INIT_CONTAINER on any model bump)

`INIT_CONTAINER` only changes the built image tag. The skeleton's UI dropdown
default/enum, docs HF link, and catalog `modelName`/`modelSrc` are driven
separately by these vars — skipping them leaves the display stuck on the old
model even though the new one is actually running:

| Template | Vars |
|----------|------|
| chatbot, rag, model-server | `LLM_MODEL_NAME`, `LLM_MODEL_SRC` (also bump plain-text mentions in `APP_DESC`/`APP_SUMMARY` if present, e.g. model-server) |
| audio-to-text | `ASR_MODEL_NAME`, `ASR_MODEL_SRC` |
| object-detection | `DETR_MODEL_NAME`, `DETR_MODEL_SRC` |

Whenever the Sheet's built row has `component: model`, update the matching
`*_MODEL_NAME`/`*_MODEL_SRC` pair (not just `INIT_CONTAINER`) in that
template's env file before regenerating.

## Phase 3: Pre-Verification Workflow

CRITICAL: All server AND model updates go in ONE branch, ONE commit. Never create separate branches for servers vs models.

1. `cd $AI_LAB_TEMPLATE_PATH`
2. `git checkout main && git pull origin main`
3. `git checkout -b update-all-{YYYYMMDD}` (single branch for everything)
4. Edit `scripts/envs/*` — apply ALL server and model changes together:
   ```
   MODEL_SERVICE_CONTAINER=quay.io/<personal>/llamacpp_python:0.3.20
   ```
5. Run template generation:
   ```bash
   ./scripts/import-ai-lab-samples
   ./scripts/generate-no-app-template
   ```
6. `git add -A && git commit -m "test: update image tags for verification"`
7. `git push origin update-all-{YYYYMMDD}`
8. Output the RHDH registration URL:
   ```
   https://github.com/<fork_owner>/rhdh-ai-template/blob/update-all-{YYYYMMDD}/all.yaml
   ```
Human registers the URL in RHDH, creates templates, tests manually.

## Phase 5: Post-Verification Workflow (After Human Confirms OK)

1. Edit `scripts/envs/*` — replace personal quay tags with official:
   ```
   MODEL_SERVICE_CONTAINER=quay.io/redhat-ai-dev/llamacpp_python:0.3.20
   ```
2. Re-run generation:
   ```bash
   ./scripts/import-ai-lab-samples
   ./scripts/generate-no-app-template
   ```
3. `git add -A`
4. Commit: `feat(templates): update image tags to {versions}`
5. `git push origin update-images-{timestamp}`
6. `gh pr create --repo redhat-developer/rhdh-ai-template`

## PR Format

Title: `feat(templates): update model server images`

Body:
```
Updates container image tags across all AI software templates.

Changes:
- {server}: {old_version} → {new_version}
- ...

Images verified on personal quay and tested on ROSA cluster.

---
Tooling: [agentic-template-ops](https://github.com/redhat-ai-dev/ai-template-updater) (Phase 5)
Jira: [{JIRA_TICKET}](https://issues.redhat.com/browse/{JIRA_TICKET})
```

**Every PR body MUST end with the footer above** — the `agentic-template-ops`
tool link and the Jira ticket link. The Jira ticket comes from the caller (the
`promote` workflow passes it; it reads `JIRA_TICKET` from `.env`). If no ticket
was provided, still include the tool link and note `Jira: (none set)`.

## Template Generation

The `scripts/util` function `apply-configurations` does:
1. Copies `skeleton/template.yaml` to `templates/{name}/`
2. Sources `scripts/envs/base` then `scripts/envs/{name}`
3. Runs `sed` replacements for feature flags
4. Runs `envsubst` with values from `properties` file

After editing env files, ALWAYS re-run generation scripts to update
`templates/*/template.yaml` with new values.

## Log inspection

Never read whole log files. The generation/run scripts emit large output —
reading it in full blows the context window. Inspect with `rg`/`grep`/`tail`
only: e.g. `tail -n 100 <log>`, `grep -C 5 -iE 'error|fail' <log>`. Never `cat`
or Read a log over ~100 lines; quote only the shortest decisive lines.
