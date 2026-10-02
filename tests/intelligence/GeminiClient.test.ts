import { describe, it, expect, vi } from 'vitest';
import { GEMINI_MODEL, GeminiClient, GeminiError, type GeminiTransport } from '../../src/intelligence/GeminiClient';

const request = { systemInstruction: 'You are Reflect', prompt: 'EVENTS …', responseJsonSchema: { type: 'object' } };
const KEY = 'test-key-not-real-0123456789';

function clientWith(generateContent: GeminiTransport['generateContent'], getApiKey: () => string | undefined = () => KEY) {
  const createTransport = vi.fn(() => ({ generateContent }));
  return { client: new GeminiClient({ getApiKey, createTransport }), createTransport };
}

async function errorOf(promise: Promise<unknown>): Promise<GeminiError> {
  try {
    await promise;
  } catch (e) {
    return e as GeminiError;
  }
  throw new Error('expected a rejection');
}

describe('GeminiClient', () => {
  it('requests structured JSON with an explicit schema through the single model constant', async () => {
    const generateContent = vi.fn(async () => ({ text: '{"ok":true}', modelVersion: 'gemini-x-001' }));
    const { client } = clientWith(generateContent);

    const response = await client.generateJson(request);

    expect(response).toEqual({ text: '{"ok":true}', modelVersion: 'gemini-x-001' });
    expect(generateContent).toHaveBeenCalledWith({
      model: GEMINI_MODEL,
      contents: 'EVENTS …',
      config: {
        systemInstruction: 'You are Reflect',
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        temperature: 0.2,
      },
    });
    expect(client.model).toBe(GEMINI_MODEL);
  });

  it('missing API key: not configured, clear error, no request made', async () => {
    for (const key of [undefined, '', '   ']) {
      const generateContent = vi.fn();
      const { client, createTransport } = clientWith(generateContent, () => key);

      expect(client.isConfigured()).toBe(false);
      const err = await errorOf(client.generateJson(request));
      expect(err).toBeInstanceOf(GeminiError);
      expect(err).toMatchObject({ category: 'missing_api_key', retryable: false });
      expect(createTransport).not.toHaveBeenCalled();
    }
  });

  it('reads the key lazily, so configuring it later needs no restart', async () => {
    let key: string | undefined;
    const client = new GeminiClient({
      getApiKey: () => key,
      createTransport: () => ({ generateContent: async () => ({ text: '{}' }) }),
    });
    expect(client.isConfigured()).toBe(false);
    key = KEY;
    expect(client.isConfigured()).toBe(true);
    expect((await client.generateJson(request)).modelVersion).toBe(GEMINI_MODEL);
  });

  it('differentiates quota, API and network failures', async () => {
    const failing = (err: unknown) => clientWith(async () => { throw err; }).client.generateJson(request);
    const http = (status: number, message: string) => Object.assign(new Error(message), { status });

    expect(await errorOf(failing(http(429, 'RESOURCE_EXHAUSTED')))).toMatchObject({ category: 'quota', retryable: true, status: 429 });
    expect(await errorOf(failing(http(503, 'UNAVAILABLE')))).toMatchObject({ category: 'api', retryable: true });
    expect(await errorOf(failing(http(400, 'INVALID_ARGUMENT')))).toMatchObject({ category: 'api', retryable: false });
    expect(await errorOf(failing(http(403, 'PERMISSION_DENIED')))).toMatchObject({ category: 'api', retryable: false });
    expect(await errorOf(failing(new TypeError('fetch failed')))).toMatchObject({ category: 'network', retryable: true });
  });

  it('an empty response is malformed output', async () => {
    const { client } = clientWith(async () => ({ text: '  ' }));
    expect(await errorOf(client.generateJson(request))).toMatchObject({ category: 'malformed_output', retryable: true });
  });

  it('never leaks the API key through an error message', async () => {
    const { client } = clientWith(async () => {
      throw new Error(`request to https://example.test/v1?key=${KEY} failed`);
    });
    const err = await errorOf(client.generateJson(request));
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[REDACTED]');
  });
});
