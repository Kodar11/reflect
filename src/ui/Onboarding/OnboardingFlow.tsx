import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  PRESET_ROLES,
  PROFILE_LIMITS,
  statusAfterEdit,
  statusAfterSkip,
  type OnboardingStatus,
  type UserProfile,
} from '../../profile/UserProfile';
import {
  QUESTION_STEPS,
  TAG_LIMITS,
  draftFromProfile,
  draftToInput,
  nextStep,
  previousStep,
  stepNumber,
  toggleOther,
  toggleRole,
  type OnboardingDraft,
  type OnboardingStep,
  type TagField,
} from './onboardingDraft';
import { TagInput } from './TagInput';

const AUTOSAVE_DELAY_MS = 400;

const CONTEXT_EXAMPLES = [
  'My YouTube research is usually for my coursework.',
  'VS Code is sometimes used for personal projects.',
  'My freelance work and college work often happen in the same apps.',
  'ChatGPT is mostly for coding when I’m working.',
];

interface OnboardingFlowProps {
  /**
   * `onboarding`: first-run flow with welcome + completion screens.
   * `edit`: the same questions, opened from Settings → Personal context.
   */
  mode: 'onboarding' | 'edit';
  initialProfile: UserProfile;
  /** Called once the user leaves the flow, with the final stored profile. */
  onExit: (profile: UserProfile) => void;
}

/**
 * The onboarding / personal-context editor. Answers autosave as the user
 * types (debounced), so navigating back or quitting never loses input. No
 * field is required; "Set up later" is always available.
 */
