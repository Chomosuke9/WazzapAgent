export interface SubagentOutboxFile {
  name: string;
  size_bytes: number | null;
}

export interface SubagentOutboxEntry {
  session_id: string;
  state: 'pending' | 'dead_letter';
  completion_status: string;
  callback_status: number | null;
  callback_error: string | null;
  dead_lettered_at: number | null;
  updated_at: number | null;
  callback_sequence: number;
  output_files: SubagentOutboxFile[];
}

export interface SubagentOutboxResult {
  success: boolean;
  entries: SubagentOutboxEntry[];
  count: number;
}

export interface ControlPanelSubagentActions {
  list: () => Promise<SubagentOutboxResult>;
  retry: (sessionId: string) => Promise<Record<string, unknown>>;
  discard: (sessionId: string) => Promise<Record<string, unknown>>;
}

export class SubagentAdminError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SubagentAdminError';
    this.status = status;
  }
}

function adminConfiguration(): { baseUrl: string; token: string } {
  const baseUrl = (process.env.SUBAGENT_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.SUBAGENT_API_TOKEN || '').trim();
  if (!baseUrl) {
    throw new SubagentAdminError(503, 'Configure SUBAGENT_URL to manage the sub-agent outbox.');
  }
  if (!token) {
    throw new SubagentAdminError(
      503,
      'Configure SUBAGENT_API_TOKEN to manage the sub-agent outbox securely.',
    );
  }
  return { baseUrl, token };
}

async function request(pathname: string, method = 'GET'): Promise<Record<string, unknown>> {
  const { baseUrl, token } = adminConfiguration();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new SubagentAdminError(
      502,
      `Sub-agent outbox API is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof body.report === 'string'
      ? body.report
      : typeof body.error === 'string'
        ? body.error
        : `Sub-agent outbox API returned HTTP ${response.status}.`;
    throw new SubagentAdminError(response.status >= 500 ? 502 : response.status, detail);
  }
  return body;
}

export function createSubagentOutboxActions(): ControlPanelSubagentActions {
  return {
    list: async () => request('/callbacks/outbox') as unknown as SubagentOutboxResult,
    retry: (sessionId: string) => request(
      `/callbacks/${encodeURIComponent(sessionId)}/retry`,
      'POST',
    ),
    discard: (sessionId: string) => request(
      `/callbacks/${encodeURIComponent(sessionId)}/discard`,
      'POST',
    ),
  };
}
