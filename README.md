# n8n Workflows

Controlled Git source for n8n workflow exports, prompts, and staged deployment.

## Structure

```text
n8n-workflows/
├── production/
│   └── personal-productivity-safe.json
├── staging/
│   └── personal-productivity-safe.json
├── prompts/
│   ├── supervisor.md
│   ├── inbox-agent.md
│   └── calendar-agent.md
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
