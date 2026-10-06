export const meta = {
  name: 'setup',
  description: 'Phases 1-3: investigate drift, build staging images, stage templates on fork',
  whenToUse: 'Run this to detect version drift and build staging images. After it completes, verify on ROSA cluster, then run /promote.',
  phases: [
    { title: 'Pre-flight', detail: 'Configure permissions, read .env' },
    { title: 'Investigate', detail: 'Check all servers/models for version drift' },
    { title: 'Build', detail: 'Build container images in parallel, push to personal quay' },
    { title: 'Record', detail: 'Record built image tags to the Sheet (source of truth)' },
    { title: 'Stage', detail: 'Update rhdh-ai-template env files with staging tags from the Sheet' },
    { title: 'Deploy', detail: 'Deploy rolling demo to ROSA cluster for testing' },
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
  required: ['developer_images_path', 'ai_lab_template_path', 'quay_personal_ns', 'quay_official_ns', 'fork_owner'],
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    updates_found: { type: 'number' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          row_index: { type: 'number' },
          template: { type: 'string' },
          component: { type: 'string' },
          server_type: { type: 'string' },
          current_version: { type: 'string' },
          latest_version: { type: 'string' },
          notes: { type: 'string' },
          source_url: { type: 'string' },
        },
        required: ['template', 'component', 'server_type', 'current_version', 'latest_version'],
      },
    },
  },
  required: ['updates_found', 'rows'],
}

const BUILD_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    server_type: { type: 'string' },
    component: { type: 'string' },
    version: { type: 'string' },
    image_tag: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['success', 'server_type', 'component', 'version'],
}

const STAGE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    branch_name: { type: 'string' },
    registration_url: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['success'],
}

const DEPLOY_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    rhdh_base_url: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['success'],
}

// list-built output: the newest run's built rows (source of truth for staging)
const BUILT_LIST_SCHEMA = {
  type: 'object',
  properties: {
    built: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          template: { type: 'string' },
          component: { type: 'string' },
          server_type: { type: 'string' },
          current_version: { type: 'string' },
          latest_version: { type: 'string' },
          image_tag: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['component', 'server_type', 'latest_version', 'image_tag'],
      },
    },
  },
  required: ['built'],
}

const TERSE = 'Be terse. No filler, no narration, no preamble. Action and result only.\n' +
  'Never read whole log files (podman build, make install-no-rhoai, generation/run scripts). ' +
  'Inspect with tail -n 100 <log> or grep -C 5 -iE "error|fail" <log>; never cat or Read a log over ~100 lines. Quote only the shortest decisive lines.\n'

// ── Phase 1: Pre-flight ──────────────────────────────────────────────

phase('Pre-flight')

const env = await agent(
  TERSE + `Run these commands and return the parsed values:
1. Run: agentic-template-ops configure
2. Read the .env file in the project root (never modify it)
3. Extract and return these values:
   - DEVELOPER_IMAGES_PATH
   - AI_LAB_TEMPLATE_PATH
   - QUAY_PERSONAL_NS
   - QUAY_OFFICIAL_NS
   - FORK_OWNER
   - ROLLING_DEMO_GITOPS_PATH (optional — return empty string if not set)

4. Verify agentic-template-ops is installed: agentic-template-ops --help

Return the extracted values as structured output.`,
  { label: 'pre-flight', model: 'claude-sonnet-5[1m]', schema: ENV_SCHEMA }
)

if (!env) {
  log('Pre-flight failed. Check .env file and agentic-template-ops installation.')
  return { status: 'failed', phase: 'pre-flight' }
}

log(`Config loaded. Personal quay: ${env.quay_personal_ns}, dev-images: ${env.developer_images_path}`)

const quayAuth = await agent(
  TERSE + `Check if podman is authenticated to quay.io for the namespace "${env.quay_personal_ns}".
Run: podman login --get-login quay.io
If it returns a username, auth is good — return authenticated: true.
If it fails or says "not logged in", return authenticated: false.`,
  {
    label: 'check-quay-auth',
    model: 'claude-sonnet-5[1m]',
    schema: {
      type: 'object',
      properties: { authenticated: { type: 'boolean' } },
      required: ['authenticated'],
    },
  }
)

