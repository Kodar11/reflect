import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { GEMINI_KEY_URL, describeGeminiBadge, describeGeminiStatus, describeKeyCheck, describeSaveResult, type GeminiNotice } from './geminiSettingsView';

/**
 * The Gemini API key. The field is write-only: a key typed here is handed to
 * the main process — which checks it with Gemini and stores it encrypted —
 * and is then dropped from this page. What comes back is only where the key
 * in use comes from; the key itself is never shown again.
 */

export type GeminiBusy = 'save' | 'test' | 'remove' | null;

export interface GeminiSettingsViewProps {
  status: GeminiConfigStatusDto;
  keyInput: string;
  busy: GeminiBusy;
  notice: GeminiNotice | null;
  onKeyInput: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
  onRemove: () => void;
  onOpenKeyPage: () => void;
}

export function GeminiSettingsView({ status, keyInput, busy, notice, onKeyInput, onSave, onTest, onRemove, onOpenKeyPage }: GeminiSettingsViewProps) {
  const badge = describeGeminiBadge(status);
  const working = busy !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (keyInput.trim()) onSave();
  };

  return (
    <div className="card">
      <div className="bg-row">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-semibold">API key</span>
            <span className="settings-badge" data-tone={badge.tone}>
              {badge.label}
            </span>
          </div>
          {status.configured && (
            <button type="button" className="btn btn-ghost bg-control" disabled={working} onClick={onTest}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
          )}
        </div>
        <p className="text-[13px] text-muted mt-1" role="status">
          {describeGeminiStatus(status)}
        </p>

        {status.canStore ? (
          <form className="flex flex-wrap items-center gap-2 mt-3" onSubmit={submit}>
            <input
              type="password"
              className="field text-[13px]"
              style={{ flex: 1, minWidth: 220 }}
              value={keyInput}
              onChange={(e) => onKeyInput(e.currentTarget.value)}
              placeholder={status.hasStoredKey ? 'Paste a new key to replace the saved one' : 'Paste your Gemini API key'}
              aria-label="Gemini API key"
              autoComplete="off"
              spellCheck={false}
              disabled={working}
            />
            <button type="submit" className="btn btn-primary" disabled={working || !keyInput.trim()}>
              {busy === 'save' ? 'Checking…' : status.hasStoredKey ? 'Replace key' : 'Save key'}
            </button>
            {status.hasStoredKey && (
              <button type="button" className="btn btn-ghost bg-control" disabled={working} onClick={onRemove}>
                {busy === 'remove' ? 'Removing…' : 'Remove saved key'}
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
            className="settings-notice mt-2.5"
            data-tone={notice.tone}
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            {notice.text}
          </p>
        )}
      </div>

      <div className="bg-row">
        <dl className="settings-facts">
          <dt>Model</dt>
          <dd>
            <code>{status.model}</code>
          </dd>
          <dt>Stored</dt>
          <dd>Only on this computer, encrypted by Windows for your account. Never shown again, never logged.</dd>
          <dt>Sent to</dt>
          <dd>Google Gemini, and nowhere else. Tracking and measured numbers work without a key.</dd>
        </dl>
        <button type="button" className="settings-link mt-2" onClick={onOpenKeyPage}>
          Get a key at {GEMINI_KEY_URL} <ExternalLink size={12} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function GeminiSettings() {
  const [status, setStatus] = useState<GeminiConfigStatusDto | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<GeminiBusy>(null);
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

  if (!status) return <div className="card" style={{ minHeight: 160 }} aria-busy="true" />;

  const run = async (action: Exclude<GeminiBusy, null>, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    setNotice(null);
    try {
      await fn();
    } catch {
      setNotice({ tone: 'error', text: 'Something went wrong. Nothing was changed.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <GeminiSettingsView
      status={status}
      keyInput={key}
      busy={busy}
      notice={notice}
      onKeyInput={setKey}
      onSave={() =>
        void run('save', async () => {
          const result = await window.gemini.saveKey(key.trim());
          setStatus(result.status);
          setNotice(describeSaveResult(result));
          if (result.ok) setKey('');
        })
      }
      onTest={() =>
        void run('test', async () => {
          const result = await window.gemini.test();
          setStatus(result.status);
          setNotice(describeKeyCheck(result.check, result.status.model));
        })
      }
      onRemove={() =>
        void run('remove', async () => {
          setStatus(await window.gemini.clearKey());
          setNotice({ tone: 'ok', text: 'The saved key was removed from this computer.' });
        })
      }
      onOpenKeyPage={() => void window.gemini.openKeyPage().catch(() => undefined)}
    />
  );
}
