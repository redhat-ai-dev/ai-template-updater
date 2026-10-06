export const meta = {
  name: 'promote',
  description: 'Phase 5: retag images to official quay, create PRs for rhdh-ai-developer-images and rhdh-ai-template',
  whenToUse: 'Run this AFTER verifying staged templates on ROSA cluster (after /setup). Promotes staging images to production.',
  phases: [
    { title: 'Config', detail: 'Read .env and the latest audit run from Version Status' },
    { title: 'Promote', detail: 'Retag images from personal to official quay in parallel' },
    { title: 'DevImages', detail: 'Commit version dirs to rhdh-ai-developer-images, create PRs (sequential)' },
    { title: 'Templates', detail: 'Update rhdh-ai-template to official tags, create upstream PR' },
  ],
}

const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    developer_images_path: { type: 'string' },
    ai_lab_template_path: { type: 'string' },
    quay_personal_ns: { type: 'string' },
    quay_official_ns: { type: 'string' },
    fork_owner: { type: 'string' },
    jira_ticket: { type: 'string' },
    rows: {
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
          source_url: { type: 'string' },
        },
        required: ['component', 'server_type', 'latest_version', 'image_tag'],
      },
    },
  },
  required: ['developer_images_path', 'ai_lab_template_path', 'quay_personal_ns', 'quay_official_ns', 'fork_owner', 'rows'],
}

const PROMOTE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    server_type: { type: 'string' },
    component: { type: 'string' },
    version: { type: 'string' },
    official_tag: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['success', 'server_type', 'component', 'version'],
}

const DEVIMAGES_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    server_type: { type: 'string' },
    version: { type: 'string' },
    pr_url: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['success', 'server_type', 'version'],
}

const TEMPLATE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    pr_url: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['success'],
}

const TERSE = 'Be terse. No filler, no narration, no preamble. Action and result only.\n' +
  'Never read whole log files (podman build, make install-no-rhoai, generation/run scripts). ' +
  'Inspect with tail -n 100 <log> or grep -C 5 -iE "error|fail" <log>; never cat or Read a log over ~100 lines. Quote only the shortest decisive lines.\n'

// ── Phase 1: Read Config ─────────────────────────────────────────────

phase('Config')

const config = await agent(
  TERSE + `Read configuration for Phase 5 promote:
1. Read .env file in project root (never modify it). Extract:
   - DEVELOPER_IMAGES_PATH, AI_LAB_TEMPLATE_PATH
   - QUAY_PERSONAL_NS, QUAY_OFFICIAL_NS, FORK_OWNER
   - JIRA_TICKET (return as jira_ticket; empty string if the line is absent)
2. Read the built updates (source of truth) from the Sheet:
   Run: agentic-template-ops list-built
   This prints a JSON array of the newest run's BUILT rows, each with an exact
   image_tag (the personal-quay image to promote). Only built images are returned.
3. Return config values + that array as "rows" (one per built item). Do not modify image_tag.`,
  { label: 'read-config', model: 'claude-sonnet-5[1m]', schema: CONFIG_SCHEMA }
)

if (!config || !config.rows || config.rows.length === 0) {
  log('No built images to promote. Run /setup (Build+Record) first.')
  return { status: 'nothing_to_promote' }
}

log(`${config.rows.length} updates to promote. Deduplicating...`)

// Every promote PR body MUST end with this footer: tool provenance + Jira.
const TOOL_URL = 'https://github.com/redhat-ai-dev/ai-template-updater'
const jiraLine = config.jira_ticket
  ? `Jira: [${config.jira_ticket}](https://issues.redhat.com/browse/${config.jira_ticket})`
  : 'Jira: (none set — add JIRA_TICKET to .env)'
const PR_FOOTER = `\n\n---\nTooling: [agentic-template-ops](${TOOL_URL}) (Phase 5)\n${jiraLine}`
if (!config.jira_ticket) log('WARNING: JIRA_TICKET not set in .env — PRs will omit the Jira link.')

// ── JS dedup ─────────────────────────────────────────────────────────

const uniqueServers = {}
const uniqueModels = {}