export function OnboardingFlow({ mode, initialProfile, onExit }: OnboardingFlowProps) {
  const [draft, setDraft] = useState<OnboardingDraft>(() => draftFromProfile(initialProfile));
  const [step, setStep] = useState<OnboardingStep>(mode === 'edit' ? 'about' : 'welcome');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const statusRef = useRef<OnboardingStatus>(initialProfile.onboardingStatus);
  const latestProfile = useRef<UserProfile>(initialProfile);
  const draftRef = useRef(draft);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const headingRef = useRef<HTMLHeadingElement>(null);

  draftRef.current = draft;

  /** Serialize writes so an older autosave can never land after a newer one. */
  const persist = useCallback((patch: Parameters<Window['userProfile']['update']>[0]) => {
    const run = queue.current.then(async () => {
      try {
        latestProfile.current = await window.userProfile.update(patch);
        setSaveError(false);
      } catch (e) {
        console.error('[Onboarding] save failed', e);
        setSaveError(true);
      }
    });
    queue.current = run;
    return run;
  }, []);

  /** Write pending answers now (cancels the debounce). */
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return queue.current;
    dirty.current = false;
    statusRef.current = statusAfterEdit(statusRef.current);
    return persist({ ...draftToInput(draftRef.current), onboardingStatus: statusRef.current });
  }, [persist]);

  const update = useCallback((fn: (d: OnboardingDraft) => OnboardingDraft) => {
    setDraft(fn);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  }, [flush]);

  // Flush pending edits if the component unmounts unexpectedly.
  useEffect(() => () => void flush(), [flush]);

  // Move focus to the new screen's heading so keyboard / screen-reader users
  // land on the question.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const setStatus = async (status: OnboardingStatus) => {
    await flush();
    statusRef.current = status;
    await persist({ onboardingStatus: status });
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const goTo = (target: OnboardingStep) => {
    void flush();
    setStep(target);
  };

  const begin = () =>
    run(async () => {
      if (statusRef.current === 'not_started' || statusRef.current === 'skipped') {
        await setStatus('in_progress');
      }
      setStep('about');
    });

  const skip = () =>
    run(async () => {
      await setStatus(statusAfterSkip(statusRef.current));
      onExit(latestProfile.current);
    });

  const finish = () =>
    run(async () => {
      await setStatus('completed');
      if (mode === 'edit') onExit(latestProfile.current);
      else setStep('done');
    });

  const leave = () => onExit(latestProfile.current);

  const setTags = (field: TagField) => (tags: string[]) => update((d) => ({ ...d, [field]: tags }));

  const secondaryLabel = mode === 'edit' ? 'Close' : 'Set up later';
  const number = stepNumber(step);

  return (
    <div
      className="onb-root w-full"
      onKeyDown={(e) => {
        // Escape closes the editor from Settings. First-run onboarding never
        // dismisses on a stray keypress.
        if (e.key === 'Escape' && mode === 'edit' && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          void skip();
        }
      }}
    >
      <div className="w-full max-w-[580px] mx-auto">
        {number !== null && (
          <ProgressIndicator current={number} total={QUESTION_STEPS.length} />
        )}

        {step === 'welcome' && (
          <Screen
            key="welcome"
            headingRef={headingRef}
            title="Let’s help Reflect understand your time."
            subtitle="Tell us a little about what you do and what matters to you. Reflect uses this context to turn raw computer activity into a timeline that actually makes sense."
          >
            <p className="text-[13px] text-muted">
              Takes about a minute. Every question is optional.
            </p>
            <Actions
              primary={{ label: 'Get started', onClick: begin, disabled: busy }}
              secondary={{ label: 'Set up later', onClick: skip, disabled: busy }}
            />
            <PrivacyNote />
          </Screen>
        )}

        {step === 'about' && (
          <Screen
            key="about"
            headingRef={headingRef}
            title="What do you currently do?"
            subtitle="Choose what best describes your life right now."
          >
            <div role="group" aria-label="Roles" className="flex flex-wrap gap-2">
              {PRESET_ROLES.map((role) => (
                <button
                  key={role}
                  type="button"
                  className="onb-choice"
                  aria-pressed={draft.roles.includes(role)}
                  onClick={() => update((d) => toggleRole(d, role))}
                >
                  {role}
                </button>
              ))}
              <button
                type="button"
                className="onb-choice"
                aria-pressed={draft.otherSelected}
                onClick={() => update(toggleOther)}
              >
                Other
              </button>
            </div>

            {draft.otherSelected && (
              <div className="space-y-1.5">
                <label htmlFor="onb-other-role" className="block text-[13px] font-medium text-muted">
                  Your role
                </label>
                <input
                  id="onb-other-role"
                  type="text"
                  className="field w-full"
                  style={{ height: 38 }}
                  maxLength={PROFILE_LIMITS.roleLength * 2}
                  placeholder="e.g. Product manager, teacher, musician..."
                  value={draft.otherRole}
                  autoFocus
                  onChange={(e) => {
                    const otherRole = e.target.value;
                    update((d) => ({ ...d, otherRole }));
                  }}
                />
              </div>
            )}

            <TextArea
              id="onb-description"
              label="Tell us a little more"
              optional
              rows={3}
              maxLength={PROFILE_LIMITS.description}
              placeholder="e.g. I’m a final-year CS student building software projects and learning system design."
              value={draft.description}
              onChange={(description) => update((d) => ({ ...d, description }))}
            />

            <Actions
              primary={{ label: 'Continue', onClick: () => goTo(nextStep(step)), disabled: busy }}
              back={mode === 'onboarding' ? () => goTo(previousStep(step)) : undefined}
              secondary={{ label: secondaryLabel, onClick: skip, disabled: busy }}
            />
          </Screen>
        )}

        {step === 'life' && (
          <Screen
            key="life"
            headingRef={headingRef}
            title="What is your life focused on right now?"
            subtitle="These help Reflect understand what your activities are actually about."
          >
            <TagInput
              label="What are you currently working on?"
              placeholder="Add a project, course, job, or anything you're actively working on..."
              tags={draft.currentWork}
              max={TAG_LIMITS.currentWork}
              suggestions={['College studies', 'Freelance work', 'Startup', 'Exam preparation']}
              onChange={setTags('currentWork')}
            />
            <TagInput
              label="What matters most to you right now?"
              hint="Add the things you want your time to move forward."
              placeholder="e.g. Finish my degree, build my startup..."
              tags={draft.priorities}
              max={TAG_LIMITS.priorities}
              suggestions={['Finish my degree', 'Build my startup', 'Earn more', 'Improve fitness', 'Learn system design']}
              onChange={setTags('priorities')}
            />
            <TagInput
              label="What do you do outside work or study?"
              hint="Hobbies and personal interests help Reflect distinguish work from personal time."
              placeholder="e.g. gaming, reading, football, music..."
              tags={draft.interests}
              max={TAG_LIMITS.interests}
              suggestions={['Gaming', 'Reading', 'Football', 'Music', 'Travel', 'Personal projects']}
              onChange={setTags('interests')}
            />

            <Actions
              primary={{ label: 'Continue', onClick: () => goTo(nextStep(step)), disabled: busy }}
              back={() => goTo(previousStep(step))}
              secondary={{ label: secondaryLabel, onClick: skip, disabled: busy }}
            />
          </Screen>
        )}

        {step === 'context' && (
          <Screen
            key="context"
            headingRef={headingRef}
            title="Anything Reflect should know?"
            subtitle="Tell Reflect about anything that could make your activity look different from what it really is."
          >
            <TextArea
              id="onb-context"
              label="Things to keep in mind"
              optional
              rows={4}
              maxLength={PROFILE_LIMITS.additionalContext}
              placeholder="e.g. My Game Theory project is a hobby, not college work."
              value={draft.additionalContext}
              onChange={(additionalContext) => update((d) => ({ ...d, additionalContext }))}
            />
            <div className="text-[12.5px] text-faint space-y-1">
              <div>Other examples:</div>
              <ul className="space-y-0.5 pl-3">
                {CONTEXT_EXAMPLES.map((ex) => (
                  <li key={ex}>“{ex}”</li>
                ))}
              </ul>
            </div>

            <Actions
              primary={{ label: mode === 'edit' ? 'Save' : 'Finish', onClick: finish, disabled: busy }}
              back={() => goTo(previousStep(step))}
              secondary={{ label: secondaryLabel, onClick: skip, disabled: busy }}
            />
            <p className="text-[12.5px] text-muted">You can change this anytime in Settings.</p>
          </Screen>
        )}

        {step === 'done' && (
          <Screen
            key="done"
            headingRef={headingRef}
            title="You’re ready."
            subtitle="Reflect now has a little context about how you spend your time."
          >
            <Actions primary={{ label: 'Start using Reflect', onClick: leave }} />
            <p className="text-[12.5px] text-muted">You can change this anytime in Settings.</p>
          </Screen>
        )}

        {saveError && (
          <p role="alert" className="mt-4 text-[12.5px]" style={{ color: 'var(--danger)' }}>
            Couldn’t save your answers. They’ll be retried as you keep editing.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Layout pieces ─────────────────────────────────────────────────────────

function ProgressIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-3 mb-6" aria-label={`Step ${current} of ${total}`} role="group">
      <div className="flex gap-1.5" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="block h-1 rounded-full"
            style={{
              width: 28,
              background: i < current ? 'var(--accent)' : 'var(--border-strong)',
              transition: 'background-color var(--dur-normal) var(--ease-out)',
            }}
          />
        ))}
      </div>
      <span className="text-[12px] text-muted" aria-hidden="true">
        {current} of {total}
      </span>
    </div>
  );
}

