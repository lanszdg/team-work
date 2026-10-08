/**
 * Cloud Plan Approval Workflow
 *
 * Teammate submits an implementation plan for leader review.
 * Leader approves or rejects the plan with optional feedback.
 * Both parties receive real-time notifications via SSE.
 *
 * Flow:
 *   1. Teammate calls submitPlan() → sends plan_approval_request via cloud event
 *   2. Leader's onPlanSubmitted callback fires when SSE delivers the request
 *   3. Leader calls approvePlan() or rejectPlan() → sends plan_approval_response via cloud event
 *   4. Teammate's onPlanResponse callback fires when SSE delivers the response
 *   5. Plan state transitions: pending → approved | rejected
 */

import { MessageDispatcher } from './messageDispatcher.js'
import { randomUUID } from 'crypto'

// ============================================================
// Types
// ============================================================

export interface PlanApprovalRequestPayload {
  type: 'plan_approval_request'
  requestId: string
  from: string
  to: string
  planContent: string
  planFilePath?: string
  timestamp: string
}

export interface PlanApprovalResponsePayload {
  type: 'plan_approval_response'
  requestId: string
  from: string
  approved: boolean
  feedback?: string
  permissionMode?: string
  timestamp: string
}

export type PlanState = 'pending' | 'approved' | 'rejected'

// ============================================================
// CloudPlanApproval
// ============================================================

export class CloudPlanApproval {
  private dispatcher: MessageDispatcher
  private teamName: string
  private agentId: string
  private agentName: string
  private pendingPlans: Map<string, PlanApprovalRequestPayload & { _state?: PlanState }>
  private planStates: Map<string, PlanState>
  private planSubmittedCallback: ((plan: PlanApprovalRequestPayload) => Promise<void>) | null
  private planResponseCallback: ((response: PlanApprovalResponsePayload) => void) | null

  constructor(config: {
    dispatcher: MessageDispatcher
    teamName: string
    agentId: string
    agentName: string
  }) {
    this.dispatcher = config.dispatcher
    this.teamName = config.teamName
    this.agentId = config.agentId
    this.agentName = config.agentName
    this.pendingPlans = new Map()
    this.planStates = new Map()
    this.planSubmittedCallback = null
    this.planResponseCallback = null
  }

  // ============================================================
  // Teammate submits plan for leader review
  // ============================================================

  /**
   * Teammate submits an implementation plan for leader review.
   *
   * Creates a PlanApprovalRequestPayload and sends it via the
   * MessageDispatcher (pure cloud transport).
   *
   * The plan is tracked locally with 'pending' state.
   */
  async submitPlan(
    leaderAgentId: string,
    planContent: string,
    planFilePath?: string,
  ): Promise<PlanApprovalRequestPayload> {
    const requestId = randomUUID()

    const payload: PlanApprovalRequestPayload = {
      type: 'plan_approval_request',
      requestId,
      from: this.agentName,
      to: leaderAgentId,
      planContent,
      planFilePath,
      timestamp: new Date().toISOString(),
    }

    // Track locally as pending
    this.pendingPlans.set(requestId, payload)
    this.planStates.set(requestId, 'pending')

    // Send via dispatcher
    await this.dispatcher.sendMessage(
      leaderAgentId,
      leaderAgentId, // recipientName — cloud routing uses agentId
      payload,
    )

    return payload
  }

  /**
   * Internal helper: submitPlan that returns the transport type used.
   * Useful for testing that cloud transport is active.
   */
  async submitPlanWithTransport(
    leaderAgentId: string,
    planContent: string,
    planFilePath?: string,
  ): Promise<'cloud' | 'local'> {
    const requestId = randomUUID()

    const payload: PlanApprovalRequestPayload = {
      type: 'plan_approval_request',
      requestId,
      from: this.agentName,
      to: leaderAgentId,
      planContent,
      planFilePath,
      timestamp: new Date().toISOString(),
    }

    this.pendingPlans.set(requestId, payload)
    this.planStates.set(requestId, 'pending')

    const transport = await this.dispatcher.sendMessage(leaderAgentId, leaderAgentId, payload)
    return transport ? 'cloud' : 'local'
  }

  // ============================================================
  // Leader approves a plan
  // ============================================================

  /**
   * Leader approves a submitted plan.
   *
   * Sends a PlanApprovalResponsePayload with approved=true via the
   * MessageDispatcher to the teammate who submitted the plan.
   *
   * Updates local plan state to 'approved'.
   */
  async approvePlan(
    requestId: string,
    teammateAgentId: string,
    permissionMode?: string,
  ): Promise<PlanApprovalResponsePayload> {
    const response: PlanApprovalResponsePayload = {
      type: 'plan_approval_response',
      requestId,
      from: this.agentName,
      approved: true,
      permissionMode,
      timestamp: new Date().toISOString(),
    }

    // Update local state
    this._updatePlanState(requestId, 'approved')

    // Send via dispatcher
    await this.dispatcher.sendMessage(
      teammateAgentId,
      teammateAgentId,
      response,
    )

    return response
  }

