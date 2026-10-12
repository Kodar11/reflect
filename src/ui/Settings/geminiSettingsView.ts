/**
 * What the Gemini card in Settings says. Pure: the main process reports fixed
 * values, the wording lives here — so no provider message, and nothing that
 * could carry a key, is ever shown.
 */

export const GEMINI_KEY_URL = 'aistudio.google.com/apikey';

export interface GeminiNotice {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

/** The one-line state of the configuration. */
export function describeGeminiStatus(status: GeminiConfigStatusDto): string {
  if (status.source === 'environment') {
    return status.hasStoredKey
      ? 'On — using the key from the GEMINI_API_KEY environment variable. It takes precedence over the key saved here.'
      : 'On — using the key from the GEMINI_API_KEY environment variable.';
  }
  if (status.source === 'stored') return 'On — using the key saved on this computer. It is encrypted for your Windows account.';
  if (status.storedKeyUnreadable) return 'Off — the saved key could not be read on this account. Enter it again.';
  return 'Off — no API key yet. Reflections, the Coach and the AI timeline are unavailable; tracking and the measured numbers keep working.';
}

/** What a check of the key against Gemini means, in the user's terms. */
export function describeKeyCheck(check: GeminiKeyCheckDto, model: string): GeminiNotice {
  switch (check) {
    case 'ok':
      return { tone: 'ok', text: `Gemini accepted the key and the model (${model}).` };
    case 'invalid_api_key':
      return { tone: 'error', text: 'Gemini did not accept this key. Check that it was copied completely and has not been revoked or restricted.' };
    case 'model_unavailable':
      return { tone: 'warn', text: `The key works, but the model ${model} is not available for it. Reflect cannot write reflections until the model is changed (GEMINI_MODEL).` };
    case 'quota':
      return { tone: 'warn', text: 'Gemini accepted the request but the quota for this key is exhausted for now.' };
    case 'network':
      return { tone: 'warn', text: 'Gemini could not be reached, so the key could not be checked. Check your connection.' };
    case 'api':
      return { tone: 'warn', text: 'Gemini returned an error, so the key could not be checked. Try again in a moment.' };
    case 'unchecked':
      return { tone: 'warn', text: 'There is no key to check yet.' };
  }
}

/** What to say after "Save". */
export function describeSaveResult(result: GeminiSaveKeyResultDto): GeminiNotice {
  if (result.ok) {
    if (result.check === 'ok') return { tone: 'ok', text: 'Key saved. Gemini accepted it — Reflect is catching up on what it could not write before.' };
    const checked = describeKeyCheck(result.check, result.status.model);
    return { tone: 'warn', text: `Key saved. ${checked.text}` };
  }
  switch (result.reason) {
    case 'invalid_api_key':
      return { tone: 'error', text: 'Gemini did not accept this key, so it was not saved. Check that it was copied completely and has not been revoked or restricted.' };
    case 'invalid_input':
      return { tone: 'error', text: 'That does not look like an API key. Paste the key exactly as Google AI Studio shows it.' };
    case 'storage_unavailable':
      return { tone: 'error', text: 'This computer offers no secure storage, so the key was not saved. Set the GEMINI_API_KEY environment variable instead.' };
    case 'storage_failed':
      return { tone: 'error', text: 'The key could not be saved. Nothing was changed.' };
  }
}
