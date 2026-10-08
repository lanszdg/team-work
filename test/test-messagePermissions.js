import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkMessagePermission, getRequiredPermission } from '../dist/core/messagePermissions.js'

describe('checkMessagePermission', () => {
  it('tech-lead can send task_assignment', () => {
    const result = checkMessagePermission('tech-lead', 'task_assignment')
    assert.strictEqual(result.allowed, true)
  })

  it('developer cannot send task_assignment', () => {
    const result = checkMessagePermission('developer', 'task_assignment')
    assert.strictEqual(result.allowed, false)
    assert.strictEqual(result.requiredPermission, 'canCreateTask')
  })

  it('developer can send code_review_submission', () => {
    const result = checkMessagePermission('developer', 'code_review_submission')
    assert.strictEqual(result.allowed, true)
  })

  it('ops-engineer cannot send shutdown_request', () => {
    const result = checkMessagePermission('ops-engineer', 'shutdown_request')
    assert.strictEqual(result.allowed, false)
    assert.strictEqual(result.requiredPermission, 'canManageTeam')
  })

  it('tech-lead can send shutdown_request', () => {
    const result = checkMessagePermission('tech-lead', 'shutdown_request')
    assert.strictEqual(result.allowed, true)
  })

  it('unknown message type is always allowed', () => {
    const result = checkMessagePermission('developer', 'idle_notification')
    assert.strictEqual(result.allowed, true)
  })

  it('unregistered protocol-like JSON is denied by default', () => {
    const raw = JSON.stringify({ type: 'unknown_protocol', fromAgentId: 'dev-1' })
    const result = checkMessagePermission('developer', 'unknown_protocol', raw)
    assert.strictEqual(result.allowed, false)
    assert.strictEqual(result.denyReason, 'unregistered protocol message type')
  })

  it('plain text with an unknown message type is still allowed', () => {
    const result = checkMessagePermission('developer', 'custom_message', 'hello teammate')
    assert.strictEqual(result.allowed, true)
  })

  it('task lifecycle permissions use execution and completion capabilities', () => {
    assert.strictEqual(checkMessagePermission('developer', 'task_claimed').allowed, true)
    assert.strictEqual(checkMessagePermission('developer', 'task_submitted_for_review').allowed, true)

    const developerComplete = checkMessagePermission('developer', 'task_completed')
    assert.strictEqual(developerComplete.allowed, false)
    assert.strictEqual(developerComplete.requiredPermission, 'canCompleteTask')

    assert.strictEqual(checkMessagePermission('tech-lead', 'task_completed').allowed, true)
    assert.strictEqual(checkMessagePermission('qa-engineer', 'task_completed').allowed, true)
  })

  it('product-manager can create tasks', () => {
    const result = checkMessagePermission('product-manager', 'task_assignment')
    assert.strictEqual(result.allowed, true)
  })

  it('architect can review code', () => {
    const result = checkMessagePermission('architect', 'code_review_response')
    assert.strictEqual(result.allowed, true)
  })

  it('designer cannot approve releases', () => {
    const result = checkMessagePermission('designer', 'merge_response')
    assert.strictEqual(result.allowed, false)
    assert.strictEqual(result.requiredPermission, 'canApproveRelease')
  })
})

describe('getRequiredPermission', () => {
  it('returns permission key for known types', () => {
    assert.strictEqual(getRequiredPermission('task_assignment'), 'canCreateTask')
    assert.strictEqual(getRequiredPermission('shutdown_request'), 'canManageTeam')
    assert.strictEqual(getRequiredPermission('task_completed'), 'canCompleteTask')
  })

  it('returns undefined for unrestricted types', () => {
    assert.strictEqual(getRequiredPermission('idle_notification'), undefined)
    assert.strictEqual(getRequiredPermission('custom_message'), undefined)
  })
})
