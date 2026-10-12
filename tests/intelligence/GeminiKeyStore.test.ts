import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiClient } from '../../src/intelligence/GeminiClient';
import { GeminiKeyStore, type KeyCipher } from '../../src/intelligence/GeminiKeyStore';

const KEY = 'test-key-not-real-0123456789';
const OTHER = 'test-key-not-real-9876543210';

/** Stands in for the OS: reversible, tagged, and nothing like the plain text. */
function fakeCipher(overrides: Partial<KeyCipher> = {}): KeyCipher {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('hex')}`, 'utf8'),
    decryptString: (encrypted) => {
      const raw = encrypted.toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('not decryptable');
      return Buffer.from(raw.slice(4), 'hex').toString('utf8');
    },
    ...overrides,
  };
}

const dirs: string[] = [];
function setup(options: { env?: string; cipher?: KeyCipher } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-gemini-key-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'profile', 'gemini-api-key.bin');
  const state = { env: options.env as string | undefined };
  const log = vi.fn<(message: string) => void>();
  const open = (cipher = options.cipher ?? fakeCipher()) => new GeminiKeyStore({ filePath, cipher, env: () => state.env, log });
  return { dir, filePath, state, log, open, store: open() };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GeminiKeyStore — where the key comes from', () => {
  it('no key anywhere: not configured, and nothing is written', () => {
    const t = setup();
    expect(t.store.getApiKey()).toBeUndefined();
    expect(t.store.source()).toBeNull();
    expect(t.store.hasStoredKey()).toBe(false);
    expect(t.store.storedKeyUnreadable()).toBe(false);
    expect(fs.existsSync(t.filePath)).toBe(false);
  });

  it('uses GEMINI_API_KEY from the environment, read at call time', () => {
    const t = setup({ env: `  ${KEY}  ` });
    expect(t.store.getApiKey()).toBe(KEY);
    expect(t.store.source()).toBe('environment');
    for (const blank of [undefined, '', '   ']) {
      t.state.env = blank;
      expect(t.store.source()).toBeNull();
    }
  });

  it('a saved key is used when the environment has none — the installed app', () => {
    const t = setup();
    t.store.save(` ${KEY}\n`);
    expect(t.store.getApiKey()).toBe(KEY);
    expect(t.store.source()).toBe('stored');
    // A new process (a restart) reads it back from disk.
    const restarted = t.open();
    expect(restarted.getApiKey()).toBe(KEY);
    expect(restarted.source()).toBe('stored');
  });

  it('the environment takes precedence over the saved key', () => {
    const t = setup({ env: OTHER });
    t.store.save(KEY);
    expect(t.store.getApiKey()).toBe(OTHER);
    expect(t.store.source()).toBe('environment');
    expect(t.store.hasStoredKey()).toBe(true);
    t.state.env = undefined;
    expect(t.store.getApiKey()).toBe(KEY);
  });

  it('reaches the Gemini client without a restart', async () => {
    const t = setup();
    const seen: string[] = [];
    const client = new GeminiClient({
      getApiKey: () => t.store.getApiKey(),
      createTransport: (apiKey) => {
        seen.push(apiKey);
        return { generateContent: async () => ({ text: '{}' }) };
      },
    });
    expect(client.isConfigured()).toBe(false);
    t.store.save(KEY);
    expect(client.isConfigured()).toBe(true);
    await client.generateJson({ systemInstruction: 's', prompt: 'p', responseJsonSchema: {} });
    expect(seen).toEqual([KEY]);
  });
});

describe('GeminiKeyStore — storage', () => {
  it('never writes the key in the clear', () => {
    const t = setup();
    t.store.save(KEY);
    const onDisk = fs.readFileSync(t.filePath);
    expect(onDisk.includes(Buffer.from(KEY))).toBe(false);
    // Nothing else is left behind in the profile directory.
    expect(fs.readdirSync(path.dirname(t.filePath))).toEqual(['gemini-api-key.bin']);
  });

  it('refuses to store anything when the OS offers no encryption', () => {
    const t = setup({ cipher: fakeCipher({ isEncryptionAvailable: () => false }) });
    expect(t.store.canStore()).toBe(false);
    expect(() => t.store.save(KEY)).toThrow(/Secure storage/);
    expect(fs.existsSync(t.filePath)).toBe(false);
    expect(t.store.source()).toBeNull();
  });

  it('refuses things that are not a key', () => {
    const t = setup();
    for (const bad of ['', '   ', 'two words', 'x'.repeat(600)]) expect(() => t.store.save(bad)).toThrow();
    expect(fs.existsSync(t.filePath)).toBe(false);
  });

  it('a key file that cannot be decrypted counts as no key, and says so without its contents', () => {
    const t = setup();
    t.store.save(KEY);
    fs.writeFileSync(t.filePath, 'garbage');
    const reopened = t.open();
    expect(reopened.getApiKey()).toBeUndefined();
    expect(reopened.source()).toBeNull();
    expect(reopened.storedKeyUnreadable()).toBe(true);
    expect(t.log).toHaveBeenCalledTimes(1);
    // Entering the key again recovers.
    reopened.save(OTHER);
    expect(reopened.getApiKey()).toBe(OTHER);
    expect(reopened.storedKeyUnreadable()).toBe(false);
  });

  it('removing the saved key leaves a key from the environment alone', () => {
    const t = setup({ env: OTHER });
    t.store.save(KEY);
    t.store.clear();
    expect(fs.existsSync(t.filePath)).toBe(false);
    expect(t.store.hasStoredKey()).toBe(false);
    expect(t.store.getApiKey()).toBe(OTHER);
    t.store.clear(); // Removing nothing is not an error.
  });

  it('announces a change, and a failing listener cannot undo it', () => {
    const t = setup();
    const changed = vi.fn();
    t.store.onChanged(() => {
      throw new Error('listener failed');
    });
    t.store.onChanged(changed);
    t.store.save(KEY);
    t.store.clear();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('never puts the key in a log line', () => {
    const t = setup();
    t.store.save(KEY);
    fs.writeFileSync(t.filePath, 'garbage');
    t.open().getApiKey();
    expect(JSON.stringify(t.log.mock.calls)).not.toContain(KEY);
  });
});
