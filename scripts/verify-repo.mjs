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

const jsonFiles = walk('.', (file) => file.endsWith('.json') && !file.startsWith('.git/'));
for (const file of jsonFiles) readJson(file);
pass(`parsed ${jsonFiles.length} JSON files`);

for (const file of walk('staging', (file) => file.endsWith('.json'))) {
  verifyWorkflowJson(file);
}
for (const file of walk('production', (file) => file.endsWith('.json'))) {
  verifyWorkflowJson(file);
}
for (const file of walk('controller', (file) => file.endsWith('.json'))) {
  verifyWorkflowJson(file);
}

if (existsSync(path.join(root, 'staging/github-staging-approval-deploy.json'))) {
  fail('deploy controller must not live in staging/');
} else {
  pass('deploy controller is outside staging/');
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

for (const required of [
  'DEPLOY_PUBLISH_STAGING',
  'N8N_BLOCK_ENV_ACCESS_IN_NODE',
  'N8N_PROXY_HOPS',
  'NODES_EXCLUDE',
  'DEPLOY_GIT_REPO_DIR',
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
