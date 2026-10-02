import { useEffect, useState } from 'react';
import { hasProfileContent, type UserProfile } from '../../profile/UserProfile';

/** Settings entry for revisiting onboarding answers. */
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

  const isSetUp = profile !== null && profile.onboardingStatus === 'completed' && hasProfileContent(profile);
  const summary = profile === null
    ? ''
    : isSetUp
      ? [...profile.roles, ...profile.currentWork].slice(0, 4).join(' · ')
      : 'Not set up yet';

  return (
    <div className="card flex items-center justify-between gap-4 p-5">
      <div className="min-w-0">
        <div className="text-[15px] font-semibold">Personal context</div>
        <p className="text-[13px] text-muted mt-0.5">
          Edit the information Reflect uses to understand your activity.
        </p>
        {summary && <p className="text-[12.5px] text-faint mt-1 truncate">{summary}</p>}
      </div>
      <button
        type="button"
        className="btn btn-secondary py-1.5 px-4 shrink-0"
        disabled={profile === null}
        onClick={() => profile && onEdit(profile)}
      >
        {isSetUp ? 'Edit' : 'Set up'}
      </button>
    </div>
  );
}