  // ============================================================
  // Leader rejects a plan with feedback
  // ============================================================

  /**
   * Leader rejects a submitted plan with feedback.
   *
   * Sends a PlanApprovalResponsePayload with approved=false via the
   * MessageDispatcher to the teammate who submitted the plan.
   *
   * Updates local plan state to 'rejected'.
   */
  async rejectPlan(
    requestId: string,
    teammateAgentId: string,
    feedback: string,
  ): Promise<PlanApprovalResponsePayload> {
    const response: PlanApprovalResponsePayload = {
      type: 'plan_approval_response',
      requestId,
      from: this.agentName,
      approved: false,
      feedback,
      timestamp: new Date().toISOString(),
    }

    // Update local state
    this._updatePlanState(requestId, 'rejected')

    // Send via dispatcher
    await this.dispatcher.sendMessage(
      teammateAgentId,
      teammateAgentId,
      response,
    )

    return response
  }

  // ============================================================
  // Listen for incoming plan submissions (for leader)
  // ============================================================

  /**
   * Register a callback to receive incoming plan approval requests.
   *
   * The leader should call this before the teammate submits plans.
   * Starts SSE listening on the dispatcher if not already active.
   *
   * Filters incoming cloud messages for 'plan_approval_request' type
   * and forwards them to the callback.
   */
  onPlanSubmitted(
    callback: (plan: PlanApprovalRequestPayload) => Promise<void>,
  ): void {
    this.planSubmittedCallback = callback

    // Start SSE listening if not already active
    if (this.dispatcher.isCloudActive && !this.dispatcher.isCloudListening) {
      this.dispatcher.startCloudListening((msg: any) => {
        this._handleIncomingMessage(msg)
      })
    }
  }

  // ============================================================
  // Listen for plan responses (for teammate)
  // ============================================================

  /**
   * Register a callback to receive plan approval/rejection responses.
   *
   * The teammate should call this before submitting a plan so they
   * can receive the leader's decision.
   *
   * Filters incoming cloud messages for 'plan_approval_response' type
   * and forwards them to the callback. Also updates local plan state.
   */
  onPlanResponse(
    callback: (response: PlanApprovalResponsePayload) => void,
  ): void {
    this.planResponseCallback = callback

    // Start SSE listening if not already active
    if (this.dispatcher.isCloudActive && !this.dispatcher.isCloudListening) {
      this.dispatcher.startCloudListening((msg: any) => {
        this._handleIncomingMessage(msg)
      })
    }
  }

  // ============================================================
  // Get plan state
  // ============================================================

  /**
   * Get the current state of a plan by its requestId.
   *
   * Returns 'pending', 'approved', 'rejected', or undefined if the
   * requestId is not known.
   */
  getPlanState(requestId: string): PlanState | undefined {
    return this.planStates.get(requestId)
  }

  // ============================================================
  // Stop listening
  // ============================================================

  /**
   * Stop SSE listening and clear callbacks.
   */
  stopListening(): void {
    this.dispatcher.stopCloudListening()
    this.planSubmittedCallback = null
    this.planResponseCallback = null
  }

  // ============================================================
  // Private helpers
  // ============================================================

  /**
   * Handle an incoming message from SSE — filter by type and dispatch
   * to the appropriate callback.
   */
  private _handleIncomingMessage(msg: any): void {
    // Parse the message — it may be wrapped in a CloudMessage envelope
    let parsed: any = msg
    if (typeof msg.text === 'string') {
      try {
        parsed = JSON.parse(msg.text)
      } catch {
        parsed = msg
      }
    }

    if (parsed?.type === 'plan_approval_request' && this.planSubmittedCallback) {
      const plan = parsed as PlanApprovalRequestPayload
      // Track the incoming plan locally
      this.pendingPlans.set(plan.requestId, plan)
      this.planStates.set(plan.requestId, 'pending')
      this.planSubmittedCallback(plan).catch((err) => {
        console.error('[CloudPlanApproval] Error in onPlanSubmitted callback:', err)
      })
    }

    if (parsed?.type === 'plan_approval_response' && this.planResponseCallback) {
      const response = parsed as PlanApprovalResponsePayload
      // Update local state
      this._updatePlanState(response.requestId, response.approved ? 'approved' : 'rejected')
      try {
        this.planResponseCallback(response)
      } catch (err) {
        console.error('[CloudPlanApproval] Error in onPlanResponse callback:', err)
      }
    }
  }

  /**
   * Update the local state of a tracked plan.
   */
  private _updatePlanState(requestId: string, state: PlanState): void {
    this.planStates.set(requestId, state)

    // Also ensure the plan is tracked if we don't have it yet
    if (!this.pendingPlans.has(requestId)) {
      this.pendingPlans.set(requestId, {
        type: 'plan_approval_request',
        requestId,
        from: 'unknown',
        to: this.agentName,
        planContent: '',
        timestamp: new Date().toISOString(),
      })
    }
  }
}