if (!quayAuth || !quayAuth.authenticated) {
  log('Not authenticated to quay.io. Run: podman login quay.io — then re-run setup.')
  return { status: 'failed', phase: 'pre-flight', reason: 'quay auth missing' }
}

log('Quay auth verified.')

// ── Phase 2: Investigate ─────────────────────────────────────────────

phase('Investigate')

const audit = await agent(
  TERSE + `Run version drift investigation:
1. Run: agentic-template-ops investigate
   This checks all model servers and models for updates and writes results to Google Sheets.
2. After it completes, read the Audit Log from the Version Status sheet:
   Run: gws sheets +read --spreadsheet 11S2h__-nN4fr25DJcfDbwQWXztLG5lrywthYPoSDPyQ --range "Version Status"
3. Parse the sheet output. Find the "Audit Log" section header, then the newest run block:
   the first row starting with "▶ RUN " is the newest run; the rows below it (until the
   next "▶ RUN " row or end) are that run's update items. There is no approval gate —
   every item in the newest run is an update to process.
   Item row columns: [template, component, server_type, current_version, latest_version, source_url, notes].
4. Return updates_found count (number of item rows) and the item rows.

If no updates found, return updates_found: 0 and empty rows array.`,
  { label: 'investigate', model: 'claude-sonnet-5[1m]', schema: AUDIT_SCHEMA }
)

if (!audit || audit.updates_found === 0) {
  log('No updates found. Everything current.')
  return { status: 'current', updates_found: 0 }
}

log(`${audit.updates_found} updates found. Deduplicating for builds...`)

// ── JS dedup (zero tokens) ──────────────────────────────────────────

const uniqueServers = {}
const uniqueModels = {}

for (const row of audit.rows) {
  if (row.component === 'server') {
    const key = `${row.server_type}:${row.latest_version}`
    if (!uniqueServers[key]) uniqueServers[key] = row
  } else if (row.component === 'model') {
    const key = `${row.server_type}:${row.latest_version}`
    if (!uniqueModels[key]) uniqueModels[key] = row
  }
}

const serverList = Object.values(uniqueServers)
const modelList = Object.values(uniqueModels)

log(`Unique builds: ${serverList.length} servers, ${modelList.length} models`)

// ── Phase 3: Build ───────────────────────────────────────────────────

phase('Build')

const allBuildItems = [
  ...serverList.map(s => ({
    component: 'server',
    server_type: s.server_type,
    current_version: s.current_version,
    latest_version: s.latest_version,
    notes: s.notes || '',
  })),
  ...modelList.map(m => ({
    component: 'model',
    server_type: m.server_type,
    current_version: m.current_version,
    latest_version: m.latest_version,
    notes: m.notes || '',
  })),
]

const buildResults = await parallel(
  allBuildItems.map(item => () => {
    const isServer = item.component === 'server'
    const prompt = isServer
      ? TERSE + `Phase 3 setup. Read .env file at .env for config.
Build ONE server image and push to personal quay (quay.io/${env.quay_personal_ns}):
  server_type: ${item.server_type}
  current: ${item.current_version}
  latest: ${item.latest_version}
Developer-images repo: ${env.developer_images_path}
Copy latest version dir, update version pins, podman build, push to personal quay.
Return success/failure, server_type, component "server", version, and image_tag.`
      : TERSE + `Phase 3 setup. Read .env file at .env for config.
Build ONE model image and push to personal quay (quay.io/${env.quay_personal_ns}):
  model: ${item.server_type}
  current: ${item.current_version}
  latest: ${item.latest_version}
  notes: ${item.notes}
Developer-images repo: ${env.developer_images_path}
Update model Containerfile with new HuggingFace download URL, podman build, push.
Return success/failure, server_type, component "model", version, and image_tag.`

    return agent(prompt, {
      label: `build:${item.server_type}`,
      phase: 'Build',
      agentType: 'impl-builder',
      schema: BUILD_RESULT_SCHEMA,
    })
  })
)

