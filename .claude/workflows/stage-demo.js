export const meta = {
  name: 'stage-demo',
  description: 'Deploy the rolling demo against the staging branch that /setup already pushed (reuse, do not re-stage). Skips investigate + build + stage.',
  whenToUse: 'Run after /setup has staged a branch (env files edited, regenerated, pushed to the fork) and you only need to deploy the rolling demo for testing. Reuses the most recent update-all-* branch on the fork; pass args.branch to pin a specific one.',
  phases: [
    { title: 'Pre-flight', detail: 'Read .env config' },
    { title: 'Find branch', detail: 'Locate the most recent update-all-* staging branch on the fork' },
    { title: 'Deploy', detail: 'Deploy rolling demo to ROSA cluster against that branch' },
  ],
}

const ENV_SCHEMA = {
  type: 'object',
  properties: {
    developer_images_path: { type: 'string' },
    ai_lab_template_path: { type: 'string' },
    quay_personal_ns: { type: 'string' },
    quay_official_ns: { type: 'string' },
    fork_owner: { type: 'string' },
    rolling_demo_gitops_path: { type: 'string' },
  },
  required: ['ai_lab_template_path', 'quay_personal_ns', 'fork_owner'],
}

// Result of discovering the staging branch /setup already pushed to the fork.
const FIND_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    branch_name: { type: 'string' },
    registration_url: { type: 'string' },
    candidates: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
  required: ['success'],
}

const DEPLOY_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    rhdh_base_url: { type: 'string' },
    github_webhook_url: { type: 'string' },
    rhdh_callback_url: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['success'],
}

const TERSE = 'Be terse. No filler, no narration, no preamble. Action and result only.\n' +
  'Never read whole log files (podman build, make install-no-rhoai, generation/run scripts). ' +
  'Inspect with tail -n 100 <log> or grep -C 5 -iE "error|fail" <log>; never cat or Read a log over ~100 lines. Quote only the shortest decisive lines.\n'

// Optional pin: Workflow({ name: 'stage-demo', args: { branch: 'update-all-20260819' } })
const pinnedBranch = (args && args.branch) ? String(args.branch) : ''

// ── Phase 1: Pre-flight ──────────────────────────────────────────────

phase('Pre-flight')

const env = await agent(
  TERSE + `Read config for a deploy run:
1. Run: agentic-template-ops configure
2. Read the .env file in the project root (never modify it)
3. Extract and return:
   - DEVELOPER_IMAGES_PATH
   - AI_LAB_TEMPLATE_PATH
   - QUAY_PERSONAL_NS
   - QUAY_OFFICIAL_NS
   - FORK_OWNER
   - ROLLING_DEMO_GITOPS_PATH (optional — empty string if unset)
Return the extracted values as structured output.`,
  { label: 'pre-flight', model: 'claude-sonnet-5[1m]', schema: ENV_SCHEMA }
)

if (!env) {
  log('Pre-flight failed. Check .env and agentic-template-ops installation.')
  return { status: 'failed', phase: 'pre-flight' }
}

log(`Config loaded. Fork: ${env.fork_owner}, template: ${env.ai_lab_template_path}`)

// ── Phase 2: Find the staging branch /setup already pushed ───────────

phase('Find branch')

const pinInstruction = pinnedBranch
  ? `A specific branch was requested: "${pinnedBranch}". Verify it exists on the fork remote (origin) and use it. If it does not exist, return success=false with an error.`
  : `Pick the MOST RECENT branch matching update-all-* (staging branches from /setup). Sort by committer date, newest first, and take the top one. If none exist, return success=false with an error saying to run /setup first.`

const found = await agent(
  TERSE + `Find the rhdh-ai-template staging branch that /setup already pushed to the fork. Do NOT edit any files, do NOT create or push branches — read-only discovery.

1. cd ${env.ai_lab_template_path}
2. git fetch origin --prune   (origin is the fork, ${env.fork_owner})
3. List remote staging branches:
   git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/remotes/origin/update-all-*'
4. ${pinInstruction}
5. Strip any leading "origin/" from the chosen branch name.
6. Build the RHDH registration URL:
   https://github.com/${env.fork_owner}/rhdh-ai-template/blob/<branch>/all.yaml

Return success, branch_name (no origin/ prefix), registration_url, and candidates (the full sorted list you found).`,
  { label: 'find-branch', agentType: 'impl-template', schema: FIND_RESULT_SCHEMA }
)

