import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  Clapperboard,
  Clock,
  Code,
  EyeOff,
  Eye,
  FlaskConical,
  GraduationCap,
  Palette,
  Plus,
  Rocket,
  Sparkles,
  Target,
  type LucideIcon,
} from 'lucide-react';
import {
  PRESET_ROLES,
  PROFILE_LIMITS,
  hasProfileContent,
  statusAfterEdit,
  statusAfterSkip,
  type OnboardingStatus,
  type PresetRole,
  type UserProfile,
  type UserProfileInput,
} from '../../profile/UserProfile';
import {
  QUESTION_STEPS,
  STEP_ORDER,
  TAG_LIMITS,
  draftFromProfile,
  draftToInput,
  isQuestionStep,
  nextStep,
  previousStep,
  stepNumber,
  toggleOther,
  toggleRole,
  type OnboardingDraft,
  type OnboardingStep,
  type QuestionStep,
  type TagField,
} from './onboardingDraft';
import { TagInput } from './TagInput';
import { BackgroundControls } from '../Settings/BackgroundControls';

const AUTOSAVE_DELAY_MS = 400;

const ROLE_ICONS: Record<PresetRole, LucideIcon> = {
  Student: GraduationCap,
  'Software Developer': Code,
  Designer: Palette,
  Freelancer: Briefcase,
  Founder: Rocket,
  Researcher: FlaskConical,
  Creator: Clapperboard,
};

const CONTEXT_EXAMPLES = [
  'My YouTube research is usually for my coursework.',
  'VS Code is sometimes used for personal projects.',
  'My freelance work and college work often happen in the same apps.',
  'ChatGPT is mostly for coding when I’m working.',
];

const TOUR_POINTS: { Icon: LucideIcon; title: string; body: string }[] = [
  {
    Icon: Activity,
    title: 'It runs quietly in the background',
    body: 'Reflect notes the app, window title and website you have in front of you. There is nothing to start or stop, and no window to keep open.',
  },
  {
    Icon: Clock,
    title: 'Your day becomes a timeline',
    body: 'Open Timeline to see what you were actually doing. Correct anything that looks wrong — your edits always win.',
  },
  {
    Icon: Target,
    title: 'Focus when it counts',
    body: 'Start a Focus session for a task and see afterwards how that time really went.',
  },
  {
    Icon: Sparkles,
    title: 'Your answers make it personal',
    body: 'Five short questions tell Reflect who you are, so a hobby is not mistaken for work.',
  },
];

/** What tracking records — and, as plainly, what it has no way of knowing. */
const OBSERVED = [
  'The app and window title in front of you',
  'The website you are on (its domain, not the page)',
  'When, and for how long',
  'Your Focus sessions',
];

const NOT_OBSERVED = [
  'Anything you do away from this computer',
  'What you were thinking, or meant to do',
  'Anything you have not told it',
  'What is inside your documents and pages',
];

interface OnboardingFlowProps {
  /**
   * `onboarding`: first-run flow with welcome, tour and completion screens.
   * `edit`: the same questions, opened from Settings → Personal context.
   */
  mode: 'onboarding' | 'edit';
  initialProfile: UserProfile;
  /** Called once the user leaves the flow, with the final stored profile. */
  onExit: (profile: UserProfile) => void;
}

/**
 * The onboarding / personal-context editor: one question per screen, each
 * beside a short explanation of why Reflect asks. Answers autosave as the
 * user types (debounced), so navigating back or quitting never loses input.
 * No field is required; "Set up later" is always available.
 */
