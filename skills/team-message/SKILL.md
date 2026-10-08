---
name: team-message
description: 向团队成员发送消息、任务分配、权限审批等。当用户要求向队友发消息、分配任务、审批方案时使用。
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
---

# Team Message

向团队成员发送消息。通过云端 MessageDispatcher（KV 持久化 + SSE 实时推送）双通道投递。

> ⛔ **必须通过 Bash 调用 `MessageDispatcher.sendMessage()` API。**
> **绝对禁止**用 Write 工具直接写任何 JSON 文件。
> 直接写文件会绕过消息路由、去重和云端同步。

## 何时使用

- 需要向特定队友发送任务指令时
- 需要审批队友提交的方案时
- 需要回复队友的权限请求时

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `recipient` | string | 是 | 接收消息的队友名称 |
| `message` | string | 是 | 消息内容 |
| `message_type` | string | 否 | 消息类型（默认 `task_assignment`） |

## 示例

```
向 security-reviewer 发送消息：请重点审查 auth.ts 中的 token 过期逻辑
```

## 支持的消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `task_assignment` | Leader → Teammate | 分配任务 |
| `idle_notification` | Teammate → Leader | 任务完成 |
| `permission_request` | Teammate → Leader | 请求工具权限 |
| `permission_response` | Leader → Teammate | 批准/拒绝 |
| `plan_approval_request` | Teammate → Leader | 提交方案审核 |
| `plan_approval_response` | Leader → Teammate | 批准/要求修改 |
| `shutdown_request` | Leader → Teammate | 请求终止 |

## 数据存储

消息通过云端双通道投递：
- **KV 持久化**: `messages/{teamName}/tasks/{messageId}` — Worker 离线后上线仍可拉取
- **SSE 实时推送**: `postEvent('task', ...)` — Worker 在线时秒级送达

## 执行方式（强制 Bash 调用 API）

```bash
# 确定插件根目录
if [ -z "$CLAUDE_PLUGIN_ROOT" ]; then
  for candidate in \
    "$HOME/team-collab-plugin" \
    "$HOME/.claude/plugins/team-collab-plugin" \
    "$HOME/.claude/plugins/team-collab"; do
    if [ -f "$candidate/dist/core/messageDispatcher.js" ]; then
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
import { MessageDispatcher } from './dist/core/messageDispatcher.js';
import { getConfiguredSyncUrl, getConfiguredApiKey } from './dist/core/cloudConfig.js';

const syncUrl = getConfiguredSyncUrl();
if (!syncUrl) {
  console.error('❌ TEAM_MEMORY_SYNC_URL 未设置且 TEAM_COLLAB_DEMO_MODE!=1');
  process.exit(1);
}

const dispatcher = new MessageDispatcher({
  teamName: process.env.CLAUDE_CODE_TEAM_NAME || '${TEAM_NAME}',
  agentName: process.env.CLAUDE_CODE_AGENT_NAME || 'team-lead',
  cloudConfig: {
    apiUrl: syncUrl,
    apiKey: getConfiguredApiKey(),
    developerId: process.env.CLAUDE_CODE_AGENT_ID || 'team-lead',
  },
});

await dispatcher.waitForConnection(10000);
const sent = await dispatcher.sendMessage(
  '${RECIPIENT_AGENT_ID}',
  '${RECIPIENT_NAME}',
  {
    type: '${MESSAGE_TYPE}',
    text: \`${MESSAGE_TEXT}\`,
    timestamp: new Date().toISOString(),
  },
);
console.log(sent ? '✅ 消息已发送到 ${RECIPIENT_NAME}' : '⚠️ 消息已去重（重复发送）');
"
```

> `MessageDispatcher.sendMessage()` 自动处理去重、KV 持久化和 SSE 实时推送。
