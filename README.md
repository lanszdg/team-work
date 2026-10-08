# Team Work · 团队协同开发与多智能体协作插件

面向多人、跨机器、独立开发环境中的团队协同开发，让团队成员及其 AI 编程助手能够共享任务、交换消息、同步进度并提交成果审核。

项目包含 **TypeScript 协作内核、可自建的同步服务、CLI / Skill / Hook 接入代码和团队看板**。核心能力是把任务生命周期从聊天消息中独立出来，形成可认领、可审核、可恢复的协作机制。

> **能力边界**：这是可集成的协作插件与运行时核心。Worker 的实际开发行为由调用方提供的执行函数完成；仅启动同步服务不会自动规划和完成整个软件项目。OpenCode 适配代码仍有需要宿主加载器配合的部分。

## 目录

- [业务场景与价值](#业务场景与价值)
- [能力概览](#能力概览)
- [架构与数据职责](#架构与数据职责)
- [任务生命周期](#任务生命周期)
- [环境与安装](#环境与安装)
- [快速开始](#快速开始)
- [团队协作使用流程](#团队协作使用流程)
- [接入 AI 编程助手](#接入-ai-编程助手)
- [配置说明](#配置说明)
- [同步服务接口](#同步服务接口)
- [测试与验证](#测试与验证)
- [项目结构](#项目结构)
- [当前边界与常见问题](#当前边界与常见问题)
- [公开仓库与敏感信息](#公开仓库与敏感信息)

## 业务场景与价值

团队成员分别负责需求、架构、开发、测试和发布，各自在本机使用 AI 编程工具。项目面向以下协作问题：

| 团队问题 | 项目提供的机制 | 实际价值 |
|---|---|---|
| 任务分散在各成员的聊天会话中 | TaskStore 保存统一任务清单与生命周期 | 能查询责任人、任务依赖和当前进度 |
| 多人或多个 Agent 同时领取同一任务 | ETag / If-Match 乐观并发控制 | 检测并发覆盖，支持冲突后重新读取与重试 |
| 成员离线时错过通知 | KV 持久化消息，SSE 提供实时通知 | 在线及时接收，恢复连接后可以补拉 |
| 执行进程退出后任务长期占用 | 任务租约、续约和过期回收接口 | 为中断恢复和任务重新认领提供基础 |
| 执行者自行宣布完成 | 提交审核与最终完成使用不同状态和权限 | 支持负责人或具备审核权限的角色验收 |
| 看板、心跳与消息各自维护任务状态 | TaskStore 作为任务事实源，其他模块读取投影 | 减少模块之间的状态分歧 |
| 本机终端信息与团队共享配置混在一起 | 团队资料、策略、在线态与本地运行信息分层 | 减少本机路径、窗格与会话信息的跨机混用 |

这些是实现机制带来的协作价值；仓库不承诺未经实测的效率提升比例、吞吐量或成本降幅。

适用于小型研发团队的协作原型、AI 编程助手集成、多角色任务审核和自建同步服务。生产部署需要结合实际宿主、执行器、身份认证与网络环境进一步验收。

## 能力概览

### 1. 团队与成员管理

- 团队创建、发现、邀请和加入相关接口与脚本。
- 成员资料、角色、团队策略与本地缓存管理。
- 团队资料写入采用云端确认后更新缓存的路径。
- 成员稳定身份、在线心跳与离线状态相关能力。
- 本地运行注册表管理终端窗格、工作目录和后端信息。

主要实现：[团队资料](src/core/teamProfileService.ts)、[团队配置](src/core/teamFile.ts)、[邀请](src/core/cloudInvitation.ts)、[发现](src/core/teamDiscovery.ts)、[身份](src/core/agentIdentity.ts)、[在线状态](src/core/cloudPresence.ts)、[本地运行注册表](src/core/runtimeRegistry.ts)。

### 2. TaskStore 任务管理

支持以下语义操作：

- 创建任务、查询任务、查询满足依赖与角色要求的待办任务。
- 认领、开始执行、续约和释放认领。
- 提交产物审核、审核通过、打回修改。
- 失败登记、重试与过期租约回收。
- 上游任务完成后，解除满足条件的下游阻塞。

任务可声明描述、预期输出、验收标准、依赖、所需角色和指定执行者。产物以文件、分支、提交或 URL 引用的形式登记。

**验收标准是任务数据，程序不会自动判断所有业务标准是否满足。** 内容正确性需要审核者或接入的验证逻辑判断。

主要实现：[TaskStore](src/core/taskStore.ts)、[TaskTools](src/core/taskTools.ts)、[任务类型](src/core/types.ts)。

### 3. 并发控制与执行恢复

- TaskStore 使用独立的 {teamName}__tasks 命名空间，减少消息、心跳写入对任务 CAS 的干扰。
- 更新时读取当前 ETag，使用 If-Match 提交；冲突返回 412 后重新读取并重试。
- Worker 执行期间周期续约。
- 续约失败时通过 AbortSignal 通知执行器取消。
- 提供过期任务回收接口，以及审核打回后的重新认领流程。

取消属于**协作式取消**：执行器必须响应 signal，取消信号不会自动终止它启动的所有外部进程。任务租约也不等于文件系统锁，不能据此宣称代码修改严格只执行一次。

主要实现：[WorkerLoop](src/core/taskWorkerLoop.ts)。

### 4. 跨机器消息

- CloudMessageRouter 提供 KV 消息持久化和 SSE 通知。
- 消息信封支持 fromAgentId / toAgentId。
- 支持轮询补拉、消息 ID 去重和断线退避重连。
- MessageDispatcher 组织消息发送与协议权限检查。
- 任务生命周期通知与任务存储分离。

消息去重集合主要保存在进程内。双通道发送不是跨请求的原子事务，不提供端到端 exactly-once 保证。

主要实现：[消息路由](src/core/cloudMessageRouter.ts)、[消息分发](src/core/messageDispatcher.ts)、[同步适配器](src/core/syncServerAdapter.ts)。

### 5. 角色、审批与审核

| 角色 | 用途 |
|---|---|
| tech-lead | 技术负责人、团队管理和任务验收 |
| product-manager | 需求与任务组织 |
| architect | 架构设计、技术评审 |
| developer | 开发执行与提交成果 |
| qa-engineer | 测试、质量检查与验收 |
| ops-engineer | 运维与发布相关协作 |
| designer | 设计执行与协作 |

实际权限以 src/core/types.ts 中的 ROLE_PERMISSIONS 为准。Reviewer 是审核职责，并不是另一个名为 reviewer 的角色枚举。

- TaskTools 在工具层检查角色能力。
- Worker 执行完成后进入 review。
- 具备 canCompleteTask 或团队管理权限的调用者才能通过相应接口验收。
- 未注册的结构化协议消息默认拒绝。
- 另有方案审批、代码评审和团队权限广播模块。

这些是应用层协作控制。同步服务当前使用共享 API Key，不能视为完整的服务端多租户授权系统。

### 6. 团队看板与扩展模块

- 浏览器看板展示团队成员、在线状态、任务与同步状态。
- TaskStore 的任务状态可投影到 Presence 和看板。
- 看板通过定期查询刷新，不应描述为全链路 SSE 实时界面。
- 提供 tmux、iTerm2 和 in-process 后端代码。
- 包含团队记忆同步、Git 协作、投票及 Skill 共享相关模块。

后端支持范围取决于操作系统与宿主集成；in-process 上下文隔离不是操作系统级沙箱。Git、投票等扩展模块不等于已有完整的自动合并或自动发布流水线。

## 架构与数据职责

~~~mermaid
flowchart LR
    H[团队成员] --> C[各自的 AI 编程工具 / CLI]
    C --> P[Skill / Hook / 平台适配层]
    P --> T[TaskStore / TaskTools / WorkerLoop]
    P --> M[MessageDispatcher / CloudMessageRouter]
    P --> R[团队资料 / 权限 / 在线状态]
    T --> S[HTTP 同步服务]
    M --> S
    R --> S
    S --> D[(SQLite 持久化)]
    S --> E[SSE 通知]
    E --> P
    S --> K[团队看板]
~~~

| 数据 | 主要职责 |
|---|---|
| 团队资料与策略 | 记录团队成员、角色及共享规则 |
| TaskStore | 记录任务状态、认领者、租约、产物和审核结果 |
| 消息 | 通知其他参与者发生了什么，不替代任务事实 |
| Presence | 表示在线状态及派生的工作状态 |
| Dashboard | 聚合展示，不负责修改任务状态 |
| LocalRuntime | 保存本机窗格、目录、后端等运行信息 |
| 同步服务 | 提供命名空间存储、版本检查与事件分发 |

仓库还包含连接外部控制平台的适配代码。CONTROL_PLANE_* 对应另一条可选集成路径，**不等于本仓库的同步服务**；基础 TaskStore 示例不需要外部控制平台。

## 任务生命周期

~~~mermaid
stateDiagram-v2
    [*] --> pending: 依赖已满足
    [*] --> blocked: 等待依赖
    blocked --> pending: 上游完成
    pending --> claimed: 认领
    claimed --> in_progress: 开始执行
    in_progress --> review: 提交产物
    review --> done: 审核通过
    review --> pending: 打回修改
    claimed --> pending: 释放 / 租约回收
    in_progress --> pending: 释放 / 租约回收
    claimed --> failed: 执行失败
    in_progress --> failed: 执行失败
    failed --> pending: 重试
    done --> [*]
~~~

TaskWorkerLoop.runOnce() 处理一轮认领与执行。持续调度、周期性调用 releaseExpiredLeases() 和具体开发执行器需要由宿主集成；库中提供这些能力并不代表插件启动后已自动接通全部调度流程。

## 环境与安装

建议使用 Node.js 22 LTS、npm 和 Git。同步服务使用 better-sqlite3 原生依赖；若平台没有可用预编译包，需要相应的本机构建工具。

- 本机 SDK / HTTP 示例不依赖 tmux。
- tmux 分屏路径适合 Linux、macOS 或 Windows WSL。
- iTerm2 后端用于 macOS。
- AI 编程工具需要单独安装、登录并配置模型。同步服务不提供模型推理。

~~~bash
git clone https://github.com/lanszdg/team-work.git
cd team-work
npm ci
npm run build
npm run typecheck
~~~

根目录的 build 只编译 TypeScript。启动浏览器看板前，需要补充复制静态页面：

~~~bash
node --input-type=module -e "import { copyFileSync } from 'node:fs'; copyFileSync('src/core/kanbanPage.html', 'dist/core/kanbanPage.html')"
~~~

安装同步服务：

~~~bash
cd sync-server
npm ci
npm run build
npm run typecheck
cd ..
~~~

## 快速开始

先跑通独立同步服务与 TaskStore 示例，再根据宿主环境接入 Skill / Hook，方便区分后端连接问题与宿主集成问题。

### 第一步：启动同步服务

Bash：

~~~bash
export TEAM_MEMORY_SYNC_API_KEY="replace-with-a-random-secret"
export HOST="127.0.0.1"
export PORT="3000"
cd sync-server
npm start
~~~

PowerShell：

~~~powershell
$env:TEAM_MEMORY_SYNC_API_KEY = "replace-with-a-random-secret"
$env:HOST = "127.0.0.1"
$env:PORT = "3000"
Set-Location sync-server
npm start
~~~

访问 http://127.0.0.1:3000/health 检查服务是否启动。

示例中的密钥必须替换为自己的随机值。跨机器使用时，将服务绑定到团队可访问的地址，并通过受控网络或带 HTTPS 的反向代理提供访问。

### 第二步：配置客户端

在另一个终端进入仓库根目录。

Bash：

~~~bash
export TEAM_MEMORY_SYNC_URL="http://127.0.0.1:3000"
export TEAM_MEMORY_SYNC_API_KEY="与服务端相同的密钥"
export CLAUDE_CODE_TEAM_NAME="demo-team"
export CLAUDE_CODE_AGENT_ID="lead-demo"
export CLAUDE_CODE_AGENT_NAME="team-lead"
~~~

PowerShell：

~~~powershell
$env:TEAM_MEMORY_SYNC_URL = "http://127.0.0.1:3000"
$env:TEAM_MEMORY_SYNC_API_KEY = "与服务端相同的密钥"
$env:CLAUDE_CODE_TEAM_NAME = "demo-team"
$env:CLAUDE_CODE_AGENT_ID = "lead-demo"
$env:CLAUDE_CODE_AGENT_NAME = "team-lead"
~~~

客户端填写服务的 **Base URL**，不需要附加 /api/team_memory。

.env.example 说明配置项，但默认脚本不保证自动加载 .env。请显式设置环境变量，或在自己的启动器中加载配置。

### 第三步：运行最小任务闭环

~~~bash
node examples/task-lifecycle.mjs
~~~

示例通过同步服务：

1. 创建一个指定执行者的演示任务。
2. 使用 WorkerLoop 认领并执行演示函数。
3. 将已有 README 文件作为演示产物提交到 review。
4. 使用技术负责人角色完成演示验收。
5. 输出最终任务状态。

它验证 SDK 与同步服务的基本连接和任务流转，**不调用大模型，也不代表完成了真实开发任务或自动质量审核**。示例会在配置的同步服务中留下带唯一标识的演示任务。

### 第四步：查看团队与看板

~~~bash
node scripts/team-cli.mjs create demo-team "团队协作演示"
node scripts/team-cli.mjs status
~~~

TaskStore 示例与团队成员注册是不同操作；单独运行任务示例不会自动让所有示例角色成为团队成员。

启动浏览器看板：

~~~bash
node --input-type=module -e "import { startKanbanServer } from './dist/core/kanbanServer.js'; startKanbanServer(process.env.CLAUDE_CODE_TEAM_NAME || 'demo-team', 8090)"
~~~

访问 http://localhost:8090 。看板按同步服务中的实际团队、成员和任务数据展示；尚未加入或发送心跳的成员不会凭空显示为在线。

## 团队协作使用流程

### 负责人

1. 配置同步服务地址、密钥和团队身份。
2. 创建团队，邀请对应成员的 Agent ID。
3. 通过 TaskStore / TaskTools 创建任务，填写预期产物、验收标准和依赖。
4. 查询进度，处理 review 状态的任务。
5. 通过 completeTask() 验收，或通过 returnForRevision() 打回。

~~~bash
node scripts/team-cli.mjs invite worker-demo "开发成员" "请加入团队"
~~~

### 开发成员

1. 在自己的机器配置相同的同步服务与团队信息。
2. 通过邀请或团队发现流程加入。
3. 使用自身角色和 Agent ID 查询可执行任务。
4. 由接入的 WorkerLoop 执行任务并提交成果。
5. 根据审核意见继续修改。

agentId 是投递与认领身份，agentName 是展示名称。不要仅根据姓名推断目标身份。

### 消息与任务的区别

team-cli assign 是旧的消息式分派入口，**不会自动创建 TaskStore 任务**。需要依赖、认领、租约及审核状态时，应调用 TaskStore / TaskTools。

进行严格的定向通信时，使用带 toAgentId 的消息信封；不要把只填写展示名称的旧命令当作完整的身份隔离机制。

### 接入自己的执行器

~~~typescript
const loop = new TaskWorkerLoop({
  taskStore,
  agentId: "worker-demo",
  agentRole: "developer",
  executeTask: async ({ task, signal }) => {
    // 接入 AI 编程工具、测试流程或人工协作入口。
    // 执行器需要主动响应 signal 的取消。
    // 返回真实产物引用，不要把聊天结束当作任务完成。
    return [
      { type: "file", value: "docs/result.md", description: task.title }
    ];
  }
});

const result = await loop.runOnce();
~~~

该片段展示接口形态，taskStore 和执行器需要由集成方创建。完整的简化示例见 [examples/task-lifecycle.mjs](examples/task-lifecycle.mjs)。

## 接入 AI 编程助手

### Claude Code 接入材料

- .claude-plugin/plugin.json：插件元数据。
- skills/：团队创建、消息、状态、启动、快速上手等 Skill。
- hooks/hooks.json：工具调用、会话启动、停止等 Hook 配置材料。
- src/platform/claude-code.ts：宿主初始化与协作组件连接。
- scripts/：发现、权限检查、CLI 和可选控制平台桥接脚本。

插件是否被加载、Hook 是否触发取决于实际宿主版本与加载方式。请按所用宿主的插件规范安装，并在其插件 / Hook 管理界面核对加载结果。hooks/hooks.json 是配置材料，不能未经格式适配就覆盖个人宿主配置。

建议依次验收：

1. 同步服务与 TaskStore 示例。
2. 宿主进程启动前需要的环境变量。
3. 插件与 Skills 加载，确认 team-create / team-status 可见。
4. 单个成员的发现、邀请、消息和权限流程。
5. WorkerLoop、执行器和审核操作。

自然语言与 Hook 集成路径仍需端到端验证。部分辅助脚本使用过不同版本接口，SDK 闭环通过不等于全部自然语言命令均已通过。

### OpenCode 与可选控制平台

OpenCode 适配文件位于 src/platform/open-code.ts。部分工具拦截通过全局回调预留给外部加载器，不能当作所有宿主版本开箱即用的正式插件接口。

以下命令用于**另行部署的控制平台**，不属于基础同步服务流程：

~~~bash
npm run control:register
npm run control:poll
~~~

运行前需要配置 CONTROL_PLANE_URL、CONTROL_PLANE_TOKEN 等参数，并提供与适配客户端协议匹配的控制平台。本仓库不包含该平台的完整服务端。

## 配置说明

### 客户端

| 变量 | 说明 |
|---|---|
| TEAM_MEMORY_SYNC_URL | 同步服务 Base URL |
| TEAM_MEMORY_SYNC_API_KEY | 与服务端匹配的密钥 |
| CLAUDE_CODE_TEAM_NAME | 当前团队名称 |
| CLAUDE_CODE_AGENT_ID | 当前参与者的稳定身份 |
| CLAUDE_CODE_AGENT_NAME | 展示名称 |
| CLAUDE_CODE_COORDINATOR_MODE | 1 表示协调者模式 |
| CLAUDE_PLUGIN_ROOT | 宿主提供的插件根路径 |
| CLAUDE_PLUGIN_DATA | 可选的插件数据目录 |
| TEAM_COLLAB_AUTO_JOIN | 1 启用相应自动加入路径；使用前确认团队策略 |
| TEAM_COLLAB_DEMO_MODE | 演示入口，公开版仅指向本机示例地址 |
| CONTROL_PLANE_URL / CONTROL_PLANE_TOKEN | 可选外部控制平台配置 |

稳定身份逻辑可能使用用户目录下保存的身份文件；环境变量和持久化身份的优先级以 agentIdentity.ts 为准。

### 同步服务

| 变量 | 默认值 / 用途 |
|---|---|
| HOST | 默认 0.0.0.0；本机演示建议显式设为 127.0.0.1 |
| PORT | 3000 |
| TEAM_MEMORY_SYNC_API_KEY | 自行配置；公开版内置值仅为开发占位值 |
| DB_PATH | 默认当前目录的 team-sync.db |
| MAX_ENTRIES | 每个命名空间条目上限，默认 1000 |
| MAX_ENTRY_SIZE | 单条目大小上限，默认 250000 字节 |
| SSE_PING_INTERVAL | 默认 30000 毫秒 |
| SSE_MAX_CLIENTS | 默认 100 |
| SSE_EVENT_MAX_ROWS | 默认保留 10000 条事件 |
| BODY_LIMIT | 默认 2097152 字节 |
| LOG_LEVEL | 服务日志级别 |

默认值是配置边界，不是经过压测的容量承诺。当前密钥读取使用 || 回退，设置空字符串不会可靠地关闭鉴权；请显式配置密钥。

## 同步服务接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /health | 服务健康状态 |
| GET | /api/team_memory?repo=namespace | 读取命名空间内容 |
| GET | /api/team_memory?repo=namespace&view=hashes | 读取条目摘要 |
| PUT | /api/team_memory?repo=namespace | 增量更新条目 |
| GET | /api/team_memory/events?repo=namespace | SSE 订阅 |
| POST | /api/team_memory/events?repo=namespace | 发布事件 |

也提供 /api/claude_code/team_memory 兼容路径。

主要请求头：

- X-API-Key：服务访问凭据。
- If-None-Match：条件读取，内容未变可返回 304。
- If-Match：条件写入，版本冲突返回 412。
- X-Developer-Id：调用者标识信息，不等于服务端验证的个人身份。

PUT 使用 upsert 语义，未提交的键保持原值；SQLite 保存数据与事件。默认 API Key 是共享凭据，repo 命名空间不是安全租户隔离边界。

## 测试与验证

~~~bash
npm run typecheck
node --test test/test-taskStore.js test/test-taskWorkerLoop.js test/test-agentTeam-phase3-mock-sync-adapter.js test/test-agentTeam-phase5-projection-tools.js
~~~

这四组测试覆盖任务状态、认领与冲突、租约失效、审核流转、消息信封和状态投影，共 29 项。源码分析期间在原开发环境执行通过；属于本地逻辑与模拟适配器测试，不能替代真实多机器联调。

同步服务类型检查：

~~~bash
cd sync-server
npm run typecheck
~~~

npm test 会枚举更广泛的历史测试，其中部分涉及外部同步服务、终端后端或本地文件系统。先检查前置条件，不要把它当作完全隔离且适合任意生产环境直接运行的命令。

实际生产能力需在自己的服务、宿主和执行器组合下验收。

## 项目结构

~~~text
.claude-plugin/       插件元数据
examples/            最小任务生命周期示例
hooks/               宿主 Hook 配置材料
monitors/            状态监控配置
scripts/             团队 CLI、发现、权限与控制平台适配脚本
skills/              团队协作 Skills
src/
  core/              任务、消息、团队、权限、同步与看板
  hooks/             收件轮询、权限桥接和停止通知
  backends/          tmux / iTerm2 / in-process
  platform/          Claude Code / OpenCode / 控制平台适配
  coordinator/       协调相关代码
  shared/            共享规则
sync-server/
  src/               Fastify + SQLite + SSE 同步服务
  scripts/           静态资源构建脚本
test/                单元、集成与环境相关测试
~~~

## 当前边界与常见问题

**服务启动了，为什么没有 Agent 自动干活？**  
同步服务只提供存储和通知，需要接入 WorkerLoop 的执行函数及宿主调度。runOnce() 不会自行形成常驻后台循环。

**为什么发了 assign 消息却看不到 TaskStore 任务？**  
消息式分派与任务状态管理是两个入口，需要任务生命周期时请使用 TaskStore 创建接口。

**为什么 Worker 只到了 review，没有 done？**  
执行与验收分离，需要具备权限的角色通过完成接口验收。

**为什么看板报 HTML 文件不存在？**  
根目录 TypeScript 编译不复制 HTML，请执行安装部分的静态页面复制命令。

**为什么成员离线后任务没有立即被重新领取？**  
租约过期与回收调度需要时间，且宿主需要调用过期回收接口。心跳离线不等于任务可以安全重做。

**是否能保证一个任务只修改一次代码？**  
不能。CAS 与租约约束任务记录，执行器仍需实现取消、幂等和工作目录隔离。

**是否包含完整企业权限体系？**  
当前提供角色能力检查和共享 API Key。面向多租户或不可信客户端时，还需要服务端身份认证、授权与隔离。

**是否已验证全部平台、全部命令和长期运行？**  
没有。平台适配、历史脚本、真实多机环境与长时间运行需分项验证，不能由类型检查或模拟测试推出。

## 公开仓库与敏感信息

公开仓库只发布用于理解和运行项目的源码、测试、示例和文档：

- 不包含真实 .env、个人宿主配置、运行数据库、日志和会话记录。
- 不包含原开发环境的历史报告、机器状态、临时测试数据或 Git 历史。
- 私人部署地址与内置演示凭据替换为本机地址及公开开发占位值。
- .env.example 仅说明变量，不含可用的私人凭据。
- 使用者产生的配置、数据库和运行数据应保留在各自环境中。

部署前自行配置访问地址和随机密钥，并限制同步服务与看板的网络访问范围。
