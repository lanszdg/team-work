/**
 * Code Review Types
 *
 * Type definitions for the Cloud Code Review workflow.
 * Extracted from codeReview.ts to keep file under 500 lines.
 */

export interface CodeReviewSubmission {
  requestId: string
  from: string
  to: string
  branchName: string
  filesChanged: string[]
  description: string
  diffSummary?: string
  timestamp: string
}

export interface CodeReviewResponse {
  requestId: string
  from: string
  approved: boolean
  comments?: string[]
  requestedChanges?: string[]
  timestamp: string
}

export interface MergeRequest {
  requestId: string
  from: string
  to: string
  sourceBranch: string
  targetBranch: string
  description: string
  timestamp: string
}

export interface MergeResponse {
  requestId: string
  from: string
  success: boolean
  message?: string
  timestamp: string
}

export type ReviewState = 'pending' | 'approved' | 'rejected' | 'merged'
