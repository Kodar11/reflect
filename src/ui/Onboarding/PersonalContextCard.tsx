import { useEffect, useState } from 'react';
import { hasProfileContent, type UserProfile } from '../../profile/UserProfile';

/** Settings entry for revisiting onboarding answers: a compact summary and an Edit action. */
export function PersonalContextCard({ onEdit }: { onEdit: (profile: UserProfile) => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.userProfile
      .get()
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e) => console.error('[Settings] failed to load personal context', e));
    return () => {
      cancelled = true;
    };
  }, []);

  return <PersonalContextView profile={profile} onEdit={onEdit} />;
}

/** At most this many items per line; the rest is counted. */
const PER_LINE = 3;

function summarize(items: string[]): string {
  if (items.length <= PER_LINE) return items.join(' · ');
  return `${items.slice(0, PER_LINE).join(' · ')} +${items.length - PER_LINE}`;
}

export function PersonalContextView({ profile, onEdit }: { profile: UserProfile | null; onEdit: (profile: UserProfile) => void }) {
  const isSetUp = profile !== null && hasProfileContent(profile);
  const lines: [string, string][] = !profile
    ? []
    : ([
        ['Roles', summarize(profile.roles)],
        ['Working on', summarize(profile.currentWork)],
        ['Priorities', summarize(profile.priorities)],
        ['Interests', summarize(profile.interests)],
        ['More context', profile.additionalContext ?? profile.description ?? ''],
      ] as [string, string][]).filter(([, value]) => value.length > 0);

  return (
    <div className="card">
      <div className="bg-row">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">Personal context</div>
            <p className="text-[13px] text-muted mt-0.5">
              {isSetUp
                ? 'Used to understand your activity and to write your reflections.'
                : 'Not set up yet. Tell Reflect about your roles, current work and priorities so reflections fit your day.'}
            </p>
          </div>
          <button type="button" className="btn bg-control shrink-0" disabled={profile === null} onClick={() => profile && onEdit(profile)}>
            {isSetUp ? 'Edit' : 'Set up'}
          </button>
        </div>
        {isSetUp && (
          <dl className="settings-facts mt-3">
            {lines.map(([label, value]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd className="truncate" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
