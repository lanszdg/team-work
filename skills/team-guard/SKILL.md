---
name: team-guard
description: 【编码质量门】单机/跨机编码质量管控——集成 code-triple-guard 的五门流程。单机直接调用 gate，跨机通过团队消息通道分发边界检查。当用户说"质量检查"、"边界验证"、"改前分析"、"变更确认"时使用此技能。
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Skill
  - Task
---

# Team Guard — 团队编码质量门

> 集成 code-triple-guard 到 team-collab 的协作流程中。
> 单机模式：直接调用 code-triple-guard skill。
> 跨机模式：通过 team-collab 消息通道分发包边界检查任务。

## 模式检测

执行前先判定运行模式：

```bash
# 检测 1：是否为 team-collab 成员
if [ -n "$CLAUDE_CODE_TEAM_NAME" ]; then
  echo "TEAM_MODE=yes"
  # 检测 2：是否有其他在线成员
  ONLINE=$(curl -sf "${TEAM_MEMORY_SYNC_URL}/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('sseClients',0))" 2>/dev/null || echo 0)
  if [ "$ONLINE" -gt 1 ]; then
    echo "MULTI_MACHINE=yes"
  else
    echo "MULTI_MACHINE=no"
  fi
else
  echo "TEAM_MODE=no"
fi
```

| 检测结果 | 模式 | 说明 |
|---------|------|------|
| `TEAM_MODE=no` | **单机独立** | 不在团队中，直接调用 code-triple-guard |
| `TEAM_MODE=yes, MULTI_MACHINE=no` | **单机团队** | 团队中但只有自己，本地跑 gate |
| `TEAM_MODE=yes, MULTI_MACHINE=yes` | **跨机团队** | 有其他在线成员，需协调 |

---

## 路径 A：单机独立 / 单机团队

直接调用 code-triple-guard skill，无需协调。

```
执行流程：
  1. Skill("code-triple-guard")
     → 完整的 GATE 0→1→2→3→4→5 流程
  2. 结束后，若有团队环境：
     将 GATE 5 结果推送到团队云端
     → 其他成员下次 SessionStart 可看到上次的门控报告
```

### 团队环境下的收尾推送

```bash
# GATE 5 完成后，推送报告到团队云
if [ -n "$CLAUDE_CODE_TEAM_NAME" ] && [ -f /tmp/.ctg-gate5-report.md ]; then
  REPORT=$(cat /tmp/.ctg-gate5-report.md | base64)
  curl -s -X PUT "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=team-gates" \
    -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"entries\": {
        \"gate5/${CLAUDE_CODE_AGENT_ID}/$(date +%s)\": {
          \"agentId\": \"${CLAUDE_CODE_AGENT_ID}\",
          \"agentName\": \"${CLAUDE_CODE_AGENT_NAME}\",
          \"timestamp\": \"$(date -Iseconds)\",
          \"report\": \"${REPORT}\"
        }
      }
    }"
fi
```

---

## 路径 B：跨机团队 — 边界检查分发

当团队中有多台机器在线时，利用 team-collab 的消息通道将 code-triple-guard 的关键检查**分发到不同 OS/环境的 Worker 上执行**。

### B.1 发起跨机边界检查

Leader 在自己机器上先跑完单机 gate（GATE 0-3），然后在 GATE 4 阶段发起跨机请求：

```bash
# Step 1：检测需要跨机验证的边界
BOUNDARIES=""

# 检查 1：改动是否涉及路径处理（需要 Windows 验证）
if git diff --name-only HEAD~1 | grep -qE "(path|homedir|dirname|resolve|join)"; then
  BOUNDARIES="$BOUNDARIES path-separator"
fi

# 检查 2：改动是否涉及进程生成（需要 macOS iTerm2 验证）
if git diff --name-only HEAD~1 | grep -qE "(execFile|spawn|fork|tmux|iterm)"; then
  BOUNDARIES="$BOUNDARIES process-spawn"
fi

# 检查 3：改动是否涉及文件锁（需要并发验证）
if git diff --name-only HEAD~1 | grep -qE "(lockfile|proper-lock|mailbox)"; then
  BOUNDARIES="$BOUNDARIES file-lock"
fi

# 检查 4：改动是否涉及 SSE（需要长连接验证）
if git diff --name-only HEAD~1 | grep -qE "(SSE|EventSource|sse|reconnect)"; then
  BOUNDARIES="$BOUNDARIES sse-long-connection"
fi

echo "BOUNDARIES_TO_CHECK=$BOUNDARIES"
```

