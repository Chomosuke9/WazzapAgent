import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs-extra';

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  detail: string;
  accountId?: string;
  outcome: 'success' | 'failure' | 'info';
}

const MAX_ENTRIES = 400;

export class ControlPanelAuditLog {
  private readonly filePath: string;
  private readonly entries: AuditEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private persistedLineCount = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/);
      this.persistedLineCount = lines.filter((line) => line.trim()).length;
      for (const line of lines.slice(-MAX_ENTRIES)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as AuditEntry;
          if (parsed?.id && parsed?.timestamp && parsed?.action) {
            this.entries.push(parsed);
          }
        } catch {
          // Ignore a partial final line after an abrupt process stop.
        }
      }
    } catch {
      // Audit visibility must never prevent the gateway from starting.
    }
  }

  record(
    action: string,
    detail: string,
    options: { accountId?: string; outcome?: AuditEntry['outcome'] } = {},
  ): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      action: action.slice(0, 80),
      detail: detail.slice(0, 500),
      outcome: options.outcome || 'success',
    };
    if (options.accountId) entry.accountId = options.accountId;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    const persistedSnapshot = [...this.entries];
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.ensureDir(path.dirname(this.filePath));
        await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        this.persistedLineCount += 1;
        if (this.persistedLineCount > MAX_ENTRIES * 2) {
          const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
          const serialized = persistedSnapshot
            .map((item) => JSON.stringify(item))
            .join('\n');
          await fs.writeFile(temporaryPath, `${serialized}\n`, 'utf8');
          await fs.move(temporaryPath, this.filePath, { overwrite: true });
          this.persistedLineCount = persistedSnapshot.length;
        }
      })
      .catch(() => {
        // Keep the in-memory audit trail even if disk persistence is unavailable.
      });
    return entry;
  }

  list(limit = 100): AuditEntry[] {
    const safeLimit = Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(limit)));
    return this.entries.slice(-safeLimit).reverse();
  }
}