export function OnboardingFlow({ mode, initialProfile, onExit }: OnboardingFlowProps) {
  const [draft, setDraft] = useState<OnboardingDraft>(() => draftFromProfile(initialProfile));
  const [step, setStep] = useState<OnboardingStep>(mode === 'edit' ? 'about' : 'welcome');
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const statusRef = useRef<OnboardingStatus>(initialProfile.onboardingStatus);
  const latestProfile = useRef<UserProfile>(initialProfile);
  const draftRef = useRef(draft);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const rootRef = useRef<HTMLDivElement>(null);
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

  // Land on the answer field when the screen has one (so the user can just
  // type), otherwise on the heading for keyboard / screen-reader users.
  useEffect(() => {
    const field = rootRef.current?.querySelector<HTMLElement>('[data-onb-autofocus]:not(:disabled)');
    (field ?? headingRef.current)?.focus();
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
    setDirection(STEP_ORDER.indexOf(target) < STEP_ORDER.indexOf(step) ? 'back' : 'forward');
    setStep(target);
  };

  const begin = () =>
    run(async () => {
      if (statusRef.current === 'not_started' || statusRef.current === 'skipped') {
        await setStatus('in_progress');
      }
      goTo('tour');
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
      else goTo('done');
    });

  const leave = () => onExit(latestProfile.current);

  /** What Enter does on the current screen. */
  const advance = () => {
    if (busy) return;
    if (step === 'welcome') void begin();
    else if (step === 'context') void finish();
    else if (step === 'done') leave();
    else goTo(nextStep(step));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    // Escape closes the editor from Settings. First-run onboarding never
    // dismisses on a stray keypress.
    if (e.key === 'Escape' && mode === 'edit') {
      e.preventDefault();
      e.stopPropagation();
      void skip();
      return;
    }
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return; // the button handles its own click
    if (target.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return; // newline
    e.preventDefault();
    advance();
  };

  const setTags = (field: TagField) => (tags: string[]) => update((d) => ({ ...d, [field]: tags }));

  const secondaryLabel = mode === 'edit' ? 'Close' : 'Set up later';
  const secondary = { label: secondaryLabel, onClick: skip, disabled: busy };
  const next = { label: 'Continue', onClick: () => goTo(nextStep(step)), disabled: busy };
  const back = () => goTo(previousStep(step));
  const number = stepNumber(step);
  const answers = draftToInput(draft);

  return (
    <div ref={rootRef} className="onb-root w-full" onKeyDown={onKeyDown}>
      <div className="w-full max-w-[1000px] mx-auto">
        {step === 'welcome' && (
          <Intro key="welcome" direction={direction}>
            <div className="onb-mark" aria-hidden="true">
              <Clock size={22} strokeWidth={2.25} />
            </div>
            <div className="space-y-3">
              <p className="onb-eyebrow">Welcome to Reflect</p>
              <h1 id="onb-heading" ref={headingRef} tabIndex={-1} className="onb-title onb-title-lg">
                See where your time actually goes.
              </h1>
              <p className="onb-lede">
                Your computer knows which apps you opened. Reflect works out what you were really doing — and shows it
                as a timeline you can read at a glance.
              </p>
            </div>

            <div className="onb-compare" aria-hidden="true">
              <div className="space-y-1.5">
                <div className="onb-caption">What your computer sees</div>
                <RawRow app="VS Code" detail="api.ts" time="42m" />
                <RawRow app="Chrome" detail="stackoverflow.com" time="18m" />
                <RawRow app="ChatGPT" detail="New chat" time="9m" />
                <RawRow app="VS Code" detail="api.test.ts" time="31m" />
              </div>
              <ArrowRight size={18} className="onb-compare-arrow" />
              <div className="space-y-1.5">
                <div className="onb-caption">What Reflect shows you</div>
                <ResultBlock title="Building the payments API" meta="1h 40m · one activity" tag="Work" tall />
              </div>
            </div>

            <div className="space-y-3">
              <Actions
                primary={{ label: 'Get started', onClick: begin, disabled: busy }}
                secondary={{ label: 'Set up later', onClick: skip, disabled: busy }}
                enterHint
              />
              <p className="text-[12.5px] text-faint">Takes about a minute. Every question is optional.</p>
            </div>
          </Intro>
        )}

        {step === 'tour' && (
          <Intro key="tour" direction={direction}>
            <div className="space-y-3">
              <p className="onb-eyebrow">How Reflect works</p>
              <h1 id="onb-heading" ref={headingRef} tabIndex={-1} className="onb-title">
                You work. Reflect keeps the record.
              </h1>
            </div>

            <ol className="onb-tour">
              {TOUR_POINTS.map(({ Icon, title, body }, i) => (
                <li key={title} className="onb-tour-card" style={{ animationDelay: `${i * 60}ms` }}>
                  <span className="onb-tour-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <div>
                    <div className="text-[14.5px] font-semibold">{title}</div>
                    <p className="text-[13px] text-muted leading-relaxed mt-1">{body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="space-y-3">
              <Actions
                primary={{ label: 'Continue', onClick: () => goTo('background'), disabled: busy }}
                back={back}
                secondary={{ label: 'Set up later', onClick: skip, disabled: busy }}
                enterHint
              />
              <PrivacyNote />
            </div>
          </Intro>
        )}

        {step === 'background' && (
          <Intro key="background" direction={direction}>
            <div className="space-y-3">
              <p className="onb-eyebrow">Set it up once</p>
              <h1 id="onb-heading" ref={headingRef} tabIndex={-1} className="onb-title">
                Reflect works in the background. You do not need to open it for tracking to work.
              </h1>
              <p className="onb-lede">
                Close this window whenever you like — Reflect stays in the system tray and keeps your record. Open it
                when you want to look at your day.
              </p>
            </div>

            <div className="onb-observes">
              <div>
                <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                  <Eye size={15} style={{ color: 'var(--accent)' }} aria-hidden="true" />
                  What Reflect notes
                </div>
                <ul>
                  {OBSERVED.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                  <EyeOff size={15} className="text-faint" aria-hidden="true" />
                  What it cannot know
                </div>
                <ul>
                  {NOT_OBSERVED.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="space-y-2">
              <BackgroundControls variant="onboarding" />
              <p className="text-[12.5px] text-faint leading-relaxed">
                These are on by default. You can pause tracking from the tray or the widget at any time, and change
                everything here later in <strong>Settings → Background &amp; Tracking</strong>.
              </p>
            </div>

            <Actions
              primary={{ label: 'Personalize Reflect', onClick: () => goTo('about'), disabled: busy }}
              back={back}
              secondary={{ label: 'Set up later', onClick: skip, disabled: busy }}
              enterHint
            />
          </Intro>
        )}

        {isQuestionStep(step) && number !== null && (
          <>
            <ProgressIndicator
              current={number}
              label={mode === 'edit' ? 'Personal context' : 'About you'}
              onJump={(target) => goTo(target)}
            />
            <div className="onb-layout">
              <div className="min-w-0">
                {step === 'about' && (
                  <Question
                    key="about"
                    direction={direction}
                    headingRef={headingRef}
                    title="What do you currently do?"
                    subtitle="Pick everything that describes your life right now."
                  >
                    <div role="group" aria-label="Roles" className="onb-roles">
                      {PRESET_ROLES.map((role) => {
                        const Icon = ROLE_ICONS[role];
                        return (
                          <RoleCard
                            key={role}
                            Icon={Icon}
                            label={role}
                            pressed={draft.roles.includes(role)}
                            onClick={() => update((d) => toggleRole(d, role))}
                          />
                        );
                      })}
                      <RoleCard Icon={Plus} label="Other" pressed={draft.otherSelected} onClick={() => update(toggleOther)} />
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
                          style={{ height: 40 }}
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
                      primary={next}
                      back={mode === 'onboarding' ? back : undefined}
                      secondary={secondary}
                      enterHint
                    />
                  </Question>
                )}

                {step === 'work' && (
                  <Question
                    key="work"
                    direction={direction}
                    headingRef={headingRef}
                    title="What are you currently working on?"
                    subtitle="Projects, courses, a job — anything you are actively working on."
                  >
                    <TagInput
                      label="What are you currently working on?"
                      hideLabel
                      placeholder="Type one and press Enter…"
                      tags={draft.currentWork}
                      max={TAG_LIMITS.currentWork}
                      suggestions={['College studies', 'Freelance work', 'Startup', 'Exam preparation']}
                      onChange={setTags('currentWork')}
                    />
                    <Actions primary={next} back={back} secondary={secondary} enterHint />
                  </Question>
                )}

                {step === 'priorities' && (
                  <Question
                    key="priorities"
                    direction={direction}
                    headingRef={headingRef}
                    title="What matters most to you right now?"
                    subtitle="The things you want your time to move forward."
                  >
                    <TagInput
                      label="What matters most to you right now?"
                      hideLabel
                      placeholder="e.g. Finish my degree, build my startup…"
                      tags={draft.priorities}
                      max={TAG_LIMITS.priorities}
                      suggestions={['Finish my degree', 'Build my startup', 'Earn more', 'Improve fitness', 'Learn system design']}
                      onChange={setTags('priorities')}
                    />
                    <Actions primary={next} back={back} secondary={secondary} enterHint />
                  </Question>
                )}

                {step === 'interests' && (
                  <Question
                    key="interests"
                    direction={direction}
                    headingRef={headingRef}
                    title="What do you do outside work or study?"
                    subtitle="Hobbies and personal interests — the time that is yours."
                  >
                    <TagInput
                      label="What do you do outside work or study?"
                      hideLabel
                      placeholder="e.g. gaming, reading, football, music…"
                      tags={draft.interests}
                      max={TAG_LIMITS.interests}
                      suggestions={['Gaming', 'Reading', 'Football', 'Music', 'Travel', 'Personal projects']}
                      onChange={setTags('interests')}
                    />
                    <Actions primary={next} back={back} secondary={secondary} enterHint />
                  </Question>
                )}

                {step === 'context' && (
                  <Question
                    key="context"
                    direction={direction}
                    headingRef={headingRef}
                    title="Anything Reflect should know?"
                    subtitle="Anything that could make your activity look different from what it really is."
                  >
                    <TextArea
                      id="onb-context"
                      label="Things to keep in mind"
                      optional
                      autoFocus
                      rows={4}
                      maxLength={PROFILE_LIMITS.additionalContext}
                      placeholder="e.g. My Game Theory project is a hobby, not college work."
                      value={draft.additionalContext}
                      onChange={(additionalContext) => update((d) => ({ ...d, additionalContext }))}
                    />
                    <div className="space-y-2">
                      <div className="text-[12px] text-faint">Tap an example to start from it</div>
                      <div className="flex flex-col items-start gap-1.5">
                        {CONTEXT_EXAMPLES.map((ex) => (
                          <button
                            key={ex}
                            type="button"
                            className="onb-example"
                            onClick={() =>
                              update((d) => ({
                                ...d,
                                additionalContext: [d.additionalContext.trim(), ex]
                                  .filter(Boolean)
                                  .join('\n')
                                  .slice(0, PROFILE_LIMITS.additionalContext),
                              }))
                            }
                          >
                            <Plus size={12} />
                            {ex}
                          </button>
                        ))}
                      </div>
                    </div>

                    <Actions
                      primary={{ label: mode === 'edit' ? 'Save' : 'Finish', onClick: finish, disabled: busy }}
                      back={back}
                      secondary={secondary}
                      enterHint="Ctrl + Enter"
                    />
                  </Question>
                )}
              </div>

              <WhyPanel step={step} answers={answers} />
            </div>
          </>
        )}

        {step === 'done' && (
          <Intro key="done" direction={direction}>
            <div className="onb-check" aria-hidden="true">
              <Check size={22} strokeWidth={3} />
            </div>
            <div className="space-y-3">
              <h1 id="onb-heading" ref={headingRef} tabIndex={-1} className="onb-title">
                You’re all set.
              </h1>
              <p className="onb-lede">
                {hasProfileContent(answers)
                  ? 'Here is what Reflect will keep in mind when it reads your day.'
                  : 'You did not add any context, and that is fine — Reflect will work from your activity alone.'}
              </p>
            </div>

            {hasProfileContent(answers) && <Recap answers={answers} />}

            <ul className="onb-next">
              <li>
                <Activity size={15} aria-hidden="true" />
                <span>Reflect is already running, and keeps running after you close this window. Just use your computer as usual.</span>
              </li>
              <li>
                <Clock size={15} aria-hidden="true" />
                <span>Come back to <strong>Timeline</strong> later today to see how your time was spent.</span>
              </li>
              <li>
                <Sparkles size={15} aria-hidden="true" />
                <span>Change your answers anytime in <strong>Settings → Personal context</strong>.</span>
              </li>
            </ul>

            <Actions primary={{ label: 'Start using Reflect', onClick: leave }} back={back} enterHint />
          </Intro>
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

// ─── Why Reflect asks ──────────────────────────────────────────────────────

interface Insight {
  body: string;
  raw: { app: string; detail: string; time: string };
  result: { title: string; meta: string; tag: string };
}

/** The explanation shown beside each question, using the user's own answers
 * in the example where they have given one. */
function insightFor(step: QuestionStep, answers: UserProfileInput): Insight {
  switch (step) {
    case 'about':
      return {
        body: 'The same activity means different things to different people. Knowing who you are lets Reflect read your day the way you would.',
        raw: { app: 'YouTube', detail: 'System design lecture', time: '50m' },
        result: answers.roles.includes('Student')
          ? { title: 'Studying system design', meta: '50m', tag: 'Learning' }
          : { title: 'Learning system design', meta: '50m', tag: answers.roles[0] ?? 'Learning' },
      };
    case 'work':
      return {
        body: 'App names say little. When Reflect knows your projects, it can name the work instead of the tool.',
        raw: { app: 'VS Code', detail: 'index.ts', time: '1h 12m' },
        result: { title: `Working on ${answers.currentWork[0] ?? 'your project'}`, meta: '1h 12m', tag: 'Work' },
      };
    case 'priorities':
      return {
        body: 'Priorities tell Reflect what is central to your day and what is incidental, so the things you care about stand out.',
        raw: { app: 'Chrome', detail: 'docs, 14 tabs', time: '38m' },
        result: { title: answers.priorities[0] ?? 'Progress on what matters', meta: '38m', tag: 'Priority' },
      };
    case 'interests':
      return {
        body: 'Work tools are used for personal things too. Your interests help Reflect keep personal time out of your work hours.',
        raw: { app: 'VS Code', detail: 'side-project', time: '45m' },
        result: { title: answers.interests[0] ?? 'A personal project', meta: '45m', tag: 'Personal' },
      };
    case 'context':
      return {
        body: 'You know the exceptions. One sentence here corrects a mistake Reflect would otherwise repeat every day.',
        raw: { app: 'YouTube', detail: 'Lecture playlist', time: '45m' },
        result: { title: 'Coursework research', meta: '45m', tag: 'Not leisure' },
      };
  }
}

function WhyPanel({ step, answers }: { step: QuestionStep; answers: UserProfileInput }) {
  const insight = insightFor(step, answers);
  return (
    <aside className="onb-panel" aria-label="Why Reflect asks this">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        <Sparkles size={14} style={{ color: 'var(--accent)' }} aria-hidden="true" />
        Why Reflect asks
      </div>
      <p key={step} className="onb-panel-body text-[13.5px] text-muted leading-relaxed">
        {insight.body}
      </p>
      <div className="space-y-1.5" aria-hidden="true">
        <div className="onb-caption">Example</div>
        <RawRow {...insight.raw} />
        <div className="flex justify-center text-faint">
          <ArrowDown size={14} />
        </div>
        <ResultBlock key={insight.result.title} {...insight.result} />
      </div>
    </aside>
  );
}

function RawRow({ app, detail, time }: { app: string; detail: string; time: string }) {
  return (
    <div className="onb-raw">
      <span className="font-medium">{app}</span>
      <span className="truncate text-faint">{detail}</span>
      <span className="ml-auto tabular-nums text-faint">{time}</span>
    </div>
  );
}

function ResultBlock(props: { title: string; meta: string; tag: string; tall?: boolean }) {
  return (
    <div className="onb-result" data-tall={props.tall ? '' : undefined}>
      <div className="text-[14px] font-semibold leading-snug">{props.title}</div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="onb-result-tag">{props.tag}</span>
        <span className="text-[12px] text-muted tabular-nums">{props.meta}</span>
      </div>
    </div>
  );
}

function Recap({ answers }: { answers: UserProfileInput }) {
  const rows: { label: string; values: string[] }[] = [
    { label: 'You are', values: answers.roles },
    { label: 'Working on', values: answers.currentWork },
    { label: 'Matters most', values: answers.priorities },
    { label: 'Outside work', values: answers.interests },
  ].filter((row) => row.values.length > 0);

  return (
    <dl className="onb-recap">
      {rows.map((row) => (
        <div key={row.label} className="onb-recap-row">
          <dt>{row.label}</dt>
          <dd className="flex flex-wrap gap-1.5">
            {row.values.map((value) => (
              <span key={value} className="chip onb-tag">{value}</span>
            ))}
          </dd>
        </div>
      ))}
      {answers.description && (
        <div className="onb-recap-row">
          <dt>In your words</dt>
          <dd className="text-[13.5px] leading-relaxed">{answers.description}</dd>
        </div>
      )}
      {answers.additionalContext && (
        <div className="onb-recap-row">
          <dt>Keep in mind</dt>
          <dd className="text-[13.5px] leading-relaxed whitespace-pre-line">{answers.additionalContext}</dd>
        </div>
      )}
    </dl>
  );
}

// ─── Layout pieces ─────────────────────────────────────────────────────────

/** Segmented progress; every segment jumps to its question (answers autosave). */
function ProgressIndicator(props: { current: number; label: string; onJump: (step: QuestionStep) => void }) {
  const total = QUESTION_STEPS.length;
  return (
    <nav className="mb-8" aria-label={`Question ${props.current} of ${total}`}>
      <div className="flex items-baseline justify-between mb-2">
        <span className="onb-eyebrow">{props.label}</span>
        <span className="text-[12px] text-muted tabular-nums" aria-hidden="true">
          {props.current} of {total}
        </span>
      </div>
      <div className="flex gap-1.5">
        {QUESTION_STEPS.map((target, i) => (
          <button
            key={target}
            type="button"
            className="onb-progress"
            data-state={i + 1 < props.current ? 'done' : i + 1 === props.current ? 'current' : 'todo'}
            aria-label={`Go to question ${i + 1}`}
            aria-current={i + 1 === props.current ? 'step' : undefined}
            onClick={() => props.onJump(target)}
          >
            <span />
          </button>
        ))}
      </div>
    </nav>
  );
}

/** Centered single-column screen (welcome, tour, done). */
function Intro(props: { direction: 'forward' | 'back'; children: ReactNode }) {
  return (
    <section className="onb-step onb-intro" data-dir={props.direction} aria-labelledby="onb-heading">
      {props.children}
    </section>
  );
}

function Question(props: {
  title: string;
  subtitle: string;
  direction: 'forward' | 'back';
  headingRef: RefObject<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <section className="onb-step space-y-6" data-dir={props.direction} aria-labelledby="onb-heading">
      <div className="space-y-2">
        <h1 id="onb-heading" ref={props.headingRef} tabIndex={-1} className="onb-title">
          {props.title}
        </h1>
        <p className="text-[15px] text-muted leading-relaxed">{props.subtitle}</p>
      </div>
      {props.children}
    </section>
  );
}

function RoleCard(props: { Icon: LucideIcon; label: string; pressed: boolean; onClick: () => void }) {
  return (
    <button type="button" className="onb-role" aria-pressed={props.pressed} onClick={props.onClick}>
      <span className="onb-role-icon" aria-hidden="true">
        {props.pressed ? <Check size={15} strokeWidth={3} /> : <props.Icon size={15} />}
      </span>
      {props.label}
    </button>
  );
}

function Actions(props: {
  primary: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: { label: string; onClick: () => void; disabled?: boolean };
  back?: () => void;
  /** Show the keyboard shortcut for the primary action. */
  enterHint?: boolean | string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      {props.back && (
        <button type="button" className="btn" style={{ height: 40 }} onClick={props.back} aria-label="Back">
          <ArrowLeft size={15} />
        </button>
      )}
      <button
        type="button"
        className="btn btn-primary onb-primary"
        onClick={props.primary.onClick}
        disabled={props.primary.disabled}
      >
        {props.primary.label}
        <ArrowRight size={15} />
      </button>
      {props.enterHint && (
        <span className="text-[12px] text-faint ml-1 select-none" aria-hidden="true">
          or press <span className="kbd">{typeof props.enterHint === 'string' ? props.enterHint : 'Enter ↵'}</span>
        </span>
      )}
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
  autoFocus?: boolean;
  rows: number;
  maxLength: number;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const remaining = props.maxLength - props.value.length;
  return (
    <div className="space-y-1.5">
      <label htmlFor={props.id} className="flex items-baseline gap-2 text-[14px] font-semibold">
        {props.label}
        {props.optional && <span className="text-[12px] font-normal text-faint">Optional</span>}
      </label>
      <textarea
        id={props.id}
        className="field w-full resize-none leading-relaxed"
        style={{ padding: '10px 12px', fontSize: 15 }}
        rows={props.rows}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        value={props.value}
        aria-describedby={`${props.id}-count`}
        data-onb-autofocus={props.autoFocus ? '' : undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <div
        id={`${props.id}-count`}
        className="text-right text-[11.5px] text-faint"
        style={{ visibility: remaining <= 80 ? 'visible' : 'hidden' }}
      >
        {remaining} characters left
      </div>
    </div>
  );
}

function PrivacyNote() {
  return (
    <p className="text-[12.5px] text-faint leading-relaxed">
      Your answers are saved on this device. When AI analysis is on, they are sent to Google Gemini together with
      your activity so it can be interpreted.
    </p>
  );
}