### B.2 分发检查任务

```bash
# 对每个需要检查的边界，通过团队消息通道分发
if [ -n "$BOUNDARIES" ]; then
  cd "$CLAUDE_PLUGIN_ROOT"

  # 生成跨机验证清单
  VERIFY_ID="gate4-cross-$(date +%s)"
  
  for BOUNDARY in $BOUNDARIES; do
    # 确定该边界需要哪些 OS 验证
    case $BOUNDARY in
      path-separator)
        TARGET_OS="win32"  # Windows 路径分隔符验证
        TEST_CMD="npm test -- test-messageDispatcher.js test-teamFile.js"
        ;;
      process-spawn)
        TARGET_OS="darwin"  # macOS iTerm2 验证
        TEST_CMD="npm test -- test-backends-tmux.js"
        ;;
      file-lock)
        TARGET_OS="linux"   # 并发锁验证
        TEST_CMD="node test/concurrent-mailbox.test.js"
        ;;
      sse-long-connection)
        TARGET_OS="linux"    # SSE 长连接验证
        TEST_CMD="timeout 120 npm test -- test-sse-reconnect.js"
        ;;
    esac

    # 通过云 KV 发布验证任务（所有在线 Worker 都能看到）
    curl -s -X PUT "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=team-gates" \
      -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{
        \"entries\": {
          \"verify/${VERIFY_ID}/${BOUNDARY}\": {
            \"task\": \"gate4-cross-machine\",
            \"boundary\": \"${BOUNDARY}\",
            \"targetOS\": \"${TARGET_OS}\",
            \"testCommand\": \"${TEST_CMD}\",
            \"requestedBy\": \"${CLAUDE_CODE_AGENT_NAME}\",
            \"requestedAt\": \"$(date -Iseconds)\",
            \"status\": \"pending\"
          }
        }
      }"

    # 通过 SSE 广播通知在线 Worker
    curl -s -X POST "${TEAM_MEMORY_SYNC_URL}/api/team_memory/events?repo=team-gates" \
      -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{
        \"type\": \"gate4_verify_request\",
        \"data\": {
          \"verifyId\": \"${VERIFY_ID}\",
          \"boundary\": \"${BOUNDARY}\",
          \"targetOS\": \"${TARGET_OS}\",
          \"testCommand\": \"${TEST_CMD}\",
          \"requestedBy\": \"${CLAUDE_CODE_AGENT_NAME}\"
        }
      }"
  done

  echo "📤 已分发 ${BOUNDARIES} 边界检查到团队云端"
  echo "   验证ID: ${VERIFY_ID}"
  echo "   等待各 OS Worker 回报结果..."
fi
```

### B.3 Worker 侧：接收并执行边界检查

Worker 的 SessionStart hook 自动检测待处理的跨机检查任务：

```bash
#!/bin/bash
# Worker 侧脚本：检查是否有针对本机的跨机验证任务

MY_OS=$(node -e "console.log(process.platform)")
MY_AGENT_ID="${CLAUDE_CODE_AGENT_ID}"

# 从团队云拉取待处理的 gate 任务
TASKS=$(curl -sf "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=team-gates" \
  -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" | \
  python3 -c "
import sys,json
d=json.load(sys.stdin)
tasks=[]
for k,v in d.get('entries',{}).items():
    if k.startswith('verify/') and v.get('status')=='pending':
        if v.get('targetOS')=='${MY_OS}' or v.get('targetOS')=='any':
            tasks.append({'key':k,'task':v})
print(json.dumps(tasks))
" 2>/dev/null)

if [ -n "$TASKS" ] && [ "$TASKS" != "[]" ]; then
  echo "<system-reminder>"
  echo "🔬 [Team GATE 4] 跨机边界验证任务 (你的 OS: $MY_OS):"
  echo "$TASKS" | python3 -c "
import sys,json
for t in json.load(sys.stdin):
    print(f'  • {t[\"task\"][\"boundary\"]}: {t[\"task\"][\"testCommand\"]}')
    print(f'    请求者: {t[\"task\"][\"requestedBy\"]}')
  "
  echo ""
  echo "输入 '执行边界检查' 来运行这些验证任务"
  echo "</system-reminder>"
fi
```

