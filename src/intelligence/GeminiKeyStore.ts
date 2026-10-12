import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the Gemini API key comes from. Main process only.
 *
 * Two sources, in this order:
 *   1. the `GEMINI_API_KEY` environment variable (in development also read
 *      from the git-ignored `.env`) — the developer's explicit override;
 *   2. a key the user saved in Settings, kept in the profile directory
 *      encrypted by the operating system (Electron `safeStorage`: DPAPI on
 *      Windows, so only this Windows account can read it back).
 *
 * The key is never written in the clear, never put in SQLite, never logged,
 * and nothing here is reachable from a renderer except through `geminiIpc`,
 * which reports where the key comes from — not the key.
 */

/** The slice of Electron's `safeStorage` this module uses — the seam for tests. */
export interface KeyCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type GeminiKeySource = 'environment' | 'stored';

export interface GeminiKeyStoreOptions {
  /** The encrypted key file, inside the profile directory. */
  filePath: string;
  cipher: KeyCipher;
  /** Defaults to `process.env.GEMINI_API_KEY`, read at call time. */
  env?: () => string | undefined;
  /** Told that something went wrong — never what the key is. */
  log?: (message: string) => void;
}

/** Longer than any real key; a paste of something else is refused, not stored. */
const MAX_KEY_LENGTH = 512;

export class GeminiKeyStore {
  private readonly filePath: string;
  private readonly cipher: KeyCipher;
  private readonly env: () => string | undefined;
  private readonly log: (message: string) => void;
  /** `undefined` = the file has not been read yet. */
  private stored: string | null | undefined = undefined;
  private unreadable = false;
  private readonly listeners = new Set<() => void>();

  constructor(options: GeminiKeyStoreOptions) {
    this.filePath = options.filePath;
    this.cipher = options.cipher;
    this.env = options.env ?? (() => process.env.GEMINI_API_KEY);
    this.log = options.log ?? (() => {});
  }

  /** The key requests are made with; `undefined` when none is configured. */
  getApiKey(): string | undefined {
    return this.fromEnv() ?? this.readStored() ?? undefined;
  }

  /** Where the key in use comes from; `null` when there is none. */
  source(): GeminiKeySource | null {
    if (this.fromEnv()) return 'environment';
    return this.readStored() ? 'stored' : null;
  }

  /** Can a key be saved on this machine? False when the OS offers no encryption. */
  canStore(): boolean {
    try {
      return this.cipher.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  hasStoredKey(): boolean {
    return this.readStored() !== null;
  }

  /** A key file exists but could not be decrypted (another account, a damaged file). */
  storedKeyUnreadable(): boolean {
    this.readStored();
    return this.unreadable;
  }

  /** Encrypt and save `key`. Throws when it cannot be stored safely — it is then not stored at all. */
  save(key: string): void {
    const value = key.trim();
    if (!value || value.length > MAX_KEY_LENGTH || /\s/.test(value)) throw new Error('Not a valid API key');
    if (!this.canStore()) throw new Error('Secure storage is not available on this system');
    const encrypted = this.cipher.encryptString(value);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Written beside the target and moved into place, so a crash never leaves half a file.
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, encrypted, { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    this.stored = value;
    this.unreadable = false;
    this.notify();
  }

  /** Forget the saved key. A key from the environment is not this store's to remove. */
  clear(): void {
    fs.rmSync(this.filePath, { force: true });
    this.stored = null;
    this.unreadable = false;
    this.notify();
  }

  /** Called after the saved key was added, replaced or removed. */
  onChanged(listener: () => void): void {
    this.listeners.add(listener);
  }

  private fromEnv(): string | null {
    return this.env()?.trim() || null;
  }

  private readStored(): string | null {
    if (this.stored !== undefined) return this.stored;
    this.stored = null;
    this.unreadable = false;
    let encrypted: Buffer;
    try {
      encrypted = fs.readFileSync(this.filePath);
    } catch {
      return null; // No saved key.
    }
    try {
      this.stored = this.cipher.decryptString(encrypted).trim() || null;
    } catch {
      this.stored = null;
    }
    if (this.stored === null) {
      this.unreadable = true;
      this.log('[GEMINI] The saved API key could not be read on this account; it needs to be entered again.');
    }
    return this.stored;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener must never undo a saved key.
      }
    }
  }
}
