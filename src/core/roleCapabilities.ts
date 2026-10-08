/**
 * Role Capabilities — Per-role system prompt, model, and work mode (v3.6 Phase 5)
 *
 * Each role gets:
 * - goal: concise machine-readable role objective
 * - preferredModel: suggested AI model
 * - systemPromptExtension: injected into system-reminder
 * - additionalTools: role-specific tool suggestions
 * - workMode: preferred execution strategy
 */

import type { TeamRole } from './types.js'

// ============================================================
// Types
// ============================================================

export interface RoleCapability {
  goal: string
  preferredModel?: string
  systemPromptExtension: string
  additionalTools?: string[]
  workMode?: 'plan-first' | 'code-first' | 'test-first' | 'review-first'
}

// ============================================================
// Role capability map
// ============================================================

export const ROLE_CAPABILITIES: Record<TeamRole, RoleCapability> = {
  'tech-lead': {
    goal: 'Coordinate the team and accept work only when it satisfies technical quality and integration criteria.',
    preferredModel: 'claude-sonnet-4',
    systemPromptExtension: `你是团队技术负责人。你的职责是：
- 把控整体技术方向和架构决策
- 分配任务并跟踪进度
- 在关键决策点发起投票
- 进行代码评审时关注架构一致性`,
    workMode: 'plan-first',
  },

  'product-manager': {
    goal: 'Translate user needs into clear tasks with expected output and acceptance criteria.',
    preferredModel: 'claude-sonnet-4',
    systemPromptExtension: `你是产品经理。你的职责是：
- 将用户需求转化为可执行的任务描述
- 创建任务时确保描述清晰、验收标准明确
- 在任务分解评审时从用户价值角度判断
- 不参与具体编码，但要确保交付物符合需求`,
    workMode: 'plan-first',
  },

  'architect': {
    goal: 'Design maintainable technical architecture and decompose complex work into executable tasks.',
    preferredModel: 'claude-sonnet-4',
    systemPromptExtension: `你是架构师。你的职责是：
- 负责技术方案设计和系统架构
- 将大任务分解为可执行的子任务
- 代码评审时关注设计模式、可扩展性、性能
- 评估技术风险并提出缓解方案`,
    additionalTools: ['read_architecture', 'analyze_dependencies'],
    workMode: 'plan-first',
  },

  'developer': {
    goal: 'Implement assigned tasks according to expected output and acceptance criteria.',
    preferredModel: 'claude-sonnet-4',
    systemPromptExtension: `你是开发工程师。你的职责是：
- 按照任务描述完成编码实现
- 编写单元测试确保代码质量
- 在代码评审中提供实现层面的反馈
- 遇到架构疑问时向 architect 确认`,
    workMode: 'code-first',
  },

  'qa-engineer': {
    goal: 'Validate delivered work through tests, regression checks, and quality-focused review.',
    preferredModel: 'claude-sonnet-4',
    systemPromptExtension: `你是测试工程师。你的职责是：
- 编写和执行测试用例
- 进行回归测试确保不引入新问题
- 在上线评审投票中从质量角度判断
- 发现 bug 时创建明确的问题描述`,
    additionalTools: ['run_tests', 'coverage_report'],
    workMode: 'test-first',
  },

  'ops-engineer': {
    goal: 'Ensure deployments, operations, rollback, and runtime stability are handled safely.',
    preferredModel: 'claude-sonnet-4',
    systemPromptExtension: `你是运维工程师。你的职责是：
- 负责部署和上线操作
- 在上线审批投票中从稳定性角度判断
- 监控上线后的系统状态
- 紧急情况下执行回滚操作`,
    additionalTools: ['deploy', 'rollback', 'health_check'],
    workMode: 'review-first',
  },

  'designer': {
    goal: 'Deliver user-interface and experience work that is coherent, usable, and visually consistent.',
    preferredModel: 'claude-sonnet-4',
    systemPromptExtension: `你是 UI/UX 设计师。你的职责是：
- 负责界面设计和用户体验
- 执行 UI 相关的开发任务
- 在评审中关注用户体验和视觉一致性`,
    workMode: 'plan-first',
  },
}

// ============================================================
// Agent enhancement
// ============================================================

/**
 * Returns the system prompt extension for a given role.
 * Used by platform adapters to inject role-specific instructions.
 */
export function getRolePrompt(role: TeamRole): string {
  return ROLE_CAPABILITIES[role]?.systemPromptExtension ?? ''
}

/**
 * Returns the recommended work mode for a given role.
 */
export function getWorkMode(role: TeamRole): string {
  return ROLE_CAPABILITIES[role]?.workMode ?? 'code-first'
}

/**
 * Returns additional tool suggestions for a given role.
 */
export function getRoleTools(role: TeamRole): string[] {
  return ROLE_CAPABILITIES[role]?.additionalTools ?? []
}

/**
 * Returns the concise machine-readable goal for a given role.
 */
export function getRoleGoal(role: TeamRole): string {
  return ROLE_CAPABILITIES[role]?.goal ?? ''
}
