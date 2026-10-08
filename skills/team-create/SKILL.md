---
name: team-create
description: 【统一入口】创建团队——自动检测单机/多机场景，智能路由。当用户说"创建团队"时使用此技能。支持本地 tmux 分屏和云端多机协同两种模式。
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
---

# Team Create — 统一团队创建入口

**这是创建团队的唯一入口。** 不再需要区分 `team-create` / `multi-machine-team` / `omc team`——本技能会根据用户意图自动选择正确的模式。

> ⛔ **最高优先级规则**：创建团队**必须**通过 Bash 调用 `createTeam()` 插件 API。
> **绝对禁止**用 Write 工具直接写 `~/.claude/teams/*/config.json`。
> 直接写文件会绕过 `pushTeamStateToCloud()` 和 `registerTeam()`，导致云端不同步。

## 场景自动检测

收到"创建团队"请求后，**必须先判断用户意图**：

| 用户表述中的关键词 | 判定模式 | 执行路径 |
|-------------------|---------|---------|
| "多机"、"云端"、"跨机器"、"分布式"、"远程"、"多台电脑"、"协同开发"、"多机团队"、"云端协同" | **多机云端模式** | 走「路径 A：多机云端协同」 |
| "本机"、"本地"、"分屏"、"tmux"、"单机"、"这台电脑" | **单机分屏模式** | 走「路径 B：单机 tmux 分屏」 |
| 未明确指定（只说"创建团队"） | **需确认** | 提示用户选择：<br>1. 多机云端协同（多台电脑协作）<br>2. 本机分屏开发（tmux 多面板） |

## 路径 A：多机云端协同

当用户明确要求多机协同，或选择"多机云端协同"时：

### 前置检查

```bash
# 1. 检查云端服务器状态（必须设置 TEAM_MEMORY_SYNC_URL）
if [ -z "$TEAM_MEMORY_SYNC_URL" ]; then
  echo "❌ TEAM_MEMORY_SYNC_URL 未设置。请在 .env 中配置同步服务器地址。"
  exit 1
fi
curl -sf "${TEAM_MEMORY_SYNC_URL}/health"

# 2. 确认环境变量
echo "TEAM_MEMORY_SYNC_URL=${TEAM_MEMORY_SYNC_URL}"
echo "TEAM_MEMORY_SYNC_API_KEY=${TEAM_MEMORY_SYNC_API_KEY:-(未设置)}"
echo "CLAUDE_CODE_TEAM_DEV_ID=${CLAUDE_CODE_TEAM_DEV_ID:-lead}"
```

### ⛔ 强制规则：必须走插件 API，禁止手写 config.json

**绝对禁止**以下操作：
- ❌ 用 Write 工具写 `~/.claude/teams/{name}/config.json`
- ❌ 用 Bash 手拼 JSON 然后 `cat > config.json`
- ❌ 跳过 `createTeam()` 直接操作文件

**唯一正确方式**：通过 Bash 调用插件导出的 `createTeam()` 函数。

### 执行步骤（每条都是具体的 Bash 命令）

> ⛔ **以下 5 步全部强制执行，不可跳过任何一步。** 尤其是 Step 4（分屏），跳过会导致用户看不到 Dashboard。

**Step 1：创建团队并自动同步云端**

```bash
# 确定插件根目录（优先用环境变量，未设置时使用已知安装路径）
if [ -z "$CLAUDE_PLUGIN_ROOT" ]; then
  # 自动发现：搜索已知路径
  for candidate in \
    "/mnt/d/07.program/plugging/team-collab-plugin" \
    "$HOME/team-collab-plugin" \
    "$HOME/.claude/plugins/team-collab-plugin" \
    "$HOME/.claude/plugins/team-collab"; do
    if [ -f "$candidate/dist/core/teamFile.js" ]; then
      export CLAUDE_PLUGIN_ROOT="$candidate"
      break
    fi
  done
fi
if [ -z "$CLAUDE_PLUGIN_ROOT" ]; then
  echo "❌ 找不到插件目录。请设置 CLAUDE_PLUGIN_ROOT 环境变量。"
  exit 1
fi

cd "$CLAUDE_PLUGIN_ROOT" && node --input-type=module -e "
import { createTeam } from './dist/core/teamFile.js';
const teamFile = createTeam({
  teamName: '${TEAM_NAME}',
  leadAgentId: process.env.CLAUDE_CODE_AGENT_ID || 'team-lead',
  description: '${DESCRIPTION}',
});
console.log('✅ 团队已创建，成员数:', teamFile.members.length);
// createTeam() 内部自动调用 pushTeamStateToCloud() — 云端已同步
"
```

