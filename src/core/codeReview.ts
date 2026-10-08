/**
 * Cloud Code Review Workflow
 *
 * Multi-machine code review and merge request system.
 *
 * Flow:
 *   1. Teammate calls submitCodeReview() → sends code_review_submission via cloud event
 *   2. Leader's onCodeReviewSubmitted callback fires when SSE delivers the request
 *   3. Leader calls approveCodeReview() or rejectCodeReview() → sends code_review_response via cloud event
 *   4. Teammate's onCodeReviewResponse callback fires when SSE delivers the response
 *   5. After approval, teammate calls requestMerge() → sends merge_request via cloud event
 *   6. Leader's onMergeRequested callback fires, calls respondToMerge() → sends merge_response via cloud event
 *   7. CR state transitions: pending → approved → merged (or rejected)
 */

import { MessageDispatcher } from './messageDispatcher.js'
import { randomUUID } from 'crypto'
import type {
  CodeReviewSubmission,
  CodeReviewResponse,
  MergeRequest,
  MergeResponse,
  ReviewState,
} from './codeReviewTypes.js'

// Re-export types for backward compatibility
export type {
  CodeReviewSubmission,
  CodeReviewResponse,
  MergeRequest,
  MergeResponse,
  ReviewState,
} from './codeReviewTypes.js'

interface InternalReviewEntry {
  submission: CodeReviewSubmission
  _state: ReviewState
}

// ============================================================
// CloudCodeReview
// ============================================================

