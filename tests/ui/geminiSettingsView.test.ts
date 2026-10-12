import { describe, expect, it } from 'vitest';
import { describeGeminiStatus, describeKeyCheck, describeSaveResult } from '../../src/ui/Settings/geminiSettingsView';

const status = (overrides: Partial<GeminiConfigStatusDto> = {}): GeminiConfigStatusDto => ({
  configured: false,
  source: null,
  hasStoredKey: false,
  storedKeyUnreadable: false,
  canStore: true,
  model: 'gemini-test',
  ...overrides,
});

describe('Gemini settings — what the card says', () => {
  it('no key: AI is off, why, and that the measured numbers still work', () => {
    const text = describeGeminiStatus(status());
    expect(text).toMatch(/^Off — no API key yet/);
    expect(text).toContain('measured numbers keep working');
  });

  it('says where a configured key comes from, and which one wins', () => {
    expect(describeGeminiStatus(status({ configured: true, source: 'stored', hasStoredKey: true }))).toMatch(/^On — using the key saved on this computer/);
    expect(describeGeminiStatus(status({ configured: true, source: 'environment' }))).toMatch(/GEMINI_API_KEY environment variable\.$/);
    expect(describeGeminiStatus(status({ configured: true, source: 'environment', hasStoredKey: true }))).toContain('takes precedence over the key saved here');
  });

  it('a saved key that cannot be read is not called "no key"', () => {
    expect(describeGeminiStatus(status({ storedKeyUnreadable: true }))).toContain('could not be read on this account');
  });

  it('tells a refused key, an unavailable model, a quota limit and an outage apart', () => {
    const texts = (['ok', 'invalid_api_key', 'model_unavailable', 'quota', 'network', 'api', 'unchecked'] as const).map((c) => describeKeyCheck(c, 'gemini-test'));
    expect(new Set(texts.map((t) => t.text)).size).toBe(texts.length);
    expect(describeKeyCheck('ok', 'gemini-test')).toMatchObject({ tone: 'ok' });
    expect(describeKeyCheck('invalid_api_key', 'gemini-test')).toMatchObject({ tone: 'error', text: expect.stringContaining('did not accept this key') });
    expect(describeKeyCheck('model_unavailable', 'gemini-test').text).toContain('gemini-test');
    for (const outage of ['network', 'api', 'quota'] as const) {
      expect(describeKeyCheck(outage, 'gemini-test').text).not.toMatch(/did not accept|not configured/);
    }
  });

  it('a refused key is reported as not saved; an unchecked one as saved but unchecked', () => {
    expect(describeSaveResult({ ok: false, status: status(), reason: 'invalid_api_key' })).toMatchObject({ tone: 'error', text: expect.stringContaining('was not saved') });
    const saved = status({ configured: true, source: 'stored', hasStoredKey: true });
    expect(describeSaveResult({ ok: true, status: saved, check: 'ok' })).toMatchObject({ tone: 'ok', text: expect.stringMatching(/^Key saved\. Gemini accepted it/) });
    expect(describeSaveResult({ ok: true, status: saved, check: 'network' })).toMatchObject({ tone: 'warn', text: expect.stringMatching(/^Key saved\. Gemini could not be reached/) });
    expect(describeSaveResult({ ok: false, status: status({ canStore: false }), reason: 'storage_unavailable' }).text).toContain('GEMINI_API_KEY');
  });
});
