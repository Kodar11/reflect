import { useEffect, useState, type FormEvent } from 'react';
import { GEMINI_KEY_URL, describeGeminiStatus, describeKeyCheck, describeSaveResult, type GeminiNotice } from './geminiSettingsView';

/**
 * The Gemini API key. The field is write-only: a key typed here is handed to
 * the main process — which checks it with Gemini and stores it encrypted —
 * and is then dropped from this page. What comes back is only where the key
 * in use comes from; the key itself is never shown again.
 */
export function GeminiSettings() {
  const [status, setStatus] = useState<GeminiConfigStatusDto | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<GeminiNotice | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.gemini
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => console.error('[gemini] failed to load the configuration'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return <div className="card" style={{ minHeight: 96 }} aria-busy="true" />;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch {
      setNotice({ tone: 'error', text: 'Something went wrong. Nothing was changed.' });
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    if (!value) return;
    void run(async () => {
      const result = await window.gemini.saveKey(value);
      setStatus(result.status);
      setNotice(describeSaveResult(result));
      if (result.ok) setKey('');
    });
  };

  const test = () =>
    run(async () => {
      const result = await window.gemini.test();
      setStatus(result.status);
      setNotice(describeKeyCheck(result.check, result.status.model));
    });

  const remove = () =>
    run(async () => {
      setStatus(await window.gemini.clearKey());
      setNotice({ tone: 'ok', text: 'The saved key was removed from this computer.' });
    });

  return (
    <div className="card">
      <div className="bg-row">
        <div className="text-[15px] font-semibold">Gemini API key</div>
        <p className="text-[13px] text-muted mt-0.5" role="status">
          {describeGeminiStatus(status)}
        </p>

        {status.canStore ? (
          <form className="flex flex-wrap items-center gap-2 mt-3" onSubmit={save}>
            <input
              type="password"
              className="field text-[13px]"
              style={{ flex: 1, minWidth: 240 }}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
              placeholder={status.hasStoredKey ? 'Paste a new key to replace the saved one' : 'Paste your Gemini API key'}
              aria-label="Gemini API key"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>
              {busy ? 'Checking…' : 'Save'}
            </button>
            {status.configured && (
              <button type="button" className="btn btn-ghost bg-control" disabled={busy} onClick={() => void test()}>
                Test
              </button>
            )}
            {status.hasStoredKey && (
              <button type="button" className="btn btn-ghost bg-control" disabled={busy} onClick={() => void remove()}>
                Remove
              </button>
            )}
          </form>
        ) : (
          <p className="text-[13px] text-muted mt-3">
            This computer offers no secure storage, so a key cannot be saved here. Set the GEMINI_API_KEY environment variable and restart Reflect.
          </p>
        )}

        {notice && (
          <p
            className="text-[13px] mt-2.5"
            role={notice.tone === 'error' ? 'alert' : 'status'}
            style={{ color: notice.tone === 'error' ? 'var(--danger)' : notice.tone === 'ok' ? 'var(--accent)' : 'var(--text-muted)' }}
          >
            {notice.text}
          </p>
        )}

        <p className="text-[12.5px] text-faint mt-3">
          Get a key at {GEMINI_KEY_URL}. It is stored only on this computer, encrypted by Windows for your account, and is sent only to Google. Model:{' '}
          {status.model}.
        </p>
      </div>
    </div>
  );
}
