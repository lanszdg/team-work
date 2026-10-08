/**
 * End-to-end integration test: full team lifecycle scenario.
 *
 * Exercises the plugin's real APIs (imported from dist/) sequentially
 * in a single test suite with subtests. No mocking of core logic —
 * only the environment is isolated via createTestEnv().
 *
 * Run: node --test test/test-integration-team-lifecycle.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';

import { createTestEnv, makeMember, makeTeamFile } from './utils.js';

import { createTeam, addMember, removeTeammateFromTeamFile, readTeamFile,
         setMemberMode, setMemberActive, cleanupTeamDirectories } from '../dist/core/teamFile.js';

import { getTeammateStatuses, getTeamSummary } from '../dist/core/teamDiscovery.js';

import { writeToMailbox, readMailbox, readUnreadMessages } from '../dist/core/mailbox.js';

import { findPendingPermissionRequests, autoRespondToPermissionRequests,
         sendPermissionRequest, sendPermissionResponse } from '../dist/hooks/permissionBridge.js';

import { InboxPoller } from '../dist/hooks/inboxPoller.js';

test('full team lifecycle', async (t) => {
  const TEAM_NAME = 'integration-test-team';
  const LEADER_ID = 'team-lead@default';
  const WORKER_1_ID = 'worker-1@default';
  const WORKER_2_ID = 'worker-2@default';

  const env = createTestEnv();

  // Set initial env vars (leader context)
  process.env.CLAUDE_CODE_TEAM_NAME = TEAM_NAME;
  process.env.CLAUDE_CODE_AGENT_NAME = 'team-lead';
  process.env.CLAUDE_CODE_AGENT_ID = LEADER_ID;

  t.after(() => {
    env.cleanup();
  });

  // ---- 1. Create team ----
  await t.test('step 1: create team with a leader', async () => {
    const teamFile = await createTeam({
      teamName: TEAM_NAME,
      leadAgentId: LEADER_ID,
      leadSessionId: 'session-lead',
      description: 'Integration test team',
      agentType: 'agent',
    });

    assert.equal(teamFile.name, TEAM_NAME);
    assert.equal(teamFile.leadAgentId, LEADER_ID);
    assert.equal(teamFile.members.length, 1);
    assert.equal(teamFile.members[0].agentId, LEADER_ID);
    assert.equal(teamFile.members[0].isActive, true);

    // Verify file on disk
    const onDisk = readTeamFile(TEAM_NAME);
    assert.ok(onDisk !== null, 'team config.json should exist');
    assert.equal(onDisk.name, TEAM_NAME);
    assert.ok(existsSync(env.dir + '/teams/' + TEAM_NAME + '/config.json'));
  });

  // ---- 2. Add members ----
  await t.test('step 2: add 2 workers to the team', async () => {
    const worker1 = makeMember({
      agentId: WORKER_1_ID,
      name: 'worker-1',
      tmuxPaneId: '%2',
    });
    const worker2 = makeMember({
      agentId: WORKER_2_ID,
      name: 'worker-2',
      tmuxPaneId: '%3',
    });

    assert.ok(await addMember(TEAM_NAME, worker1), 'adding worker-1 should succeed');
    assert.ok(await addMember(TEAM_NAME, worker2), 'adding worker-2 should succeed');

    // Verify team now has 3 members
    const teamFile = readTeamFile(TEAM_NAME);
    assert.equal(teamFile.members.length, 3, 'team should have leader + 2 workers');
    assert.ok(teamFile.members.some(m => m.name === 'team-lead'));
    assert.ok(teamFile.members.some(m => m.name === 'worker-1'));
    assert.ok(teamFile.members.some(m => m.name === 'worker-2'));
  });

  // ---- 3. Team discovery ----
  await t.test('step 3: team discovery via getTeammateStatuses and getTeamSummary', () => {
    // getTeammateStatuses excludes team-lead, so we should see 2 workers
    const statuses = getTeammateStatuses(TEAM_NAME);
    assert.equal(statuses.length, 2, 'should return 2 worker statuses');
    assert.ok(statuses.some(s => s.name === 'worker-1'));
    assert.ok(statuses.some(s => s.name === 'worker-2'));
    // Both workers are isActive=true by default
    assert.ok(statuses.every(s => s.status === 'running'), 'all workers should be running');

    // getTeamSummary excludes leader too
    const summary = getTeamSummary(TEAM_NAME);
    assert.ok(summary !== null, 'summary should not be null');
    assert.equal(summary.name, TEAM_NAME);
    assert.equal(summary.memberCount, 2, 'member count should exclude leader');
    assert.equal(summary.runningCount, 2);
    assert.equal(summary.idleCount, 0);
  });

  // ---- 4. Send messages between agents ----
  await t.test('step 4: send messages between agents via writeToMailbox', async () => {
    // Leader sends task assignment to worker-1
    await writeToMailbox('worker-1', {
      from: 'team-lead',
      text: JSON.stringify({
        type: 'task_assignment',
        taskId: 'task-001',
        subject: 'Implement feature',
        description: 'Build the core feature',
        assignedBy: 'team-lead',
        timestamp: new Date().toISOString(),
      }),
      timestamp: new Date().toISOString(),
    }, TEAM_NAME);

    // Worker-1 sends idle notification to leader
    await writeToMailbox('team-lead', {
      from: 'worker-1',
      text: JSON.stringify({
        type: 'idle_notification',
        from: 'worker-1',
        timestamp: new Date().toISOString(),
        idleReason: 'available',
        summary: 'Task complete',
      }),
      timestamp: new Date().toISOString(),
    }, TEAM_NAME);

    // Worker-2 sends regular message to leader
    await writeToMailbox('team-lead', {
      from: 'worker-2',
      text: 'Hello from worker-2, reporting in.',
      timestamp: new Date().toISOString(),
    }, TEAM_NAME);
  });

  // ---- 5. Read messages ----
  await t.test('step 5: read messages and verify content', async () => {
    // Leader should have 2 messages in inbox (from worker-1 and worker-2)
    const leaderMessages = await readMailbox('team-lead', TEAM_NAME);
    assert.equal(leaderMessages.length, 2, 'leader should have 2 messages');
    assert.ok(leaderMessages.some(m => m.from === 'worker-1'));
    assert.ok(leaderMessages.some(m => m.from === 'worker-2'));

    // Worker-1 should have 1 message (task assignment from leader)
    const worker1Messages = await readMailbox('worker-1', TEAM_NAME);
    assert.equal(worker1Messages.length, 1, 'worker-1 should have 1 message');
    assert.equal(worker1Messages[0].from, 'team-lead');

    // Verify task assignment content
    const taskAssignment = JSON.parse(worker1Messages[0].text);
    assert.equal(taskAssignment.type, 'task_assignment');
    assert.equal(taskAssignment.taskId, 'task-001');

    // Verify unread counts
    const leaderUnread = await readUnreadMessages('team-lead', TEAM_NAME);
    assert.equal(leaderUnread.length, 2, 'leader should have 2 unread messages');

    const worker1Unread = await readUnreadMessages('worker-1', TEAM_NAME);
    assert.equal(worker1Unread.length, 1, 'worker-1 should have 1 unread message');
  });

  // ---- 6. Permission bridge flow ----
  await t.test('step 6: permission bridge — request, find, auto-respond', async () => {
    const permissionBridgeContext = {
      leaderName: 'team-lead',
      workerName: 'worker-1',
      teamName: TEAM_NAME,
    };

    // Worker-1 sends a permission request to leader
    await sendPermissionRequest(permissionBridgeContext, {
      request_id: 'perm-req-001',
      agent_id: WORKER_1_ID,
      tool_name: 'Read',
      tool_use_id: 'tool-use-001',
      description: 'Need to read a file',
      input: { path: '/some/file.txt' },
      permission_suggestions: [],
    });

    // Leader finds pending permission requests
    const pendingRequests = await findPendingPermissionRequests(permissionBridgeContext);
    assert.ok(pendingRequests.length > 0, 'should find at least one pending permission request');

    const permRequest = pendingRequests.find(r => r.request.request_id === 'perm-req-001');
    assert.ok(permRequest !== undefined, 'should find the specific permission request');
    assert.equal(permRequest.request.tool_name, 'Read');

    // Leader auto-responds with alwaysAllow = ['Read', 'Bash']
    const respondedCount = await autoRespondToPermissionRequests(permissionBridgeContext, {
      alwaysAllow: ['Read', 'Bash'],
    });
    assert.ok(respondedCount > 0, 'should have responded to at least one request');

    // Verify the response was written to worker-1's inbox
    const worker1Messages = await readMailbox('worker-1', TEAM_NAME);
    // Worker-1 now has: 1 task assignment (unread from before) + new permission response
    // Find the permission response
    const permResponseMsg = worker1Messages.find(m => {
      try {
        const parsed = JSON.parse(m.text);
        return parsed.type === 'permission_response';
      } catch {
        return false;
      }
    });
    assert.ok(permResponseMsg !== undefined, 'worker-1 inbox should contain permission response');
    const permResponse = JSON.parse(permResponseMsg.text);
    assert.equal(permResponse.type, 'permission_response');
    assert.equal(permResponse.subtype, 'success');
    assert.equal(permResponse.request_id, 'perm-req-001');
  });

  // ---- 7. Inbox poller ----
  await t.test('step 7: InboxPoller picks up permission response', async () => {
    const protocolMessages = [];
    const regularMessages = [];

    const poller = new InboxPoller(
      { agentName: 'worker-1', teamName: TEAM_NAME, intervalMs: 500 },
      {
        onProtocolMessage: (parsed, original) => {
          protocolMessages.push(parsed);
        },
        onRegularMessage: (msg) => {
          regularMessages.push(msg);
        },
      }
    );

    // Call pollOnce() directly
    await poller.pollOnce();

    // Permission response should be routed as a protocol message
    const permResponses = protocolMessages.filter(m => m.type === 'permission_response');
    assert.ok(permResponses.length > 0, 'should have received permission_response via protocol callback');
    assert.equal(permResponses[0].request_id, 'perm-req-001');

    // Verify the poller's running state
    assert.equal(poller.running, false, 'poller should not be continuously running');
  });

  // ---- 8. Set member mode ----
  await t.test('step 8: set worker-1 mode to plan', () => {
    const result = setMemberMode(TEAM_NAME, 'worker-1', 'plan');
    assert.ok(result, 'setMemberMode should return true');

    const teamFile = readTeamFile(TEAM_NAME);
    const worker1 = teamFile.members.find(m => m.name === 'worker-1');
    assert.equal(worker1.mode, 'plan', 'worker-1 mode should be plan');
  });

  // ---- 9. Set member inactive ----
  await t.test('step 9: mark worker-1 as idle', async () => {
    await setMemberActive(TEAM_NAME, 'worker-1', false);

    const teamFile = readTeamFile(TEAM_NAME);
    const worker1 = teamFile.members.find(m => m.name === 'worker-1');
    assert.equal(worker1.isActive, false, 'worker-1 should be inactive');

    // Verify via getTeammateStatuses
    const statuses = getTeammateStatuses(TEAM_NAME);
    const worker1Status = statuses.find(s => s.name === 'worker-1');
    assert.equal(worker1Status.status, 'idle', 'worker-1 status should be idle');

    // Worker-2 should still be running
    const worker2Status = statuses.find(s => s.name === 'worker-2');
    assert.equal(worker2Status.status, 'running', 'worker-2 should still be running');
  });

  // ---- 10. Remove member ----
  await t.test('step 10: remove worker-2 from team', async () => {
    const result = await removeTeammateFromTeamFile(TEAM_NAME, {
      agentId: WORKER_2_ID,
      name: 'worker-2',
    });
    assert.ok(result, 'removeTeammateFromTeamFile should return true');

    const teamFile = readTeamFile(TEAM_NAME);
    assert.equal(teamFile.members.length, 2, 'team should have 2 members after removal');
    assert.ok(teamFile.members.some(m => m.name === 'team-lead'));
    assert.ok(teamFile.members.some(m => m.name === 'worker-1'));
    assert.ok(!teamFile.members.some(m => m.name === 'worker-2'), 'worker-2 should be removed');
  });

  // ---- 11. Cleanup ----
  await t.test('step 11: cleanup team directories', async () => {
    // Verify team directory exists before cleanup
    const teamDirPath = env.dir + '/teams/' + TEAM_NAME;
    assert.ok(existsSync(teamDirPath), 'team directory should exist before cleanup');

    await cleanupTeamDirectories(TEAM_NAME);

    // Verify the team directory was removed
    assert.ok(!existsSync(teamDirPath), 'team directory should be removed after cleanup');

    // Verify team file is no longer readable
    const teamFile = readTeamFile(TEAM_NAME);
    assert.equal(teamFile, null, 'readTeamFile should return null after cleanup');
  });
});