### B.4 Worker 执行并回报

```bash
#!/bin/bash
# Worker 执行验证任务并回报结果

VERIFY_ID="${1}"
BOUNDARY="${2}"
TEST_CMD="${3}"

echo "🔬 [Team GATE 4] 执行边界检查: ${BOUNDARY}"

# 运行测试
cd "$CLAUDE_PLUGIN_ROOT"
eval "$TEST_CMD" 2>&1 | tee /tmp/team-guard-verify-${BOUNDARY}.log
EXIT_CODE=$?

# 回报结果给团队云
if [ $EXIT_CODE -eq 0 ]; then
  STATUS="verified"
  RESULT="✅ 通过"
else
  STATUS="failed"
  RESULT="❌ 失败 (exit code: $EXIT_CODE)"
fi

curl -s -X PUT "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=team-gates" \
  -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"entries\": {
      \"verify/${VERIFY_ID}/${BOUNDARY}\": {
        \"status\": \"${STATUS}\",
        \"result\": \"${RESULT}\",
        \"verifiedBy\": \"${CLAUDE_CODE_AGENT_NAME}\",
        \"verifiedAt\": \"$(date -Iseconds)\",
        \"os\": \"$(node -e 'console.log(process.platform)')\",
        \"exitCode\": ${EXIT_CODE}
      }
    }
  }"

echo "${RESULT}"
echo "结果已回报到团队云端"
```

### B.5 Leader 汇总跨机结果

```bash
#!/bin/bash
# Leader 侧：拉取所有跨机验证结果，判定闭合

echo "📊 [Team GATE 4] 汇总跨机边界检查结果..."
echo ""

ALL_VERIFIED=true

curl -sf "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=team-gates" \
  -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" | \
  python3 -c "
import sys,json,time
d=json.load(sys.stdin)
pending=[]
verified=[]
failed=[]

for k,v in d.get('entries',{}).items():
    if not k.startswith('verify/'): continue
    boundary = k.split('/')[-1]
    status = v.get('status','pending')
    if status == 'pending':
        pending.append({'boundary':boundary, 'os':v.get('targetOS','?'), 'by':v.get('requestedBy','?')})
    elif status == 'verified':
        verified.append({'boundary':boundary, 'os':v.get('os','?'), 'by':v.get('verifiedBy','?')})
    elif status == 'failed':
        failed.append({'boundary':boundary, 'os':v.get('os','?'), 'by':v.get('verifiedBy','?'), 'reason':v.get('result','?')})

print('  已通过:')
for v in verified:
    print(f'    ✅ {v[\"boundary\"]} ({v[\"os\"]}, 验证者: {v[\"by\"]})')

if pending:
    print('  等待中:')
    for p in pending:
        print(f'    ⏳ {p[\"boundary\"]} ({p[\"os\"]})')

if failed:
    print('  失败:')
    for f in failed:
        print(f'    ❌ {f[\"boundary\"]} ({f[\"os\"]}, {f[\"reason\"]})')

if not failed and not pending:
    print('  🎉 所有跨机边界检查通过!')
else:
    print(f'  ⚠ {len(pending)} 待完成, {len(failed)} 失败 — GATE 4 未闭合')
    sys.exit(1)
"
```

---

## 路径 C：团队 GATE 5 跨机闭合

改动完成并验证后，确认**所有 Worker 机器上**都能正常工作：

```bash
#!/bin/bash
# Leader 侧：发起团队闭合验证

echo "🔒 [Team GATE 5] 发起跨机闭合验证..."

# 1. 确认所有成员在线
ONLINE_MEMBERS=$(curl -sf "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=${CLAUDE_CODE_TEAM_NAME}" \
  -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" | \
  python3 -c "
import sys,json
d=json.load(sys.stdin)
members=[]
for k,v in d.get('entries',{}).items():
    if k.startswith('members/'):
        m=json.loads(v) if isinstance(v,str) else v
        age=time.time()-m.get('_syncedAt',0)/1000
        if age<60: members.append(m.get('agentName','?'))
import time
print(','.join(members))
" 2>/dev/null)

echo "   在线成员: ${ONLINE_MEMBERS}"

# 2. 广播闭合验证请求
curl -s -X POST "${TEAM_MEMORY_SYNC_URL}/api/team_memory/events?repo=team-gates" \
  -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"gate5_closure_check\",
    \"data\": {
      \"goal\": \"${GOAL_DESCRIPTION}\",
      \"changedFiles\": \"${CHANGED_FILES}\",
      \"verificationCommand\": \"npm test\",
      \"requestedBy\": \"${CLAUDE_CODE_AGENT_NAME}\",
      \"timestamp\": \"$(date -Iseconds)\"
    }
  }"

echo "📤 已向所有在线成员发送闭合验证请求"
echo "   等待所有成员确认..."
echo ""
echo "   闭合条件: 所有成员各自运行 npm test 通过后回报"
```

