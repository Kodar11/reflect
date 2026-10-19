import { GeminiError, type GeminiErrorCategory } from './GeminiClient.js';
import type { GeminiKeySource, GeminiKeyStore } from './GeminiKeyStore.js';

/**
 * Renderer bridge for the Gemini configuration (Settings).
 *
 * The key travels one way only: from the Settings field into the main
 * process. Nothing here ever returns it, any part of it, or a provider
 * message that could contain it — every answer is a status made of fixed
 * values, and the wording is the renderer's.
 */

/** What Settings is told about the configuration. Contains no secret. */
export interface GeminiConfigStatus {
  configured: boolean;
  /** Where the key in use comes from; `null` when there is none. */
  source: GeminiKeySource | null;
  /** A key saved in Settings exists (it is not in use while the environment supplies one). */
  hasStoredKey: boolean;
  /** A saved key exists but cannot be decrypted on this account. */
  storedKeyUnreadable: boolean;
  /** False when the operating system offers no encryption: a key cannot be saved here. */
  canStore: boolean;
  /** The model requests are sent to. */
  model: string;
}

/** What a check of the key against Gemini found. `unchecked` = there was nothing to ask. */
export type GeminiKeyCheck = 'ok' | 'unchecked' | Exclude<GeminiErrorCategory, 'missing_api_key' | 'malformed_output'>;

export type GeminiSaveKeyResult =
  | { ok: true; status: GeminiConfigStatus; check: GeminiKeyCheck }
  | { ok: false; status: GeminiConfigStatus; reason: 'invalid_input' | 'invalid_api_key' | 'storage_unavailable' | 'storage_failed' };

export interface GeminiIpcDeps {
  store: Pick<GeminiKeyStore, 'getApiKey' | 'source' | 'hasStoredKey' | 'storedKeyUnreadable' | 'canStore' | 'save' | 'clear'>;
  gemini: { readonly model: string; verifyKey(apiKey: string): Promise<void> };
  logger?: { info(message: string): void; warn(message: string): void };
  /** Opens Google's API-key page in the user's browser. The address is fixed in the main process. */
  openKeyPage?: () => void;
}

export function geminiConfigStatus(deps: Pick<GeminiIpcDeps, 'store' | 'gemini'>): GeminiConfigStatus {
  const source = deps.store.source();
  return {
    configured: source !== null,
    source,
    hasStoredKey: deps.store.hasStoredKey(),
    storedKeyUnreadable: deps.store.storedKeyUnreadable(),
    canStore: deps.store.canStore(),
    model: deps.gemini.model,
  };
}

async function check(deps: GeminiIpcDeps, key: string): Promise<GeminiKeyCheck> {
  try {
    await deps.gemini.verifyKey(key);
    return 'ok';
  } catch (err) {
    if (!(err instanceof GeminiError) || err.category === 'missing_api_key' || err.category === 'malformed_output') return 'api';
    return err.category;
  }
}

export function registerGeminiIpc(deps: GeminiIpcDeps, ipcMainHandle: (key: string, handler: (payload?: any) => any) => void): void {
  const status = () => geminiConfigStatus(deps);

  ipcMainHandle('gemini:getStatus', () => status());

  ipcMainHandle('gemini:openKeyPage', () => {
    deps.openKeyPage?.();
  });

  /**
   * Save a key entered in Settings. Gemini is asked about it first: a key it
   * refuses is not stored. A key that could not be checked (offline, an
   * outage) is stored, and the result says it was not checked.
   */
  ipcMainHandle('gemini:saveKey', async (p?: { key?: unknown }): Promise<GeminiSaveKeyResult> => {
    const key = typeof p?.key === 'string' ? p.key.trim() : '';
    if (!key || key.length > 512 || /\s/.test(key)) return { ok: false, status: status(), reason: 'invalid_input' };
    if (!deps.store.canStore()) return { ok: false, status: status(), reason: 'storage_unavailable' };

    const result = await check(deps, key);
    if (result === 'invalid_api_key') {
      deps.logger?.warn('[GEMINI] The entered API key was refused by Gemini and was not saved.');
      return { ok: false, status: status(), reason: 'invalid_api_key' };
    }
    try {
      deps.store.save(key);
    } catch {
      deps.logger?.warn('[GEMINI] The API key could not be saved to secure storage.');
      return { ok: false, status: status(), reason: 'storage_failed' };
    }
    deps.logger?.info(`[GEMINI] API key saved to secure storage (check: ${result}).`);
    return { ok: true, status: status(), check: result };
  });

  /** Forget the key saved in Settings. */
  ipcMainHandle('gemini:clearKey', (): GeminiConfigStatus => {
    deps.store.clear();
    deps.logger?.info('[GEMINI] Saved API key removed.');
    return status();
  });

  /** Ask Gemini about the key in use — "is it the key, the model, or the network?". Generates nothing. */
  ipcMainHandle('gemini:test', async (): Promise<{ status: GeminiConfigStatus; check: GeminiKeyCheck }> => {
    const key = deps.store.getApiKey();
    return { status: status(), check: key ? await check(deps, key) : 'unchecked' };
  });
}