if (!found || !found.success || !found.branch_name) {
  log('No staging branch found on the fork. Run /setup first (or pass args.branch).')
  return { status: 'failed', phase: 'find-branch', error: found && found.error }
}

if (found.candidates && found.candidates.length > 1) {
  log(`${found.candidates.length} update-all-* branches on the fork; using most recent: ${found.branch_name}`)
} else {
  log(`Reusing staging branch: ${found.branch_name}`)
}
log(`Registration URL: ${found.registration_url}`)

// ── Phase 3: Deploy rolling demo ────────────────────────────────────

let deployResult = null

if (!env.rolling_demo_gitops_path) {
  log('ROLLING_DEMO_GITOPS_PATH not set — skipping rolling demo deploy.')
} else {
  phase('Deploy')

  deployResult = await agent(
    TERSE + `Deploy rolling demo to ROSA cluster. Read .env at .env for config.
Rolling demo repo: ${env.rolling_demo_gitops_path}
Fork owner: ${env.fork_owner}
Template branch: ${found.branch_name}

1. Do NOT overwrite scripts/private-env. It already exists and holds required
   secrets not present in .env. Edit it IN PLACE: update ONLY CLUSTER_API and
   CLUSTER_TOKEN to match .env, sync RHDH_CLUSTER_ROUTER_BASE to the cluster
   (derive: oc login with CLUSTER_API/CLUSTER_TOKEN, then
   oc get ingresses.config/cluster -o jsonpath='{.spec.domain}'), and sync
   GITHUB_APP_WEBHOOK_URL to the live PAC controller route
   (oc get route pipelines-as-code-controller -n openshift-pipelines
   -o jsonpath='{.spec.host}'; fall back to
   pipelines-as-code-controller-openshift-pipelines.<domain>) — it moves with the
   cluster too. Leave all other GITHUB_APP_* secrets untouched. Do NOT copy the
   "# Synced from template updater .env" path block (DEVELOPER_IMAGES_PATH,
   AI_LAB_TEMPLATE_PATH, QUAY_*, FORK_OWNER, ROLLING_DEMO_GITOPS_PATH). Leave
   every other line untouched. If private-env does not exist, generate it fresh
   from .env. If RHDH_CLUSTER_ROUTER_BASE changed, delete any stale
   rolling-demo-backstage route so it regenerates on the new domain.
2. Update values.yaml catalog location to fork branch
3. Commit to development branch, push
4. Run make install-no-rhoai

Return success, rhdh_base_url, github_webhook_url (the synced PAC route), and
rhdh_callback_url (<rhdh_base_url>/api/auth/oidc/handler/frame).`,
    {
      label: 'deploy-rolling-demo',
      agentType: 'impl-rolling-demo',
      schema: DEPLOY_RESULT_SCHEMA,
    }
  )

  if (!deployResult || !deployResult.success) {
    log('Rolling demo deploy failed. Check agent output for details.')
  } else {
    log(`Rolling demo deployed: ${deployResult.rhdh_base_url}`)
    log('Apply these on your GitHub App:')
    log(`  Webhook URL:  ${deployResult.github_webhook_url}`)
    log(`  Callback URL: ${deployResult.rhdh_callback_url}`)
  }
}

return {
  status: 'deployed',
  branch: found.branch_name,
  registration_url: found.registration_url,
  rhdh_url: env.rolling_demo_gitops_path ? deployResult?.rhdh_base_url : null,
  github_webhook_url: env.rolling_demo_gitops_path ? deployResult?.github_webhook_url : null,
  rhdh_callback_url: env.rolling_demo_gitops_path ? deployResult?.rhdh_callback_url : null,
  next_step: 'Apply the webhook + callback URLs on your GitHub App, test templates on RHDH, then run /promote',
}