Worker 侧收到 `gate5_closure_check` 事件后：

```bash
# Worker 收到 GATE 5 闭合请求
echo "🔒 [Team GATE 5] 收到闭合验证请求"
echo "   目标: ${GOAL_DESCRIPTION}"
echo "   变更文件: ${CHANGED_FILES}"
echo ""
echo "   正在拉取最新代码并验证..."

cd "$CLAUDE_PLUGIN_ROOT"
git pull 2>/dev/null || curl -sf "..." # 通过云同步代码

npm test 2>&1 | tee /tmp/team-guard-closure-$(date +%s).log
EXIT_CODE=$?

# 回报
curl -s -X PUT "${TEAM_MEMORY_SYNC_URL}/api/team_memory?repo=team-gates" \
  -H "X-API-Key: ${TEAM_MEMORY_SYNC_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"entries\": {
      \"closure/${CLAUDE_CODE_AGENT_ID}/$(date +%s)\": {
        \"status\": \"$([ $EXIT_CODE -eq 0 ] && echo 'closed' || echo 'failed')\",
        \"result\": \"$([ $EXIT_CODE -eq 0 ] && echo '✅ 闭合' || echo '❌ 失败')\",
        \"agentName\": \"${CLAUDE_CODE_AGENT_NAME}\",
        \"os\": \"$(node -e 'console.log(process.platform)')\",
        \"exitCode\": ${EXIT_CODE},
        \"verifiedAt\": \"$(date -Iseconds)\"
      }
    }
  }"

echo "$([ $EXIT_CODE -eq 0 ] && echo '✅ 跨机闭合验证通过' || echo '❌ 闭合失败，等待修复')"
```

---

## 完整流程决策树

```
用户输入触发 team-guard
        │
        ├── TEAM_MODE=no (不在团队中)
        │   └── 路径 A：直接调用 code-triple-guard skill
        │       └── 完整的 GATE 0→1→2→3→4→5
        │
        ├── TEAM_MODE=yes, MULTI_MACHINE=no (团队但只有自己)
        │   └── 路径 A + 推送 GATE 5 报告到团队云
        │
        └── TEAM_MODE=yes, MULTI_MACHINE=yes (跨机团队)
            │
            ├── Leader 发起:
            │   ├── 1. 本地跑 GATE 0→3（同单机流程）
            │   ├── 2. GATE 4 阶段: 检测需要跨机验证的边界
            │   │   └── 路径 B：分发边界检查到不同 OS Worker
            │   ├── 3. GATE 4 阶段: 等待所有 Worker 回报结果
            │   └── 4. GATE 5 阶段: 广播闭合验证 → 等待全员确认
            │
            └── Worker 接收:
                ├── SessionStart: 检查待处理的 gate 任务
                ├── 收到 gate4_verify_request: 执行测试 → 回报
                └── 收到 gate5_closure_check: pull 最新 → 跑测试 → 回报
```

---

## 与其他技能的关系

| 技能 | 关系 |
|------|------|
| `team-create` | 先创建团队，再 `team-guard` 保护开发质量 |
| `team-start` | 分屏启动后，各 pane 内各自运行 `team-guard` |
| `team-message` | `team-guard` 的跨机通知底层走 `team-message` 通道 |
| `code-triple-guard` | 单机路径直接调用此 skill；跨机路径复用其概念 |

## 使用触发词

- "质量检查" / "边界检查" / "交叉验证"
- "改前分析" / "变更影响" / "改动确认"
- "团队验证" / "全员测试" / "跨机检查"