const successfulBuilds = buildResults.filter(Boolean).filter(r => r.success)
const failedBuilds = buildResults.filter(Boolean).filter(r => !r.success)

if (successfulBuilds.length === 0) {
  log('All builds failed. Aborting.')
  return { status: 'failed', phase: 'build', failures: failedBuilds }
}

if (failedBuilds.length > 0) {
  log(`${failedBuilds.length} builds failed: ${failedBuilds.map(f => f.server_type).join(', ')}`)
}

log(`${successfulBuilds.length}/${allBuildItems.length} builds succeeded. Recording to Sheet...`)

// ── Record: write built image tags to the Sheet (single source of truth) ──

phase('Record')

const buildPayload = JSON.stringify(
  successfulBuilds.map(b => ({
    component: b.component,
    server_type: b.server_type,
    version: b.version,
    image_tag: b.image_tag,
    success: true,
  }))
)

// The record round-trip (record-builds → list-built) is occasionally flaky:
// a transient gws read can make list-built return [] even though the builds
// succeeded, which would otherwise throw away all build progress. So: retry
// the round-trip, and if the Sheet still comes back empty, fall back to the
// exact in-memory build tags (verbatim builder output — never reconstructed).
const recordPrompt =
  TERSE + `Record build results to the Google Sheet, then read them back.
Run these commands, in order:
1. agentic-template-ops record-builds --results '${buildPayload}'
   Note the "Recorded N built row(s)" number it prints.
2. agentic-template-ops list-built
If step 1 reports "Recorded 0" OR step 2 prints an empty array [], wait briefly
and run BOTH commands again (up to 2 more times) — this call is transient.
Return {"built": <array from the final list-built>, "recorded_count": <N from the
final record-builds>}. Do not modify or reconstruct any values.`

const RECORD_SCHEMA = {
  type: 'object',
  properties: {
    built: BUILT_LIST_SCHEMA.properties.built,
    recorded_count: { type: 'number' },
  },
  required: ['built'],
}

let recorded = await agent(recordPrompt, {
  label: 'record-builds', phase: 'Record', model: 'claude-sonnet-5[1m]', schema: RECORD_SCHEMA,
})

// One workflow-level retry on top of the agent's own internal retries.
if (!recorded || !recorded.built || recorded.built.length === 0) {
  log('Record came back empty — retrying the Sheet round-trip once...')
  recorded = await agent(recordPrompt, {
    label: 'record-builds-retry', phase: 'Record', model: 'claude-sonnet-5[1m]', schema: RECORD_SCHEMA,
  })
}

let builtRows = (recorded && recorded.built) || []
let recordedToSheet = builtRows.length > 0

if (!recordedToSheet) {
  // Sheet round-trip failed, but the builds themselves succeeded and we hold
  // their exact tags. Stage from those so the pipeline is not lost. Map the
  // build-result shape (version) to the built-row shape (latest_version).
  log('Sheet still empty after retry — falling back to in-memory build tags for staging.')
  log('WARNING: the Sheet was NOT updated. Run `agentic-template-ops record-builds` before /promote.')
  builtRows = successfulBuilds.map(b => ({
    component: b.component,
    server_type: b.server_type,
    latest_version: b.version,
    image_tag: b.image_tag,
  }))
}

log(`${builtRows.length} built rows (${recordedToSheet ? 'from Sheet' : 'from in-memory fallback'}). Staging templates...`)

// ── Stage templates (from the Sheet's built rows — exact image tags) ──

phase('Stage')

const serverSummary = JSON.stringify(
  builtRows.filter(b => b.component === 'server').map(b => ({
    server_type: b.server_type,
    version: b.latest_version,
    image_tag: b.image_tag,
  }))
)

