import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * File-based logger shared by service + electron main. The format is one
 * JSON object per line ("JSONL") so the Debug tab can read+parse the tail
 * cheaply.
 *
 * The log file lives in the userData directory (the same place as
 * config.json). The service is configured at construction time with that
 * path because it can't call electron's `app.getPath('userData')` itself.
 */

export interface LoggerOpts {
  /** Directory to put the log file in (usually app.getPath('userData')). */
  dir: string;
  source: 'app' | 'service';
  /** Roll over after this many bytes; oldest is dropped. */
  maxBytes?: number;
}

export interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  source: 'app' | 'service';
  message: string;
}

const LOG_FILENAME = 'productivity-coach.log';

export class Logger {
  private readonly file: string;
  private readonly source: 'app' | 'service';
  private readonly maxBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: LoggerOpts) {
    fs.mkdirSync(opts.dir, { recursive: true });
    this.file = path.join(opts.dir, LOG_FILENAME);
    this.source = opts.source;
    this.maxBytes = opts.maxBytes ?? 1_000_000;
  }

  info(message: string) { this.write('info', message); }
  warn(message: string) { this.write('warn', message); }
  error(message: string) { this.write('error', message); }

  private write(level: LogEntry['level'], message: string) {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source: this.source,
      message,
    };
    const line = JSON.stringify(entry) + '\n';
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.maybeRollover();
        await fsp.appendFile(this.file, line, 'utf8');
      } catch {
        // Logging must never throw; we'd rather drop a line than crash.
      }
    });
  }

  /** Read the last `limit` log entries (most recent last). */
  async tail(limit: number): Promise<LogEntry[]> {
    try {
      const content = await fsp.readFile(this.file, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const slice = lines.slice(-limit);
      return slice
        .map((l) => {
          try { return JSON.parse(l) as LogEntry; } catch { return null; }
        })
        .filter((x): x is LogEntry => x !== null);
    } catch {
      return [];
    }
  }

  filePath(): string { return this.file; }

  private async maybeRollover() {
    try {
      const stat = await fsp.stat(this.file);
      if (stat.size < this.maxBytes) return;
      const archived = this.file + '.1';
      try { await fsp.unlink(archived); } catch {}
      await fsp.rename(this.file, archived);
    } catch {
      // file doesn't exist yet, fine
    }
  }
}
