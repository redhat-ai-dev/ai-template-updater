---
name: impl-devimages
description: >
  After images are verified on cluster, commit new version directories
  to rhdh-ai-developer-images fork and create PR. Runs post-verification only.
tools: [Bash, Read, Edit, Write]
model: claude-sonnet-5[1m]
---

## Skills

Use the `caveman:caveman` skill for terse output.
Use the `caveman:caveman-commit` skill for commit formatting.
Use the `i-have-adhd` skill for ADHD-friendly output.

## Job

**Phase 5 only.** After images have been built (Phase 3), tested on personal
quay, and verified on ROSA cluster (Phase 4), commit new version directories
to rhdh-ai-developer-images fork and create PR to upstream.

## Environment

Read config from `.env` file (never modify it):
- `DEVELOPER_IMAGES_PATH` — local path to rhdh-ai-developer-images fork
- `FORK_OWNER` — GitHub username for fork (PR source)

## Repository Structure

`redhat-developer/rhdh-ai-developer-images`:
- `model-servers/vllm/{version}/` — Containerfile, requirements.txt, Pipfile, gitops/
- `model-servers/llamacpp_python/{version}/` — config.env, Containerfile, src/requirements.txt, src/run.sh
- `model-servers/whispercpp/{version}/` — config.env, Containerfile, src/run.sh
- `models/{model-name}/` — config.env, Containerfile

Note: vllm directories have NO config.env. All others do.

## config.env Convention

```
IMAGE_NAME=quay.io/redhat-ai-dev/{image_name}
IMAGE_TAG={version}
```

## Workflow

By this point, impl-builder has already created the new version directory
locally with updated files. This agent just commits and creates the PR.

1. `cd $DEVELOPER_IMAGES_PATH`
2. `git status --porcelain` — verify only expected version dirs are changed
3. `git checkout main && git pull origin main`
4. `git checkout -b update-{server}-{version}`
5. `git add model-servers/{server}/{new_version}/` (or `models/{model}/`)
6. Commit with message: `feat(server): add {server} {version}`
7. `git push origin update-{server}-{version}`
8. `gh pr create --repo redhat-developer/rhdh-ai-developer-images`

## PR Format

Title: `feat({server}): add {server} {version} version directory`

Body:
```
Adds version directory for {server} {version}.

Images verified on personal quay and tested on cluster.
Quay tags: quay.io/redhat-ai-dev/{image}:{tag}

---
Tooling: [agentic-template-ops](https://github.com/redhat-ai-dev/ai-template-updater) (Phase 5)
Jira: [{JIRA_TICKET}](https://issues.redhat.com/browse/{JIRA_TICKET})
```

**Every PR body MUST end with the footer above** — the `agentic-template-ops`
tool link and the Jira ticket link. The Jira ticket comes from the caller (the
`promote` workflow passes it; it reads `JIRA_TICKET` from `.env`). If no ticket
was provided, still include the tool link and note `Jira: (none set)`.

## Log inspection

Never read whole log files. `git`/`gh` and any build output can be large —
reading in full blows the context window. Inspect with `rg`/`grep`/`tail` only:
e.g. `tail -n 100 <log>`, `grep -C 5 -iE 'error|fail' <log>`. Never `cat` or
Read a log over ~100 lines; quote only the shortest decisive lines.
