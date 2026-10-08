/**
 * Control Plane HTTP Client
 *
 * Handles all communication from team-collab-plugin → team-collab-control.
 * Configure via environment variables:
 *   CONTROL_PLANE_URL      e.g. http://localhost:3100
 *   CONTROL_PLANE_TOKEN    plugin API-key issued by control plane admin
 *   ORG_ID                 organization identifier
 */

export interface ControlPlaneConfig {
  baseUrl: string;
  token: string;
  orgId: string;
  traceId?: string;
}

export interface RegisterRuntimePayload {
  member_id: string;
  team_id: string;
  workspace_id?: string;
  runtime_type: 'local_agent' | 'local_worker' | 'hybrid_worker';
  host_name: string;
  platform: string;
  plugin_version: string;
  capability_snapshot: string[];
}

export interface RegisterRuntimeResult {
  runtime_id: string;
  connectivity_state: string;
  heartbeat_interval_seconds: number;
}

export interface StartSessionPayload {
  task_id: string;
  runtime_id: string;
  session_type: 'task_execution' | 'review' | 'debug' | 'handoff';
  model_route?: string;
  role_context_ref?: string;
  team_context_ref?: string;
}

export interface ReportExecutionPayload {
  session_id: string;
  task_id: string;
  capability_id: string;
  executor_type: 'agent' | 'tool' | 'workflow' | 'human_confirmed';
  result_status:
    | 'success' | 'partial_success' | 'retryable_failure'
    | 'fatal_failure' | 'cancelled';
  summary?: string;
  output_ref?: string;
}

export interface PublishArtifactPayload {
  task_id: string;
  artifact_type: 'doc' | 'code_diff' | 'test_report' | 'review_note' | 'decision_note' | 'screenshot';
  title: string;
  storage_ref: string;
  version: number;
  visibility_scope: 'member' | 'team' | 'org' | 'restricted';
}

export class ControlPlaneClient {
  private readonly cfg: ControlPlaneConfig;

  constructor(cfg: ControlPlaneConfig) {
    this.cfg = cfg;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-plugin-token': this.cfg.token,
      'x-org-id': this.cfg.orgId,
      ...(this.cfg.traceId ? { 'x-trace-id': this.cfg.traceId } : {}),
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
      const error = (err as { error?: { code?: string; message?: string } }).error;
      throw new ControlPlaneError(
        error?.code ?? 'REQUEST_FAILED',
        error?.message ?? res.statusText,
        res.status
      );
    }

    return res.json() as Promise<T>;
  }

  async registerRuntime(payload: RegisterRuntimePayload): Promise<RegisterRuntimeResult> {
    return this.post<RegisterRuntimeResult>('/runtimes/register', payload);
  }

  async heartbeat(runtimeId: string, state: 'online' | 'degraded' | 'offline'): Promise<void> {
    await this.post('/runtimes/heartbeat', {
      runtime_id: runtimeId,
      connectivity_state: state,
    });
  }

  async startSession(payload: StartSessionPayload): Promise<{ session_id: string; status: string }> {
    return this.post('/sessions/start', payload);
  }

  async reportExecution(payload: ReportExecutionPayload): Promise<{ execution_id: string; status: string }> {
    return this.post('/executions/report', payload);
  }

  async publishArtifact(payload: PublishArtifactPayload): Promise<{ artifact_id: string }> {
    return this.post('/artifacts/publish', payload);
  }
}

export class ControlPlaneError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export function createControlPlaneClient(overrides?: Partial<ControlPlaneConfig>): ControlPlaneClient {
  const cfg: ControlPlaneConfig = {
    baseUrl: process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100',
    token: process.env.CONTROL_PLANE_TOKEN ?? '',
    orgId: process.env.ORG_ID ?? 'default',
    ...overrides,
  };

  if (!cfg.token) {
    throw new Error('CONTROL_PLANE_TOKEN is required. Set it in .env or pass via config.');
  }

  return new ControlPlaneClient(cfg);
}
