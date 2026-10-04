import { execFile } from 'node:child_process';
import { BlockingError } from '../BlockingManager.js';
import type { HelperLauncher } from './HelperBlockingManager.js';
import { HELPER_FLAG } from './protocol.js';

export interface ElevatedLauncherOptions {
  /** The Reflect executable (`process.execPath`). */
  execPath: string;
  /**
   * Arguments that must precede the helper flags — in development the app
   * path Electron needs (`electron.exe <appPath>`); empty when packaged.
   */
  leadingArgs: string[];
  /** Carried across elevation as `--dev`; UAC does not forward env vars. */
  dev: boolean;
  /** How long the user has to answer the UAC prompt. */
  timeoutMs?: number;
}

/** Quote for a PowerShell single-quoted string. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Quote one argument for the Windows command line that `Start-Process`
 * builds (it joins `-ArgumentList` with spaces and does no quoting itself).
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.includes('"')) throw new Error('Helper arguments must not contain double quotes.');
  // A trailing backslash would escape the closing quote.
  return `"${arg.replace(/\\+$/, '')}"`;
}

/** The PowerShell script that starts the helper elevated. Exported for tests. */
export function buildElevationScript(execPath: string, args: string[]): string {
  const argumentList = args.map(quoteWindowsArg).join(' ');
  return (
    `$ErrorActionPreference = 'Stop'; ` +
    `Start-Process -FilePath ${psQuote(execPath)} -ArgumentList ${psQuote(argumentList)} -Verb RunAs -WindowStyle Hidden`
  );
}

/**
 * Launches the blocker helper with administrator rights via a UAC prompt
 * (`Start-Process -Verb RunAs`). Windows only.
 */
export function createElevatedLauncher(options: ElevatedLauncherOptions): HelperLauncher {
  return ({ pipePath, token }) => {
    const args = [
      ...options.leadingArgs,
      HELPER_FLAG,
      `--pipe=${pipePath}`,
      `--token=${token}`,
      ...(options.dev ? ['--dev'] : []),
    ];
    const script = buildElevationScript(options.execPath, args);
    // -EncodedCommand takes UTF-16LE base64 and sidesteps every layer of
    // command-line quoting between here and PowerShell.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    return new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: options.timeoutMs ?? 2 * 60_000 },
        (err, _stdout, stderr) => {
          if (!err) {
            resolve();
            return;
          }
          const detail = String(stderr || err.message || '');
          if (/cancell?ed by the user|operation was cancell?ed/i.test(detail)) {
            reject(new BlockingError('elevation-declined', 'Administrator permission was declined, so blocking could not be turned on.'));
          } else if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(new BlockingError('elevation-declined', 'The administrator prompt was not answered in time.'));
          } else {
            reject(new BlockingError('helper-unavailable', `Could not start the blocker: ${detail.trim().split(/\r?\n/)[0] || 'unknown error'}`));
          }
        },
      );
    });
  };
}
