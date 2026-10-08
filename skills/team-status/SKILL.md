---
name: team-status
description: 查询团队的当前状态，包括成员列表、活跃状态、权限模式和后端信息。当用户要求检查团队状态、查看队友状态时使用。
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# Team Status

查询团队的当前状态，包括成员列表、活跃状态、权限模式和后端信息。

## 何时使用

- 需要查看团队中各队友的当前状态（running/idle）
- 需要检查哪个队友处于空闲状态可以分配新任务
- 需要查看队友使用的模型、后端类型和工作树路径
- 需要诊断队友异常或失联问题

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `team_name` | string | 否 | 团队名称（默认使用当前会话的 CLAUDE_CODE_TEAM_NAME） |
| `include_hidden` | boolean | 否 | 是否包含已隐藏的队友（默认 false） |

## 输出格式

```
Team: auth-refactor
Description: 重构认证模块
Created: 2025-04-15T10:30:00Z
Leader: team-lead (agent-xyz)

Members (3):
  [running] researcher-1 (blue) - tmux pane: 1.2 - model: opus
    Worktree: /path/to/project/.claude/worktrees/researcher-1
    Mode: auto
    Idle since: -

  [idle] implementation (green) - tmux pane: 1.3 - model: sonnet
    Worktree: /path/to/project/.claude/worktrees/implementation
    Mode: auto
    Idle since: 2025-04-15T11:15:00Z

  [running] tester-1 (red) - in-process
    Mode: auto
    Idle since: -
```

## 字段说明

| 字段 | 说明 |
|------|------|
| `status` | running（活跃）或 idle（空闲超过 1 分钟） |
| `color` | 队友的标识颜色 |
| `backend` | tmux / iterm2 / in-process |
| `tmuxPaneId` | 终端窗格 ID（tmux/iTerm2 模式下） |
| `worktreePath` | 独立 git worktree 路径（如启用） |
| `mode` | 权限模式: auto / yolo / acceptEdits / plan |
| `idleSince` | 空闲起始时间（ISO 8601 格式） |

## 相关操作

- 看到队友 idle 后，可通过 SendMessage 工具向其发送新任务
- 可通过 Team Mode 修改队友的权限模式
- 可通过 Team Shutdown 工具关闭指定队友

## 数据来源

团队状态从 `~/.claude/teams/{team-name}/config.json` 文件中读取，其中 `members[].isActive` 字段由队友的 Stop 钩子自动更新。

## 云端 Worker 查询 [FIX(P6)]

如果插件已连接云端服务器（`TEAM_MEMORY_SYNC_URL` 已设置）：

1. **查看 Dashboard**：Dashboard 窗格每 30s 定时拉取云端团队状态，显示云端连接状态和远程成员数
2. **查询在线 Worker**：在 Leader 窗格中输入 "查询在线worker" 即可调用 `queryOnlineWorkers()` 函数
3. **心跳机制**：插件每 30s 通过 SSE 发送心跳，云端状态实时反映 Worker 在线/离线

## 与其他团队命令的边界 [FIX(P4/P11)]

团队状态查询只覆盖**本插件管理**的团队。如需查看 OMC 内置团队或云端多机团队，请使用对应命令。
- 本插件团队: `team-status`
- OMC 内置团队: `omc team status <name>`
- 云端多机团队: Dashboard 自动显示 / multi-machine-team 技能