export class CloudCodeReview {
  private dispatcher: MessageDispatcher
  private teamName: string
  private agentId: string
  private agentName: string
  private pendingReviews: Map<string, InternalReviewEntry>
  private reviewSubmittedCallback: ((cr: CodeReviewSubmission) => Promise<void>) | null
  private reviewResponseCallback: ((response: CodeReviewResponse) => void) | null
  private mergeRequestedCallback: ((mr: MergeRequest) => Promise<void>) | null
  private mergeResponseCallback: ((response: MergeResponse) => void) | null
  private isListening: boolean

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
    this.pendingReviews = new Map()
    this.reviewSubmittedCallback = null
    this.reviewResponseCallback = null
    this.mergeRequestedCallback = null
    this.mergeResponseCallback = null
    this.isListening = false
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Start listening for incoming code review and merge messages via SSE.
   * Returns once the SSE connection is established.
   *
   * Because the underlying SSE read loop is an infinite async operation,
   * we access the cloud router directly and start SSE in fire-and-forget mode.
   */
  async startListening(): Promise<void> {
    if (this.isListening) return

    this.isListening = true

    // Get the underlying router and start SSE in fire-and-forget mode.
    const router = this.dispatcher.getCloudRouter()
    if (router) {
      console.error(`[CloudCodeReview] Starting SSE for ${this.agentName} on repo=${router.repo}`)
      let connected = false
      const listeningPromise = router.startListening({
        onMessage: (msg) => {
          console.error(`[CloudCodeReview ${this.agentName}] SSE message: type=${msg.type}, id=${msg.messageId}`)
          connected = true
          this.handleIncomingMessage(msg)
        },
      }).then(() => {
        console.error(`[CloudCodeReview ${this.agentName}] SSE stream ended`)
      }).catch((err) => {
        console.error(`[CloudCodeReview ${this.agentName}] SSE error: ${err}`)
      })
      // Wait up to 5s for SSE to establish
      await Promise.race([
        listeningPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            console.error(`[CloudCodeReview ${this.agentName}] SSE start timeout, connected=${connected}`)
            resolve()
          }, 5000)
        }),
      ])
    } else {
      console.error(`[CloudCodeReview ${this.agentName}] No cloud router available`)
    }
  }

  /**
   * Stop listening for incoming messages.
   */
  stop(): void {
    this.isListening = false
    this.dispatcher.stopCloudListening()
  }

  // ============================================================
  // Teammate: Submit code for review
  // ============================================================

  /**
   * Teammate submits code for review to the team leader.
   *
   * Sends a `code_review_submission` message via cloud routing.
   * Returns the submission object with generated requestId.
   */
  async submitCodeReview(
    leaderAgentId: string,
    branchName: string,
    filesChanged: string[],
    description: string,
    diffSummary?: string,
  ): Promise<CodeReviewSubmission> {
    const requestId = randomUUID()

    const submission: CodeReviewSubmission = {
      requestId,
      from: this.agentName,
      to: leaderAgentId,
      branchName,
      filesChanged,
      description,
      diffSummary,
      timestamp: new Date().toISOString(),
    }

    this.pendingReviews.set(requestId, {
      submission,
      _state: 'pending',
    })

    const payload = {
      type: 'code_review_submission',
      ...submission,
    }

    await this.dispatcher.sendMessage(leaderAgentId, leaderAgentId, payload)

    return submission
  }

  // ============================================================
  // Leader: Approve code review
  // ============================================================

  /**
   * Leader approves a code review submission.
   *
   * Sends a `code_review_response` with approved=true via cloud routing.
   * Updates local review state to 'approved'.
   */
  async approveCodeReview(
    requestId: string,
    teammateAgentId: string,
    comments?: string[],
  ): Promise<CodeReviewResponse> {
    const response: CodeReviewResponse = {
      requestId,
      from: this.agentName,
      approved: true,
      comments,
      timestamp: new Date().toISOString(),
    }

    // Update local state
    const entry = this.pendingReviews.get(requestId)
    if (entry) {
      entry._state = 'approved'
    }

    const payload = {
      type: 'code_review_response',
      ...response,
    }

    await this.dispatcher.sendMessage(teammateAgentId, teammateAgentId, payload)

    return response
  }

  // ============================================================
  // Leader: Reject code review
  // ============================================================

  /**
   * Leader rejects a code review with requested changes.
   *
   * Sends a `code_review_response` with approved=false via cloud routing.
   * Updates local review state to 'rejected'.
   */
  async rejectCodeReview(
    requestId: string,
    teammateAgentId: string,
    requestedChanges: string[],
    comments?: string[],
  ): Promise<CodeReviewResponse> {
    const response: CodeReviewResponse = {
      requestId,
      from: this.agentName,
      approved: false,
      comments,
      requestedChanges,
      timestamp: new Date().toISOString(),
    }

    // Update local state
    const entry = this.pendingReviews.get(requestId)
    if (entry) {
      entry._state = 'rejected'
    }

    const payload = {
      type: 'code_review_response',
      ...response,
    }

    await this.dispatcher.sendMessage(teammateAgentId, teammateAgentId, payload)

    return response
  }

  // ============================================================
  // Teammate: Request merge after CR approved
  // ============================================================

  /**
   * Teammate requests a merge after CR approved.
   *
   * Sends a `merge_request` message via cloud routing.
   * Returns the merge request object with generated requestId.
   */
  async requestMerge(
    leaderAgentId: string,
    sourceBranch: string,
    targetBranch: string,
    description: string,
  ): Promise<MergeRequest> {
    const requestId = randomUUID()

    const mergeReq: MergeRequest = {
      requestId,
      from: this.agentName,
      to: leaderAgentId,
      sourceBranch,
      targetBranch,
      description,
      timestamp: new Date().toISOString(),
    }

    // Track merge request as a pending review entry
    this.pendingReviews.set(requestId, {
      submission: {
        requestId,
        from: this.agentName,
        to: leaderAgentId,
        branchName: sourceBranch,
        filesChanged: [],
        description,
        timestamp: new Date().toISOString(),
      },
      _state: 'pending',
    })

    const payload = {
      type: 'merge_request',
      ...mergeReq,
    }

    await this.dispatcher.sendMessage(leaderAgentId, leaderAgentId, payload)

    return mergeReq
  }

  // ============================================================
  // Leader: Respond to merge request
  // ============================================================

  /**
   * Leader responds to a merge request.
   *
   * Sends a `merge_response` message via cloud routing.
   * Updates local review state to 'merged' on success.
   */
  async respondToMerge(
    requestId: string,
    teammateAgentId: string,
    success: boolean,
    message?: string,
  ): Promise<void> {
    const response = {
      type: 'merge_response',
      requestId,
      from: this.agentName,
      success,
      message,
      timestamp: new Date().toISOString(),
    }

    // Update local state on success
    const entry = this.pendingReviews.get(requestId)
    if (entry && success) {
      entry._state = 'merged'
    }

    await this.dispatcher.sendMessage(teammateAgentId, teammateAgentId, response)
  }

  // ============================================================
  // Event listeners
  // ============================================================

  /**
   * Register a callback for incoming code review submissions.
   * Fires when a teammate submits code for review.
   */
  onCodeReviewSubmitted(callback: (cr: CodeReviewSubmission) => Promise<void>): void {
    this.reviewSubmittedCallback = callback
  }

  /**
   * Register a callback for code review responses.
   * Fires when a leader approves or rejects a code review.
   */
  onCodeReviewResponse(callback: (response: CodeReviewResponse) => void): void {
    this.reviewResponseCallback = callback
  }

  /**
   * Register a callback for incoming merge requests.
   * Fires when a teammate requests a merge.
   */
  onMergeRequested(callback: (mr: MergeRequest) => Promise<void>): void {
    this.mergeRequestedCallback = callback
  }

  /**
   * Register a callback for merge responses.
   * Fires when a leader responds to a merge request.
   */
  onMergeResponse(callback: (response: MergeResponse) => void): void {
    this.mergeResponseCallback = callback
  }

  // ============================================================
  // State
  // ============================================================

  /**
   * Get the current state of a review by its requestId.
   *
   * Returns 'pending', 'approved', 'rejected', or 'merged'.
   * Returns undefined if the requestId is not known.
   */
  getReviewState(requestId: string): ReviewState | undefined {
    return this.pendingReviews.get(requestId)?._state
  }

  // ============================================================
  // Internal: Handle incoming messages from SSE
  // ============================================================

  private handleIncomingMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return

    let parsed: Record<string, unknown>

    // The message text may be a JSON string containing the actual payload
    if (typeof msg.text === 'string') {
      try {
        parsed = JSON.parse(msg.text)
      } catch {
        // If text is not valid JSON, it might be the message itself
        parsed = msg
      }
    } else {
      parsed = msg
    }

    const type = parsed.type
    console.error(`[CloudCodeReview] handleIncomingMessage type=${type}, text=${typeof msg.text === 'string' ? msg.text.slice(0, 100) : 'N/A'}`)

    if (type === 'code_review_submission') {
      const submission: CodeReviewSubmission = {
        requestId: String(parsed.requestId ?? ''),
        from: String(parsed.from ?? ''),
        to: String(parsed.to ?? ''),
        branchName: String(parsed.branchName ?? ''),
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged as string[] : [],
        description: String(parsed.description ?? ''),
        diffSummary: parsed.diffSummary ? String(parsed.diffSummary) : undefined,
        timestamp: String(parsed.timestamp ?? ''),
      }

      // Store locally for state tracking
      this.pendingReviews.set(submission.requestId, {
        submission,
        _state: 'pending',
      })

      console.error(`[CloudCodeReview] Firing reviewSubmittedCallback for ${submission.requestId}`)
      this.reviewSubmittedCallback?.(submission)
    }

    if (type === 'code_review_response') {
      const response: CodeReviewResponse = {
        requestId: String(parsed.requestId ?? ''),
        from: String(parsed.from ?? ''),
        approved: Boolean(parsed.approved),
        comments: Array.isArray(parsed.comments) ? parsed.comments as string[] : undefined,
        requestedChanges: Array.isArray(parsed.requestedChanges) ? parsed.requestedChanges as string[] : undefined,
        timestamp: String(parsed.timestamp ?? ''),
      }

      // Update local state
      const entry = this.pendingReviews.get(response.requestId)
      if (entry) {
        entry._state = response.approved ? 'approved' : 'rejected'
      }

      console.error(`[CloudCodeReview] Firing reviewResponseCallback approved=${response.approved}`)
      this.reviewResponseCallback?.(response)
    }

    if (type === 'merge_request') {
      const mergeReq: MergeRequest = {
        requestId: String(parsed.requestId ?? ''),
        from: String(parsed.from ?? ''),
        to: String(parsed.to ?? ''),
        sourceBranch: String(parsed.sourceBranch ?? ''),
        targetBranch: String(parsed.targetBranch ?? ''),
        description: String(parsed.description ?? ''),
        timestamp: String(parsed.timestamp ?? ''),
      }

      this.pendingReviews.set(mergeReq.requestId, {
        submission: {
          requestId: mergeReq.requestId,
          from: mergeReq.from,
          to: mergeReq.to,
          branchName: mergeReq.sourceBranch,
          filesChanged: [],
          description: mergeReq.description,
          timestamp: mergeReq.timestamp,
        },
        _state: 'pending',
      })

      this.mergeRequestedCallback?.(mergeReq)
    }

    if (type === 'merge_response') {
      const response: MergeResponse = {
        requestId: String(parsed.requestId ?? ''),
        from: String(parsed.from ?? ''),
        success: Boolean(parsed.success),
        message: parsed.message ? String(parsed.message) : undefined,
        timestamp: String(parsed.timestamp ?? ''),
      }

      const entry = this.pendingReviews.get(response.requestId)
      if (entry && response.success) {
        entry._state = 'merged'
      }

      this.mergeResponseCallback?.(response)
    }
  }
}