function Screen(props: {
  title: string;
  subtitle: string;
  headingRef: RefObject<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <section className="onb-step space-y-6" aria-labelledby="onb-heading">
      <div className="space-y-2">
        <h1
          id="onb-heading"
          ref={props.headingRef}
          tabIndex={-1}
          className="text-[26px] font-extrabold tracking-tight leading-tight outline-none"
        >
          {props.title}
        </h1>
        <p className="text-[14.5px] text-muted leading-relaxed">{props.subtitle}</p>
      </div>
      {props.children}
    </section>
  );
}

function Actions(props: {
  primary: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: { label: string; onClick: () => void; disabled?: boolean };
  back?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      {props.back && (
        <button type="button" className="btn" onClick={props.back}>
          <ArrowLeft size={15} />
          Back
        </button>
      )}
      <button
        type="button"
        className="btn btn-primary"
        style={{ height: 38, padding: '0 18px' }}
        onClick={props.primary.onClick}
        disabled={props.primary.disabled}
      >
        {props.primary.label}
      </button>
      {props.secondary && (
        <button
          type="button"
          className="btn btn-ghost ml-auto"
          onClick={props.secondary.onClick}
          disabled={props.secondary.disabled}
        >
          {props.secondary.label}
        </button>
      )}
    </div>
  );
}

function TextArea(props: {
  id: string;
  label: string;
  optional?: boolean;
  rows: number;
  maxLength: number;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const remaining = props.maxLength - props.value.length;
  return (
    <div className="space-y-1.5">
      <label htmlFor={props.id} className="flex items-baseline gap-2 text-[14.5px] font-semibold">
        {props.label}
        {props.optional && <span className="text-[12px] font-normal text-faint">Optional</span>}
      </label>
      <textarea
        id={props.id}
        className="field w-full resize-none leading-relaxed"
        style={{ padding: '8px 10px' }}
        rows={props.rows}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        value={props.value}
        aria-describedby={`${props.id}-count`}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <div id={`${props.id}-count`} className="text-right text-[11.5px] text-faint">
        {remaining} characters left
      </div>
    </div>
  );
}

function PrivacyNote() {
  return (
    <p className="text-[12.5px] text-faint">
      Saved on this device and used to personalize how Reflect understands your activity.
    </p>
  );
}