const modelSummary = JSON.stringify(
  builtRows.filter(b => b.component === 'model').map(b => ({
    model: b.server_type,
    version: b.latest_version,
    image_tag: b.image_tag,
  }))
)

const stageResult = await agent(
  TERSE + `Phase 3 setup. Read .env file at .env for config.
Pre-verification workflow:
1. cd ${env.ai_lab_template_path}
2. Create ONE branch from main for ALL updates (servers + models together). Never create separate branches.
3. Update scripts/envs/* to use the EXACT image_tag from each entry below — do NOT reconstruct or reformat tags (they already include the correct registry, repo, and version prefix).
4. Server updates: ${serverSummary}
5. Model updates: ${modelSummary}
6. Apply ALL server and model changes to the SAME branch in a SINGLE commit.
7. Run ./scripts/import-ai-lab-samples && ./scripts/generate-no-app-template
8. Commit and push to fork (${env.fork_owner})
9. Output the RHDH registration URL

IMPORTANT: Everything goes in ONE branch, ONE commit. Use image_tag verbatim.

Return success, branch_name, and registration_url.`,
  {
    label: 'stage-templates',
    agentType: 'impl-template',
    schema: STAGE_RESULT_SCHEMA,
  }
)

if (!stageResult || !stageResult.success) {
  log('Template staging failed.')
  return { status: 'failed', phase: 'stage', builds: successfulBuilds }
}

log(`Templates staged on branch: ${stageResult.branch_name}`)
log(`Registration URL: ${stageResult.registration_url}`)

// ── Phase 5: Deploy rolling demo ────────────────────────────────────

let deployResult = null

if (!env.rolling_demo_gitops_path) {
  log('ROLLING_DEMO_GITOPS_PATH not set — skipping rolling demo deploy.')
} else {
  phase('Deploy')

  deployResult = await agent(
    TERSE + `Deploy rolling demo to ROSA cluster. Read .env at .env for config.
Rolling demo repo: ${env.rolling_demo_gitops_path}
Fork owner: ${env.fork_owner}
Template branch: ${stageResult.branch_name}

1. Do NOT overwrite scripts/private-env. It already exists and holds required
   secrets not present in .env. Edit it IN PLACE: update ONLY CLUSTER_API and
   CLUSTER_TOKEN to match .env, and sync RHDH_CLUSTER_ROUTER_BASE to the cluster
   (derive: oc login with CLUSTER_API/CLUSTER_TOKEN, then
   oc get ingresses.config/cluster -o jsonpath='{.spec.domain}'). Do NOT copy the
   "# Synced from template updater .env" path block (DEVELOPER_IMAGES_PATH,
   AI_LAB_TEMPLATE_PATH, QUAY_*, FORK_OWNER, ROLLING_DEMO_GITOPS_PATH). Leave
   every other line untouched. If private-env does not exist, generate it fresh
   from .env. If RHDH_CLUSTER_ROUTER_BASE changed, delete any stale
   rolling-demo-backstage route so it regenerates on the new domain.
2. Update values.yaml catalog location to fork branch
3. Commit to development branch, push
4. Run make install-no-rhoai

Return success and rhdh_base_url.`,
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
  }
}

return {
  status: 'staged',
  servers_built: successfulBuilds.filter(b => b.component === 'server').length,
  models_built: successfulBuilds.filter(b => b.component === 'model').length,
  build_failures: failedBuilds.map(f => f.server_type),
  recorded_to_sheet: recordedToSheet,
  registration_url: stageResult.registration_url,
  branch: stageResult.branch_name,
  rhdh_url: env.rolling_demo_gitops_path ? deployResult?.rhdh_base_url : null,
  next_step: recordedToSheet
    ? (env.rolling_demo_gitops_path
        ? 'Test templates on RHDH, then run /promote'
        : 'Verify templates on ROSA cluster, then run /promote')
    : 'ACTION REQUIRED: the Sheet was not recorded — run `agentic-template-ops record-builds` (then verify with `list-built`) BEFORE /promote, since promote reads built rows from the Sheet.',
}