> `createTeam()` 内部自动执行：
> - `writeTeamFile()` → 写入本地 config.json
> - `pushTeamStateToCloud()` → 推送 team_state + 全部成员到云端
> - 返回值包含完整的 TeamFile 对象

**Step 2：云端注册（使其他机器可发现）**

```bash
cd "$CLAUDE_PLUGIN_ROOT" && node --input-type=module -e "
import { CloudInvitation } from './dist/core/cloudInvitation.js';
const inv = new CloudInvitation({
  apiUrl: process.env.TEAM_MEMORY_SYNC_URL,
  apiKey: process.env.TEAM_MEMORY_SYNC_API_KEY || '',
  teamName: '${TEAM_NAME}',
  agentId: process.env.CLAUDE_CODE_AGENT_ID || 'team-lead',
  agentName: process.env.CLAUDE_CODE_AGENT_NAME || 'team-lead',
});
await inv.registerTeam({
  name: '${DISPLAY_NAME}',
  description: '${DESCRIPTION}',
  leadAgentId: process.env.CLAUDE_CODE_AGENT_ID || 'team-lead',
  leadAgentName: process.env.CLAUDE_CODE_AGENT_NAME || 'team-lead',
  memberCount: 1,
  createdAt: new Date().toISOString(),
});
console.log('✅ 团队已注册到云端');
"
```

**Step 3+4：验证云端同步 → 立即启动分屏**

```bash
# Part A: 验证云端同步
curl -sf -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=${TEAM_NAME}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ 云端条目数:', len(d.get('content',{}).get('entries',{})))"

# Part B: 检测 tmux（合并到同一步，不可跳过）
if [ -n "$TMUX" ]; then
  echo "TMUX_DETECTED"
else
  echo "NOT_IN_TMUX"
fi
```

根据 Part B 的输出：
- 输出 `TMUX_DETECTED` → **立即调用 `team-start` 技能**（这是本步骤的一部分，不是可选项）
- 输出 `NOT_IN_TMUX` → 提示用户：进入 tmux 后执行 `/team-start`

**Step 5：输出加入指令**

给用户展示其他机器的加入方式（见下方完成后输出模板）。

### 完成后输出

```
✅ 多机云端团队「{name}」已创建

🔗 云端验证:
   - 数据已同步: ${TEAM_MEMORY_SYNC_URL} → repo/{teamName} → {N} 条
   - 团队已注册: __teams__/team/{name} → 可被发现

🏠 本机 (Leader):
   - 团队已注册到云端: ${TEAM_MEMORY_SYNC_URL}
   - Dashboard 已启动（每 30s 同步云端状态）
   - 心跳已启动（每 30s）

🤝 其他机器加入方式:
   其他机器安装插件后启动 Claude Code，新机器自动:
   1. 发现云端团队「{name}」
   2. 自动加入团队
   3. 启动心跳
   （无需手动设置环境变量）

👥 团队成员:
   - team-lead (本机) ← Leader
   - {teammate-1} (待加入)
   - {teammate-2} (待加入)

📊 查看状态:
   - Dashboard 窗格实时显示所有成员和云端连接状态
   - 输入"查询在线worker"获取在线成员列表
```

## 路径 B：单机 tmux 分屏

当用户明确要求本机分屏开发时：

1. **先用 Bash 调用 `createTeam()`**（同上 Step 1，不跳过！）
2. **验证云端同步**（同上 Step 3）
3. **调用 `team-start` 技能**创建 tmux 分屏
4. 自动启动 Dashboard
5. 云端功能仍然后台激活（如果服务器可达）

> ⚠️ 即使选单机模式，也**必须**走 createTeam() API，确保云端同步。分屏是 tmux 层面的附加操作。

## 路径 C：OMC 内置团队

**不再推荐使用。** 如果用户已经在用 `omc team`，引导其迁移到本插件的统一入口。OMC 团队与本插件团队数据不互通。

## 与其他命令的关系

| 命令 | 关系 |
|------|------|
| `team-create` (本技能) | **唯一创建入口**——自动路由单机/多机 |
| `team-start` | 仅用于已创建团队的**分屏启动** |
| `team-status` | 查看团队状态（含云端成员） |
| `team-message` | 向队友发送消息 |
| `omc team` | ⚠️ OMC 内置命令，与本插件团队不互通。不推荐使用 |
| `multi-machine-team` | ⚠️ 已废弃——功能合并到本技能 |

## 技术实现说明

团队创建后自动执行：
- `createTeam()` → 写入 `~/.claude/teams/{name}/config.json` + 推送云端
- `CloudInvitation.registerTeam()` → 注册到 `__teams__` repo
- `CloudPresence.start()` → 每 30s 心跳
- SSE 监听 → 接收远程 Worker 的 presence 事件
- Dashboard → 每 30s 拉取云端状态，显示连接状态 + 远程成员
