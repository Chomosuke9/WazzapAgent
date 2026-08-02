import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import logger from '../logger.js';

const GIT_TIMEOUT_MS = 45_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;

export interface ReleaseInfo {
  version: string;
  compatibilityVersion: string;
  commit: string | null;
}

export interface UpdateStatus {
  checkedAt: string;
  repositoryAvailable: boolean;
  upstream: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  updateAvailable: boolean;
  canUpdate: boolean;
  compatibilityChanged: boolean;
  current: ReleaseInfo;
  available: ReleaseInfo | null;
  message: string;
}

export interface UpdateResult {
  updated: boolean;
  previousCommit: string | null;
  currentCommit: string | null;
  status: UpdateStatus;
}

export class ProjectUpdateError extends Error {
  readonly code: string;
  readonly status?: UpdateStatus;

  constructor(code: string, message: string, status?: UpdateStatus) {
    super(message);
    this.name = 'ProjectUpdateError';
    this.code = code;
    this.status = status;
  }
}

interface PackageMetadata {
  version?: unknown;
  compatibilityVersion?: unknown;
}

function normalizedCompatibilityVersion(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'unknown';
}

export function parseReleaseMetadata(text: string): Omit<ReleaseInfo, 'commit'> {
  let parsed: PackageMetadata;
  try {
    parsed = JSON.parse(text) as PackageMetadata;
  } catch {
    throw new ProjectUpdateError('invalid_metadata', 'package.json is not valid JSON.');
  }
  return {
    version:
      typeof parsed.version === 'string' && parsed.version.trim()
        ? parsed.version.trim()
        : 'unknown',
    compatibilityVersion: normalizedCompatibilityVersion(
      parsed.compatibilityVersion,
    ),
  };
}

function runGit(
  projectRoot: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: projectRoot,
        timeout,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export class ProjectUpdateManager {
  readonly projectRoot: string;

  constructor(projectRoot = process.cwd()) {
    this.projectRoot = path.resolve(projectRoot);
  }

  private async localRelease(commit: string | null): Promise<ReleaseInfo> {
    const text = await readFile(path.join(this.projectRoot, 'package.json'), 'utf8');
    return { ...parseReleaseMetadata(text), commit };
  }

  async getStatus(refresh = false): Promise<UpdateStatus> {
    const checkedAt = new Date().toISOString();
    let commit: string | null = null;
    try {
      commit = await runGit(this.projectRoot, ['rev-parse', '--short=12', 'HEAD']);
    } catch {
      const current = await this.localRelease(null);
      return {
        checkedAt,
        repositoryAvailable: false,
        upstream: null,
        dirty: false,
        ahead: 0,
        behind: 0,
        updateAvailable: false,
        canUpdate: false,
        compatibilityChanged: false,
        current,
        available: null,
        message: 'This installation is not a Git checkout.',
      };
    }

    const current = await this.localRelease(commit);
    const dirty = Boolean(
      await runGit(this.projectRoot, ['status', '--porcelain', '--untracked-files=normal']),
    );
    let upstream: string;
    try {
      upstream = await runGit(this.projectRoot, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ]);
    } catch {
      return {
        checkedAt,
        repositoryAvailable: true,
        upstream: null,
        dirty,
        ahead: 0,
        behind: 0,
        updateAvailable: false,
        canUpdate: false,
        compatibilityChanged: false,
        current,
        available: null,
        message: 'No upstream branch is configured for this checkout.',
      };
    }

    let refreshFailed = false;
    if (refresh) {
      try {
        await runGit(this.projectRoot, ['fetch', '--quiet', '--prune']);
      } catch {
        refreshFailed = true;
        logger.warn('control panel update check could not fetch upstream');
      }
    }

    let ahead = 0;
    let behind = 0;
    try {
      const counts = await runGit(this.projectRoot, [
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...${upstream}`,
      ]);
      const [aheadText, behindText] = counts.split(/\s+/);
      ahead = Number(aheadText) || 0;
      behind = Number(behindText) || 0;
    } catch {
      refreshFailed = true;
    }

    let available: ReleaseInfo | null = null;
    try {
      const [remotePackage, remoteCommit] = await Promise.all([
        runGit(this.projectRoot, ['show', `${upstream}:package.json`]),
        runGit(this.projectRoot, ['rev-parse', '--short=12', upstream]),
      ]);
      available = { ...parseReleaseMetadata(remotePackage), commit: remoteCommit };
    } catch {
      refreshFailed = true;
    }

    const updateAvailable = behind > 0;
    const compatibilityChanged = Boolean(
      available
      && available.compatibilityVersion !== current.compatibilityVersion,
    );
    const canUpdate = updateAvailable && !dirty && ahead === 0 && !refreshFailed;
    let message = 'Up to date.';
    if (refreshFailed) message = 'The upstream update check could not be completed.';
    else if (dirty) message = 'Local changes must be committed or removed before updating.';
    else if (ahead > 0 && behind > 0) message = 'Local and upstream histories have diverged.';
    else if (updateAvailable) message = `${behind} update commit${behind === 1 ? '' : 's'} available.`;
    else if (ahead > 0) message = `This checkout is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream.`;

    return {
      checkedAt,
      repositoryAvailable: true,
      upstream,
      dirty,
      ahead,
      behind,
      updateAvailable,
      canUpdate,
      compatibilityChanged,
      current,
      available,
      message,
    };
  }

  async update(confirmCompatibilityChange = false): Promise<UpdateResult> {
    const before = await this.getStatus(true);
    if (!before.updateAvailable) {
      return {
        updated: false,
        previousCommit: before.current.commit,
        currentCommit: before.current.commit,
        status: before,
      };
    }
    if (before.compatibilityChanged && !confirmCompatibilityChange) {
      throw new ProjectUpdateError(
        'compatibility_change',
        `Compatibility changes from ${before.current.compatibilityVersion} to ${before.available?.compatibilityVersion || 'unknown'}. Review the release requirements before continuing.`,
        before,
      );
    }
    if (!before.canUpdate || !before.upstream) {
      throw new ProjectUpdateError('update_blocked', before.message, before);
    }

    try {
      await runGit(
        this.projectRoot,
        ['merge', '--ff-only', before.upstream],
        60_000,
      );
    } catch {
      logger.error('control panel fast-forward update failed');
      throw new ProjectUpdateError(
        'update_failed',
        'The update could not be applied as a safe fast-forward.',
        before,
      );
    }

    const after = await this.getStatus(false);
    return {
      updated: before.current.commit !== after.current.commit,
      previousCommit: before.current.commit,
      currentCommit: after.current.commit,
      status: after,
    };
  }
}

export function scheduleProcessRestart(delayMs = 900): void {
  const timer = setTimeout(() => {
    logger.info('Process restart requested by control panel');
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch (error) {
      logger.warn({ err: error }, 'SIGTERM restart failed; exiting directly');
      process.exit(0);
    }
  }, delayMs);
  timer.unref?.();
}
