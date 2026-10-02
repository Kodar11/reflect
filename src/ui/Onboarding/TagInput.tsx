import { useId, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { PROFILE_LIMITS, hasTag } from '../../profile/UserProfile';
import { addTag, removeTag } from './onboardingDraft';

interface TagInputProps {
  label: string;
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
 * (case-insensitive) and empty tags are ignored.
 */
export function TagInput({ label, hint, placeholder, tags, max, suggestions = [], onChange }: TagInputProps) {
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
    if (e.key === 'Enter' || e.key === ',') {
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
    <div className="space-y-2">
      <div>
        <label htmlFor={inputId} className="block text-[14.5px] font-semibold">
          {label}
        </label>
        {hint && (
          <p id={hintId} className="text-[13px] text-muted mt-0.5">
            {hint}
          </p>
        )}
      </div>

      <div
        className="field flex flex-wrap items-center gap-1.5 cursor-text"
        style={{ minHeight: 40, padding: '5px 8px' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) document.getElementById(inputId)?.focus();
        }}
      >
        {tags.map((tag) => (
          <span key={tag} className="chip" style={{ fontSize: 13, paddingRight: 4 }}>
            {tag}
            <button
              type="button"
              className="onb-tag-remove inline-flex items-center justify-center rounded-full"
              style={{ width: 18, height: 18, color: 'var(--text-muted)' }}
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
          className="flex-1 bg-transparent outline-none text-[14px] py-1 px-1"
          style={{ minWidth: 160, border: 0 }}
        />
      </div>

      <div id={statusId} aria-live="polite" className="text-[12px] text-muted empty:hidden">
        {message}
      </div>

      {remaining.length > 0 && !full && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={`Suggestions for ${label}`} role="group">
          <span className="text-[12px] text-faint mr-0.5">e.g.</span>
          {remaining.map((s) => (
            <button
              key={s}
              type="button"
              className="onb-suggestion chip"
              style={{ fontSize: 12.5, background: 'transparent', borderStyle: 'dashed', color: 'var(--text-muted)' }}
              aria-label={`Add ${s}`}
              onClick={() => commit(s)}
            >
              <Plus size={11} />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
