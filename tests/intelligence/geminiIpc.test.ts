import { describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '../../src/intelligence/GeminiClient';
import { registerGeminiIpc, type GeminiIpcDeps } from '../../src/intelligence/geminiIpc';
import type { GeminiKeySource } from '../../src/intelligence/GeminiKeyStore';

const KEY = 'test-key-not-real-0123456789';
const BAD = 'test-key-rejected-0123456789';

/** An in-memory store with the real one's semantics that matter here. */
function fakeStore(initial: { env?: string; stored?: string; canStore?: boolean } = {}) {
  const state = { env: initial.env, stored: initial.stored ?? null as string | null, canStore: initial.canStore ?? true, failSave: false };
  const store: GeminiIpcDeps['store'] & { state: typeof state } = {
    state,
    getApiKey: () => state.env ?? state.stored ?? undefined,
    source: (): GeminiKeySource | null => (state.env ? 'environment' : state.stored ? 'stored' : null),
    hasStoredKey: () => state.stored !== null,
    storedKeyUnreadable: () => false,
    canStore: () => state.canStore,
    save: (key) => {
      if (state.failSave) throw new Error(`disk full while writing ${key}`);
      state.stored = key;
    },
    clear: () => {
      state.stored = null;
    },
  };
  return store;
}

/** The real client over a scripted provider: `BAD` is refused, everything else depends on `mode`. */
function setup(initial: Parameters<typeof fakeStore>[0] = {}, mode: { fail?: () => unknown } = {}) {
  const store = fakeStore(initial);
  const lookups: string[] = [];
  const gemini = new GeminiClient({
    getApiKey: () => store.getApiKey(),
    getModel: () => undefined,
    createTransport: (apiKey) => ({
      generateContent: async () => ({ text: '{}' }),
      getModel: async () => {
        lookups.push(apiKey);
        if (apiKey === BAD) {
          throw Object.assign(new Error(`{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}} key=${apiKey}`), { status: 400 });
        }
        if (mode.fail) throw mode.fail();
        return {};
      },
    }),
  });
  const lines: string[] = [];
  const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
  const handlers = new Map<string, (payload?: any) => any>();
  registerGeminiIpc({ store, gemini, logger }, (key, handler) => handlers.set(key, handler));
  const call = (channel: string, payload?: unknown) => handlers.get(channel)!(payload);
  return { store, handlers, call, lines, lookups, gemini };
}

describe('gemini IPC — surface', () => {
  it('registers a small, fixed set of channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(['gemini:clearKey', 'gemini:getStatus', 'gemini:openKeyPage', 'gemini:saveKey', 'gemini:test']);
  });

  it('opens the key page through the main process; the renderer cannot name an address', async () => {
    const opened: number[] = [];
    const handlers = new Map<string, (payload?: any) => any>();
    registerGeminiIpc({ store: fakeStore(), gemini: { model: 'm', verifyKey: async () => undefined }, openKeyPage: () => opened.push(1) }, (key, handler) =>
      handlers.set(key, handler),
    );
    expect(await handlers.get('gemini:openKeyPage')!({ url: 'https://evil.test' })).toBeUndefined();
    expect(opened).toEqual([1]);
  });

  it('reports a missing key as not configured — and how a key can be added', async () => {
    const t = setup();
    expect(await t.call('gemini:getStatus')).toEqual({
      configured: false,
      source: null,
      hasStoredKey: false,
      storedKeyUnreadable: false,
      canStore: true,
      model: t.gemini.model,
    });
  });

  it('reports where a configured key comes from', async () => {
    expect(await setup({ env: KEY }).call('gemini:getStatus')).toMatchObject({ configured: true, source: 'environment', hasStoredKey: false });
    expect(await setup({ stored: KEY }).call('gemini:getStatus')).toMatchObject({ configured: true, source: 'stored', hasStoredKey: true });
  });
});

