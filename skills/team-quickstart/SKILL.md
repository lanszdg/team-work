---
name: team-quickstart
description: Quickstart for using the TaskStore-backed Agent Team workflow — covers both Lead and Worker setup.
allowed-tools:
  - Read
---

# Team Quickstart

## Worker Setup (New Machine)

### Required Environment Variables

```bash
# Cloud sync server URL (required)
TEAM_MEMORY_SYNC_URL=http://<your-server>:3000/api/team_memory

# Optional: API key for cloud sync
TEAM_MEMORY_SYNC_API_KEY=<key>

# Optional: Auto-join the sole available team on startup
TEAM_COLLAB_AUTO_JOIN=1
```

### First Session

1. Set env vars above in your shell or `.env` file.
2. Start Claude Code in a project directory. The `SessionStart` hook runs automatically.
3. If invitations are pending, you will see a system-reminder listing them.
4. Type `加入 <团队名>` to accept an invitation.
5. After joining, your stable identity is persisted to `~/.claude/agent-identity.json`.

### Daily Commands (type these in Claude Code)

| Command | Effect |
|---------|--------|
| `我的任务` or `my tasks` | List ready tasks you can claim |
| `我的邀请` or `my invitations` | Show pending team invitations |
| `查看 <团队名>` or `view <team>` | Show team details and members |
| `任务状态` or `task status` | Show all tasks for current team |
| `加入 <团队名>` | Accept a team invitation |

### Task Workflow

1. **List**: Type `我的任务` to see available tasks.
2. **Claim + Execute**: TaskWorkerLoop claims a task, runs your execution function, and submits artifacts.
3. **Review**: Only a reviewer or tech-lead can mark the task as `done`.
4. **Revision**: If returned, the task goes back to `pending` for you to re-claim.

## Lead Setup

1. Create team with `team-create` skill.
2. Create tasks via `TaskTools.taskCreate()` or `TaskStore.createTask()`.
3. Send invitations to Workers.
4. Review submitted tasks and complete or return them.

## Guardrails

- TaskStore is the single source of truth for task state.
- Messages, presence, and dashboard are projections only.
- Worker submit = `review` status. Only reviewer/leader can set `done`.
- No local mailbox fallback.
- Identity is persisted in `~/.claude/agent-identity.json` for cross-session stability.
