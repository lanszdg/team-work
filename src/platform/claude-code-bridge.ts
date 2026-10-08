/**
 * Claude Code Bridge
 *
 * Binds Claude Code hook lifecycle events to control-plane API calls.
 *
 * Hook flow:
 *   Plugin startup → registerRuntime()
 *   Task assigned  → startSession()
 *   Stop hook      → reportExecution() + publishArtifact()
 *   Heartbeat loop → heartbeat()
 */

import os from 'os';
import { ControlPlaneClient, ControlPlaneError, type ReportExecutionPayload } from './control-plane-client.js';

const PLUGIN_VERSION = '1.0.0';

export interface BridgeOptions {
  client: ControlPlaneClient;
  memberId: string;
  teamId: string;
  workspaceId?: string;
  capabilitySnapshot?: string[];
}

export interface BridgeSession {
  runtime_id: string;
  session_id: string;
  task_id: string;
}

export class ClaudeCodeBridge {
  private readonly client: ControlPlaneClient;
  private readonly opts: BridgeOptions;
  private runtimeId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(opts: BridgeOptions) {
    this.client = opts.client;
    this.opts = opts;
  }

  async init(): Promise<string> {
    const result = await this.client.registerRuntime({
      member_id: this.opts.memberId,
      team_id: this.opts.teamId,
      workspace_id: this.opts.workspaceId,
      runtime_type: 'local_agent',
      host_name: os.hostname(),
      platform: process.platform,
      plugin_version: PLUGIN_VERSION,
      capability_snapshot: this.opts.capabilitySnapshot ?? [
        'code_generation', 'code_review', 'test_generation', 'documentation',
      ],
    });

    this.runtimeId = result.runtime_id;
    const intervalMs = (result.heartbeat_interval_seconds ?? 15) * 1000;
    this.startHeartbeat(intervalMs);

    return this.runtimeId;
  }

  async beginTask(taskId: string, sessionType: 'task_execution' | 'review' = 'task_execution'): Promise<BridgeSession> {
    if (!this.runtimeId) throw new Error('Bridge not initialized. Call init() first.');

    const { session_id } = await this.client.startSession({
      task_id: taskId,
      runtime_id: this.runtimeId,
      session_type: sessionType,
      role_context_ref: `role:${this.opts.memberId}`,
    });

    return { runtime_id: this.runtimeId, session_id, task_id: taskId };
  }

  async reportDone(
    session: BridgeSession,
    opts: {
      success: boolean;
      summary?: string;
      artifactStorageRef?: string;
      artifactTitle?: string;
    }
  ): Promise<void> {
    const execPayload: ReportExecutionPayload = {
      session_id: session.session_id,
      task_id: session.task_id,
      capability_id: 'code_generation',
      executor_type: 'agent',
      result_status: opts.success ? 'success' : 'retryable_failure',
      summary: opts.summary,
    };

    await this.client.reportExecution(execPayload);

    if (opts.success && opts.artifactStorageRef && opts.artifactTitle) {
      await this.client.publishArtifact({
        task_id: session.task_id,
        artifact_type: 'code_diff',
        title: opts.artifactTitle,
        storage_ref: opts.artifactStorageRef,
        version: 1,
        visibility_scope: 'team',
      });
    }
  }

  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    if (this.runtimeId) {
      await this.client.heartbeat(this.runtimeId, 'offline').catch(() => {});
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(async () => {
      if (!this.runtimeId) return;
      await this.client.heartbeat(this.runtimeId, 'online').catch((err: unknown) => {
        if (err instanceof ControlPlaneError) {
          console.warn(`[bridge] heartbeat failed: ${err.message}`);
        }
      });
    }, intervalMs);

    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
