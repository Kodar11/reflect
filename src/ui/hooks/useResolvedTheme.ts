import { useEffect, useState } from 'react';
import type { Theme } from '../store/themeStore';

/** Resolve a Theme preference to the concrete 'light' | 'dark' currently in
 *  effect, listening to OS-level changes when 'system' is selected. */
export function useResolvedTheme(theme: Theme): 'light' | 'dark' {
  const getSystem = () =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? getSystem() : theme,
  );

  useEffect(() => {
    if (theme !== 'system') {
      setResolved(theme);
      return;
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setResolved(mql.matches ? 'dark' : 'light');
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  return resolved;
}