describe('gemini IPC — saving a key', () => {
  it('a key Gemini accepts is saved and Gemini is configured', async () => {
    const t = setup();
    const result = await t.call('gemini:saveKey', { key: `  ${KEY}\n` });
    expect(result).toMatchObject({ ok: true, check: 'ok', status: { configured: true, source: 'stored', hasStoredKey: true } });
    expect(t.store.state.stored).toBe(KEY);
    expect(t.lookups).toEqual([KEY]);
  });

  it('a key Gemini refuses is not saved, and is reported as an invalid key — not as "not configured"', async () => {
    const t = setup();
    const result = await t.call('gemini:saveKey', { key: BAD });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_api_key', status: { configured: false } });
    expect(t.store.state.stored).toBeNull();
  });

  it('a refused key does not replace a working one', async () => {
    const t = setup({ stored: KEY });
    expect(await t.call('gemini:saveKey', { key: BAD })).toMatchObject({ ok: false, reason: 'invalid_api_key', status: { configured: true } });
    expect(t.store.state.stored).toBe(KEY);
  });

  it('a key that could not be checked is still saved, and says why it was not checked', async () => {
    const offline = setup({}, { fail: () => new TypeError('fetch failed') });
    expect(await offline.call('gemini:saveKey', { key: KEY })).toMatchObject({ ok: true, check: 'network', status: { configured: true } });

    const busy = setup({}, { fail: () => Object.assign(new Error('UNAVAILABLE'), { status: 503 }) });
    expect(await busy.call('gemini:saveKey', { key: KEY })).toMatchObject({ ok: true, check: 'api' });

    const limited = setup({}, { fail: () => Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }) });
    expect(await limited.call('gemini:saveKey', { key: KEY })).toMatchObject({ ok: true, check: 'quota' });
  });

  it('a model the key cannot use is reported as that, not as a bad key', async () => {
    const t = setup({}, { fail: () => Object.assign(new Error('models/gemini-x is not found for API version v1beta'), { status: 404 }) });
    expect(await t.call('gemini:saveKey', { key: KEY })).toMatchObject({ ok: true, check: 'model_unavailable', status: { configured: true } });
    expect(await t.call('gemini:test')).toMatchObject({ check: 'model_unavailable' });
  });

  it('refuses input that is not a key without asking Gemini', async () => {
    const t = setup();
    for (const payload of [undefined, {}, { key: 42 }, { key: '   ' }, { key: 'two words' }, { key: 'x'.repeat(600) }]) {
      expect(await t.call('gemini:saveKey', payload)).toMatchObject({ ok: false, reason: 'invalid_input' });
    }
    expect(t.lookups).toEqual([]);
    expect(t.store.state.stored).toBeNull();
  });

  it('says so when the key cannot be stored securely', async () => {
    const t = setup({ canStore: false });
    expect(await t.call('gemini:saveKey', { key: KEY })).toMatchObject({ ok: false, reason: 'storage_unavailable', status: { canStore: false } });
    expect(t.lookups).toEqual([]);

    const failing = setup();
    failing.store.state.failSave = true;
    expect(await failing.call('gemini:saveKey', { key: KEY })).toMatchObject({ ok: false, reason: 'storage_failed', status: { configured: false } });
  });
});

describe('gemini IPC — testing and removing', () => {
  it('tests the key in use', async () => {
    expect(await setup().call('gemini:test')).toMatchObject({ check: 'unchecked', status: { configured: false } });
    expect(await setup({ stored: KEY }).call('gemini:test')).toMatchObject({ check: 'ok' });
    expect(await setup({ env: BAD }).call('gemini:test')).toMatchObject({ check: 'invalid_api_key', status: { configured: true, source: 'environment' } });
    expect(await setup({ stored: KEY }, { fail: () => new TypeError('fetch failed') }).call('gemini:test')).toMatchObject({ check: 'network' });
  });

  it('removes the saved key', async () => {
    const t = setup({ stored: KEY });
    expect(await t.call('gemini:clearKey')).toMatchObject({ configured: false, source: null, hasStoredKey: false });
    expect(t.store.state.stored).toBeNull();
  });
});

describe('gemini IPC — the key never comes back', () => {
  it('no response and no log line contains a key, whatever happened', async () => {
    const answers: unknown[] = [];
    for (const t of [setup(), setup({ env: KEY }), setup({ stored: KEY }), setup({}, { fail: () => new Error(`request to https://example.test/?key=${KEY} failed`) })]) {
      answers.push(await t.call('gemini:getStatus'));
      answers.push(await t.call('gemini:saveKey', { key: KEY }));
      answers.push(await t.call('gemini:saveKey', { key: BAD }));
      answers.push(await t.call('gemini:test'));
      t.store.state.failSave = true;
      answers.push(await t.call('gemini:saveKey', { key: KEY }));
      answers.push(await t.call('gemini:clearKey'));
      answers.push(t.lines);
    }
    const everything = JSON.stringify(answers);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(BAD);
    expect(everything).not.toMatch(/test-key/);
  });

  it('the status has no field a key could travel in', async () => {
    const status = await setup({ stored: KEY }).call('gemini:getStatus');
    expect(Object.keys(status).sort()).toEqual(['canStore', 'configured', 'hasStoredKey', 'model', 'source', 'storedKeyUnreadable']);
  });
});

describe('gemini IPC — failures of the client itself', () => {
  it('an unexpected error from the check is reported as an API problem, not swallowed as success', async () => {
    const store = fakeStore();
    const handlers = new Map<string, (payload?: any) => any>();
    const verifyKey = vi.fn(async () => {
      throw new Error('boom');
    });
    registerGeminiIpc({ store, gemini: { model: 'm', verifyKey } }, (key, handler) => handlers.set(key, handler));
    expect(await handlers.get('gemini:saveKey')!({ key: KEY })).toMatchObject({ ok: true, check: 'api' });
  });
});
