# n8n Workflows

Controlled Git source for n8n workflow exports, prompts, and staged deployment.

## Structure

```text
n8n-workflows/
├── production/
│   └── personal-productivity-safe.json
├── staging/
│   ├── github-staging-approval-deploy.json
│   └── personal-productivity-safe.json
├── prompts/
│   ├── supervisor.md
│   ├── inbox-agent.md
│   └── calendar-agent.md
├── .env.example
└── README.md
```

## Deployment Model

Use Git for backup, history, review, and manual promotion.

```text
Git repo
↓
workflow JSON files
↓
manual or scheduled import
↓
n8n
```

Do not blindly auto-update active workflows that can send mail, change Gmail state, book meetings, or modify calendars.

Recommended flow:

```text
Git change
↓
test/staging workflow
↓
manual approval
↓
activate production workflow
```

## Docker CLI Examples

Export all workflows:

```bash
sudo docker exec -u node n8n n8n export:workflow --all --output=/files/workflows.json
```

Import a workflow export:

```bash
sudo docker exec -u node n8n n8n import:workflow --input=/files/workflows.json
```

If `/volume2/docker/n8n/files` is mounted into the container as `/files`, keep this Git checkout under:

```text
/volume2/docker/n8n/files/git
```

## Safety Notes

- Keep staging and production workflow JSON separate.
- Import to staging first.
- Review behavior before activating production.
- Require manual approval before any workflow sends email or books meetings.
- Track prompt changes in `prompts/` so behavior changes are reviewable.

## Later Automation Idea

```text
GitHub webhook
↓
download workflow JSON
↓
import to staging
↓
Telegram approval
↓
promote to production
```

This allows faster updates while preserving a human approval gate.

## First Deployment Workflow

`staging/github-staging-approval-deploy.json` implements:

```text
GitHub webhook
↓
download workflow JSON
↓
import to staging
↓
Telegram approval link
↓
promote/import to production
```

The workflow is inactive by default. Import and test it manually before activation.

Required environment variables:

```text
PUBLIC_N8N_BASE_URL=https://your-n8n-host
DEPLOY_WEBHOOK_SECRET=random-shared-secret-for-github-webhook
DEPLOY_APPROVAL_TOKEN=random-token-for-telegram-approval-link
TELEGRAM_BOT_TOKEN=telegram-bot-token
TELEGRAM_APPROVAL_CHAT_ID=telegram-chat-id
```

Optional environment variables:

```text
DEPLOY_REPO=NirBY/n8n-workflows
DEPLOY_BRANCH=refs/heads/main
DEPLOY_WORKFLOW_PATH=staging/personal-productivity-safe.json
GITHUB_TOKEN=
```

Notes:

- The GitHub webhook should send `X-N8N-Deploy-Secret` with the same value as `DEPLOY_WEBHOOK_SECRET`.
- The default deployed file is `staging/personal-productivity-safe.json`.
- A webhook payload can override it with `workflow_path`, but the workflow only accepts paths under `staging/`.
- Staging and production imports force `active=false`; activate production manually after review.
- Production promotion copies the staged file to `/files/git/production/<workflow>.json` and imports that copy.