for (const row of config.rows) {
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

log(`Unique promotes: ${serverList.length} servers, ${modelList.length} models`)

// ── Phase 2: Promote Images (parallel retag) ─────────────────────────

phase('Promote')

const allPromoteItems = [
  ...serverList.map(s => ({ component: 'server', ...s })),
  ...modelList.map(m => ({ component: 'model', ...m })),
]

const promoteResults = await parallel(
  allPromoteItems.map(item => () => {
    const isServer = item.component === 'server'
    const prompt = isServer
      ? TERSE + `Phase 5 promote. Read .env file at .env for config.
Retag ONE server image to official quay (quay.io/${config.quay_official_ns}) and push.
  source_image: ${item.image_tag}
  server_type: ${item.server_type}
  version: ${item.latest_version}
Use source_image EXACTLY as the retag source. The official tag keeps the same repo
name and tag but swaps the namespace to ${config.quay_official_ns}.
Return success, server_type, component "server", version, and official_tag.`
      : TERSE + `Phase 5 promote. Read .env file at .env for config.
Retag ONE model image to official quay (quay.io/${config.quay_official_ns}) and push.
  source_image: ${item.image_tag}
  model: ${item.server_type}
  version: ${item.latest_version}
Use source_image EXACTLY as the retag source. The official tag keeps the same repo
name and tag but swaps the namespace to ${config.quay_official_ns}.
Return success, server_type, component "model", version, and official_tag.`

    return agent(prompt, {
      label: `promote:${item.server_type}`,
      phase: 'Promote',
      agentType: 'impl-builder',
      schema: PROMOTE_RESULT_SCHEMA,
    })
  })
)

const promoted = promoteResults.filter(Boolean).filter(r => r.success)
const promoteFailed = promoteResults.filter(Boolean).filter(r => !r.success)

if (promoted.length === 0) {
  log('All promotions failed. Aborting.')
  return { status: 'failed', phase: 'promote', failures: promoteFailed }
}

if (promoteFailed.length > 0) {
  log(`${promoteFailed.length} promotions failed: ${promoteFailed.map(f => f.server_type).join(', ')}`)
}

log(`${promoted.length}/${allPromoteItems.length} images promoted to official quay.`)

// ── Phase 3: Commit Dev Images (sequential — shared git working tree) ──

phase('DevImages')

const devimagesResults = []

for (let i = 0; i < serverList.length; i++) {
  const server = serverList[i]
  log(`DevImages ${i + 1}/${serverList.length}: ${server.server_type} ${server.latest_version}`)

  const result = await agent(
    TERSE + `Phase 5 promote. Read .env file at .env for config.
Commit version directory for ONE server in ${config.developer_images_path} and create PR to upstream redhat-developer/rhdh-ai-developer-images.
Fork owner: ${config.fork_owner}
  server_type: ${server.server_type}
  version: ${server.latest_version}
The PR body MUST end with this exact footer (verbatim, including the links):${PR_FOOTER}
Return success, server_type, version, and pr_url.`,
    {
      label: `devimages:${server.server_type}`,
      agentType: 'impl-devimages',
      schema: DEVIMAGES_RESULT_SCHEMA,
    }
  )

  devimagesResults.push(result)
}

const devimagesSuccess = devimagesResults.filter(Boolean).filter(r => r.success)
const devimagesFailed = devimagesResults.filter(Boolean).filter(r => !r.success)

if (devimagesFailed.length > 0) {
  log(`${devimagesFailed.length} dev-images PRs failed: ${devimagesFailed.map(f => f.server_type).join(', ')}`)
}

log(`${devimagesSuccess.length}/${serverList.length} dev-images PRs created.`)

// ── Phase 4: Update Templates (official tags + upstream PR) ──────────

phase('Templates')

const serverSummary = JSON.stringify(
  promoted.filter(p => p.component === 'server').map(p => ({
    server_type: p.server_type,
    current: config.rows.find(r => r.server_type === p.server_type)?.current_version,
    latest: p.version,
    image_tag: p.official_tag,
  }))
)

const modelSummary = JSON.stringify(
  promoted.filter(p => p.component === 'model').map(p => ({
    model: p.server_type,
    current: config.rows.find(r => r.server_type === p.server_type)?.current_version,
    latest: p.version,
    image_tag: p.official_tag,
  }))
)

const templateResult = await agent(
  TERSE + `Phase 5 promote. Read .env file at .env for config.
Post-verification workflow:
1. Use the EXISTING branch (from setup phase) — do NOT create a new branch. Check out the most recent update-all-* branch.
2. Update scripts/envs/* to use the EXACT image_tag from each entry below (the official quay tags) — do NOT reconstruct tags. ALL server and model changes in ONE commit.
3. Server updates: ${serverSummary}
4. Model updates: ${modelSummary}
5. Re-run generation scripts
6. Commit, push, create PR to upstream redhat-developer/rhdh-ai-template
Fork owner: ${config.fork_owner}

IMPORTANT: Everything in ONE branch, ONE commit. Use image_tag verbatim. Never split servers and models into separate branches.

The PR body MUST end with this exact footer (verbatim, including the links):${PR_FOOTER}

Return success and pr_url.`,
  {
    label: 'template-pr',
    agentType: 'impl-template',
    schema: TEMPLATE_RESULT_SCHEMA,
  }
)

if (!templateResult || !templateResult.success) {
  log('Template PR creation failed.')
}

// ── Summary ──────────────────────────────────────────────────────────

const prs = [
  ...(devimagesSuccess.map(d => ({ repo: 'rhdh-ai-developer-images', type: d.server_type, url: d.pr_url }))),
  ...(templateResult && templateResult.success ? [{ repo: 'rhdh-ai-template', type: 'templates', url: templateResult.pr_url }] : []),
]

return {
  status: promoted.length === allPromoteItems.length ? 'success' : 'partial',
  promoted: promoted.length,
  failed: promoteFailed.map(f => f.server_type),
  prs: prs,
}
