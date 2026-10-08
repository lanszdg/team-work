---
name: team-start
description: 开始多机团队开发。在 tmux 中创建分屏布局：左侧 Leader Claude Code、右上团队 Dashboard、右下 Teammate 窗格。当用户说"开始多机团队开发"、"创建分屏"、"启动团队协作"时使用。
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
---

# Team Start - 开始多机团队开发

## 触发关键词

- "开始多机团队开发"
- "创建分屏"
- "启动团队协作"
- "开始团队协作"

## 前置条件

**必须在 tmux 环境中运行**。分屏依赖 tmux 的 split-window 功能。

如果在 Claude Code 中看到此 Skill 但当前不在 tmux 中：
1. 提示用户先在终端中执行 `tmux` 进入 tmux 会话
2. 在 tmux 中重新启动 Claude Code（带环境变量）

## 环境变量要求

以下环境变量必须在**启动 Claude Code 之前**设置：

```bash
export CLAUDE_CODE_TEAM_NAME="<team-name>"
export CLAUDE_CODE_AGENT_ID="leader@<team-name>"
export CLAUDE_CODE_AGENT_NAME="team-lead"
export CLAUDE_CODE_COORDINATOR_MODE=1
```

## 执行步骤

1. **检查 tmux 环境**
   - 运行 `echo $TMUX`
   - 如果输出为空 → 提示用户先执行 `tmux`

2. **检查环境变量**
   - 读取 `CLAUDE_CODE_TEAM_NAME`、`CLAUDE_CODE_COORDINATOR_MODE`
   - 如果未设置 → 提示用户设置后重新启动 Claude Code

3. **触发分屏**
   - 如果团队配置已存在 → 执行 `/reload-plugins` 触发 autoSplitLayout
   - 如果团队配置不存在 → 引导用户先调用 team-create

4. **确认分屏效果**
   - 运行 `tmux list-panes -F '#{pane_id} #{pane_title}'` 确认窗格数量

## 预期效果

```
┌──────────────┬─────────────────┐
│              │  Team Dashboard  │
│   Leader     │  (右上 - 只读)   │
│   (左侧 30%)  ├─────────────────┤
│              │  Teammate 1      │
│              │  (右下)          │
└──────────────┴─────────────────┘
```

## 后续操作

分屏完成后，用户可以在 Leader 窗格中：

- **创建团队**: "创建团队 auth-refactor，包含两个队友"
- **查看状态**: "检查团队状态"
- **分配任务**: "向 researcher-1 发送消息：审查 auth.ts"
- **添加队友**: "添加队友 dev-2，负责前端开发"

## 注意事项

- 环境变量必须在 Claude Code 启动前设置，启动后设置无效
- Dashboard 窗格为只读，不接受用户输入
- 所有操作在 Leader 窗格（左侧）中完成
- teammate 窗格中的 Claude Code 实例由插件自动管理
- 插件会自动检测云端服务器并初始化云端协同（如果 `TEAM_MEMORY_SYNC_URL` 已设置）

## 与本插件其他命令的关系

| 命令 | 关系 |
|------|------|
| `team-create` | **唯一创建入口**——创建团队后，再用 team-start 启动分屏 |
| `team-status` | 查看团队状态（含云端成员 + 在线 Worker） |
| `team-message` | 向队友发送消息/分配任务 |
| `multi-machine-team` | ⚠️ 已废弃——功能已合并到 team-create 的统一入口 |
| `omc team` | ⚠️ OMC 内置命令，与本插件不互通 |

**云端说明**：插件会在分屏启动时自动检测云端服务器。如果 `TEAM_MEMORY_SYNC_URL` 已设置，云端协同自动激活，Dashboard 每 30s 同步远程成员状态。
