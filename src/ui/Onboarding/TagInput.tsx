import { useId, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { PROFILE_LIMITS, hasTag } from '../../profile/UserProfile';
import { addTag, removeTag } from './onboardingDraft';

interface TagInputProps {
  /** Accessible name. Rendered visibly unless `hideLabel` (the screen heading
   * already asks the question). */
  label: string;
  hideLabel?: boolean;
  hint?: string;
  placeholder: string;
  tags: string[];
  max: number;
  /** Example tags offered as one-click additions. Never added automatically. */
  suggestions?: string[];
  onChange: (tags: string[]) => void;
}

/**
 * Lightweight tag/chip input: Enter or comma adds, Backspace on an empty
 * input removes the last tag, Escape clears the pending text. Duplicates
 * (case-insensitive) and empty tags are ignored. Enter on an empty input is
 * left alone so the surrounding flow can treat it as "continue".
 */
export function TagInput({ label, hideLabel, hint, placeholder, tags, max, suggestions = [], onChange }: TagInputProps) {
  const inputId = useId();
  const hintId = useId();
  const statusId = useId();
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');

  const full = tags.length >= max;

  const commit = (value: string) => {
    const { tags: next, result } = addTag(tags, value, max);
    if (result === 'added') {
      onChange(next);
      setText('');
      setMessage('');
    } else if (result === 'duplicate') {
      setText('');
      setMessage('Already added.');
    } else if (result === 'full') {
      setMessage(`You can add up to ${max}.`);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ',' || (e.key === 'Enter' && text.trim() !== '')) {
      e.preventDefault();
      commit(text);
    } else if (e.key === 'Backspace' && text === '' && tags.length > 0) {
      e.preventDefault();
      onChange(tags.slice(0, -1));
    } else if (e.key === 'Escape' && text !== '') {
      e.preventDefault();
      e.stopPropagation();
      setText('');
      setMessage('');
    }
  };

  const remaining = suggestions.filter((s) => !hasTag(tags, s));

  return (
    <div className="space-y-3">
      <div className={hideLabel && !hint ? 'sr-only' : undefined}>
        <label htmlFor={inputId} className={hideLabel ? 'sr-only' : 'block text-[14.5px] font-semibold'}>
          {label}
        </label>
        {hint && (
          <p id={hintId} className="text-[13px] text-muted mt-0.5">
            {hint}
          </p>
        )}
      </div>

      <div
        className="field onb-tagfield flex flex-wrap items-center gap-1.5 cursor-text"
        onClick={(e) => {
          if (e.target === e.currentTarget) document.getElementById(inputId)?.focus();
        }}
      >
        {tags.map((tag) => (
          <span key={tag} className="chip onb-tag">
            {tag}
            <button
              type="button"
              className="onb-tag-remove inline-flex items-center justify-center rounded-full"
              style={{ width: 18, height: 18 }}
              aria-label={`Remove ${tag}`}
              onClick={() => onChange(removeTag(tags, tag))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          type="text"
          data-onb-autofocus
          value={text}
          disabled={full}
          maxLength={PROFILE_LIMITS.tagLength}
          placeholder={full ? `Limit of ${max} reached` : tags.length ? 'Add another…' : placeholder}
          aria-describedby={[hint ? hintId : null, statusId].filter(Boolean).join(' ')}
          onChange={(e) => {
            setText(e.target.value);
            if (message) setMessage('');
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (text.trim()) commit(text);
          }}
          className="flex-1 bg-transparent outline-none text-[15px] py-1 px-1"
          style={{ minWidth: 180, border: 0 }}
        />
      </div>

      <div className="flex items-center justify-between gap-3 text-[12px] text-faint">
        <span id={statusId} aria-live="polite" className="text-muted">
          {message}
        </span>
        <span aria-hidden="true">
          {tags.length} of {max}
        </span>
      </div>

      {remaining.length > 0 && !full && (
        <div className="space-y-2" aria-label={`Suggestions for ${label}`} role="group">
          <div className="text-[12px] text-faint">Or pick a few</div>
          <div className="flex flex-wrap gap-1.5">
            {remaining.map((s) => (
              <button
                key={s}
                type="button"
                className="onb-suggestion chip"
                aria-label={`Add ${s}`}
                onClick={() => commit(s)}
              >
                <Plus size={12} />
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
