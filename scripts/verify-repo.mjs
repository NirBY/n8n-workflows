import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

function readText(file) {
  return readFileSync(path.join(root, file), 'utf8');
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walk(dir, predicate = () => true) {
  const absoluteDir = path.join(root, dir);
  if (!existsSync(absoluteDir)) return [];

  const results = [];
  for (const name of readdirSync(absoluteDir)) {
    const relative = path.join(dir, name).replaceAll('\\', '/');
    const absolute = path.join(root, relative);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      results.push(...walk(relative, predicate));
    } else if (predicate(relative)) {
      results.push(relative);
    }
  }
  return results.sort();
}

const textFileExtensions = new Set([
  '.env',
  '.example',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
]);

const secretNamePattern = /(?:api[_-]?key|auth[_-]?token|client[_-]?secret|credential|encryption[_-]?key|password|private[_-]?key|secret|token)/i;
const placeholderPattern = /(?:change-me|dummy|example|placeholder|replace|sample|test|your_|xxx|random|use-a-long)/i;
const knownSecretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
];

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function candidateSecretValue(value) {
  return value
    .replace(/^['"`]+|['"`;,]+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function verifyNoCredentialLeaks() {
  const files = walk('.', (file) => {
    if (file.startsWith('.git/')) return false;
    if (file.includes('/node_modules/') || file.includes('/dist/')) return false;
    const extension = path.extname(file).toLowerCase();
    return textFileExtensions.has(extension) || file.endsWith('.env.example');
  });

  let findings = 0;
  for (const file of files) {
    if (file === 'scripts/verify-repo.mjs') continue;
    const lines = readText(file).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (
        file === 'scripts/verify-repo.mjs' &&
        /knownSecretPatterns|secretNamePattern|placeholderPattern|credential leak scanner/i.test(line)
      ) {
        continue;
      }
      if (!line.trim() || line.trim().startsWith('#') || placeholderPattern.test(line)) continue;

      for (const pattern of knownSecretPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          findings += 1;
          fail(`${file}:${index + 1} looks like a hardcoded secret`);
        }
      }

      if (!secretNamePattern.test(line)) continue;
      if (/\$env\.|process\.env|secrets\./.test(line)) continue;

      const assignment = line.match(/[:=]\s*([^#\s,}]+)/);
      if (!assignment) continue;

      const value = candidateSecretValue(assignment[1]);
      if (value.includes('$') || value.includes('<') || value.includes('>')) continue;
      if (value.length < 20 || placeholderPattern.test(value)) continue;
      if (shannonEntropy(value) >= 3.6) {
        findings += 1;
        fail(`${file}:${index + 1} has a high-entropy value assigned to a secret-like name`);
      }
    }
  }

  if (findings === 0) pass('credential leak scanner found no hardcoded secrets');
}

function verifyWorkflowJson(file) {
  const workflow = readJson(file);
  if (!workflow) return;

  if (!workflow.name || typeof workflow.name !== 'string') {
    fail(`${file} must have a workflow name`);
  }

  if (!Array.isArray(workflow.nodes)) {
    fail(`${file} must have a nodes array`);
    return;
  }

  const names = new Set();
  const ids = new Set();
  for (const node of workflow.nodes) {
    if (!node.name) fail(`${file} has a node without a name`);
    if (!node.id) fail(`${file} has node ${node.name || '<unnamed>'} without an id`);

    if (node.name && names.has(node.name)) fail(`${file} has duplicate node name ${node.name}`);
    if (node.id && ids.has(node.id)) fail(`${file} has duplicate node id ${node.id}`);

    if (node.name) names.add(node.name);
    if (node.id) ids.add(node.id);
  }

  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    if (!names.has(source)) fail(`${file} connection source does not exist: ${source}`);

    for (const [outputType, groups] of Object.entries(outputs || {})) {
      if (!Array.isArray(groups)) {
        fail(`${file} connection ${source}.${outputType} must be an array`);
        continue;
      }

      for (const group of groups) {
        for (const connection of group || []) {
          if (!names.has(connection.node)) {
            fail(`${file} connection target does not exist: ${source} -> ${connection.node}`);
          }
        }
      }
    }
  }

  pass(`${file} workflow JSON is structurally valid`);
}

function verifyProductivityApprovalGate(file) {
  const workflow = readJson(file);
  if (!workflow) return;

  const mutationTools = [
    'Draft_Email',
    'Send_Email',
    'Book_Meeting',
    'Update_Meeting',
    'Cancel_Meeting',
  ];

  for (const tool of mutationTools) {
    if (workflow.connections?.[tool]?.ai_tool) {
      fail(`${file} must not connect ${tool} directly as an AI tool`);
    }
  }

  const connections = workflow.connections || {};
  const telegramTargets =
    connections['Prepare Telegram Approval Notice']?.main?.[0]?.map((connection) => connection.node) ?? [];
  if (!telegramTargets.includes('Send Telegram Approval Notice')) {
    fail(`${file} must send Telegram approval notices from the approval formatter`);
  }

  const nodeNames = new Set(workflow.nodes.map((node) => node.name));
  const normalizerCode = workflow.nodes.find((node) => node.name === 'Normalize Incoming Command')?.parameters?.jsCode ?? '';
  if (
    !normalizerCode.includes('agentSessions') ||
    !nodeNames.has('Inbox Memory') ||
    !nodeNames.has('Calendar Memory') ||
    !workflow.connections?.['Inbox Memory']?.ai_memory ||
    !workflow.connections?.['Calendar Memory']?.ai_memory
  ) {
    fail(`${file} must partition supervisor, inbox, and calendar session memory`);
  }

  pass(`${file} enforces the Gmail/Calendar approval gate`);
}

const jsonFiles = walk('.', (file) => file.endsWith('.json') && !file.startsWith('.git/'));
for (const file of jsonFiles) readJson(file);
pass(`parsed ${jsonFiles.length} JSON files`);
verifyNoCredentialLeaks();

for (const file of walk('staging', (file) => file.endsWith('.json'))) {
  verifyWorkflowJson(file);
}
for (const file of walk('production', (file) => file.endsWith('.json'))) {
  verifyWorkflowJson(file);
}
for (const file of walk('controller', (file) => file.endsWith('.json'))) {
  verifyWorkflowJson(file);
}
for (const file of [
  'staging/personal-productivity-safe.json',
  'production/personal-productivity-safe.json',
]) {
  verifyProductivityApprovalGate(file);
}

if (existsSync(path.join(root, 'staging/github-staging-approval-deploy.json'))) {
  fail('deploy controller must not live in staging/');
} else {
  pass('deploy controller is outside staging/');
}

const errorRouterWorkflow = readJson('controller/global-error-router.json');
const errorRouterNodeTypes = new Set(errorRouterWorkflow?.nodes?.map((node) => node.type) ?? []);
if (
  !errorRouterNodeTypes.has('n8n-nodes-base.errorTrigger') ||
  !errorRouterWorkflow?.connections?.['Global Error Trigger']?.main ||
  !readText('controller/global-error-router.json').includes('N8N_ERROR_DLQ_PATH') ||
  !readText('controller/global-error-router.json').includes('Response body:')
) {
  fail('global error router must use an Error Trigger, write a DLQ record, and send a Telegram alert with failure response body when present');
} else {
  pass('global error router template is present');
}

const controller = readText('controller/github-staging-approval-deploy.json');
if (controller.includes('curl -fsSL')) {
  fail('deploy controller must not depend on curl inside the n8n container');
} else {
  pass('deploy controller does not depend on curl');
}

const controllerWorkflow = readJson('controller/github-staging-approval-deploy.json');
const productionPromotionCode = controllerWorkflow?.nodes
  ?.find((node) => node.name === 'Prepare Production Promotion')
  ?.parameters
  ?.jsCode ?? '';
const stagingImportCode = controllerWorkflow?.nodes
  ?.find((node) => node.name === 'Prepare Staging Import')
  ?.parameters
  ?.jsCode ?? '';
const telegramApprovalBody = controllerWorkflow?.nodes
  ?.find((node) => node.name === 'Telegram Approval Request')
  ?.parameters
  ?.jsonBody ?? '';

if (
  !productionPromotionCode.includes('(n8n export:workflow --all') ||
  !productionPromotionCode.includes('crypto.randomUUID()') ||
  !productionPromotionCode.includes('w.isArchived!==true') ||
  !productionPromotionCode.includes('w.archived!==true')
) {
  fail('deploy controller must reuse non-archived production workflow ids and create fresh ids otherwise');
} else {
  pass('deploy controller handles production workflow ids safely');
}

if (
  !productionPromotionCode.includes('Refusing unsafe workflow filename') ||
  !productionPromotionCode.includes('node.credentials=previous.credentials') ||
  !productionPromotionCode.includes('git -C "$REPO_DIR" commit') ||
  !productionPromotionCode.includes('git -C "$REPO_DIR" push')
) {
  fail('deploy controller must validate approval filenames, preserve production credentials, and git-sync promoted production workflows');
} else {
  pass('deploy controller validates approval input, preserves credentials, and git-syncs production promotions');
}

if (
  !stagingImportCode.includes('/webhook/deploy-approval?id=') ||
  !stagingImportCode.includes('/files/approvals/deploy-') ||
  !controllerWorkflow?.nodes?.some((node) => node.name === 'Deployment Approval Backoffice') ||
  telegramApprovalBody.includes('workflow-promote-production')
) {
  fail('deploy controller must send Telegram only a short backoffice approval link');
} else {
  pass('deploy controller uses short Telegram approval links and a backoffice overview');
}

for (const required of [
  'DEPLOY_PUBLISH_STAGING',
  'N8N_BLOCK_ENV_ACCESS_IN_NODE',
  'N8N_PROXY_HOPS',
  'NODES_EXCLUDE',
  'DEPLOY_GIT_REPO_DIR',
  'TELEGRAM_ERROR_CHAT_ID',
  'N8N_ERROR_DLQ_PATH',
]) {
  const envExample = readText('.env.example');
  const compose = readText('docker/docker-compose.yml');

  if (!envExample.includes(`${required}=`)) fail(`.env.example is missing ${required}`);
  if (!compose.includes(`${required}=`)) fail(`docker compose does not pass ${required}`);
}
pass('required n8n deployment env vars are documented and passed through compose');

const deployAction = readText('.github/workflows/deploy-n8n-workflow.yml');
if (!deployAction.includes("git diff --name-only")) {
  fail('deploy action should deploy changed staging workflows on push');
}
if (!deployAction.includes("find staging -maxdepth 1 -type f -name '*.json'")) {
  fail('deploy action should support manual all-staging deployment');
}
if (deployAction.includes('github-staging-approval-deploy.json')) {
  fail('deploy action should not special-case controller files inside staging');
}
pass('deploy action checks look correct');

if (failures > 0) {
  console.error(`\n${failures} verification check(s) failed.`);
  process.exit(1);
}

console.log('\nAll repository verification checks passed.');
