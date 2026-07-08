import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeState {
  theme: Theme;
  cycleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ORDER: Theme[] = ['system', 'light', 'dark'];

export const useThemeStore = create<ThemeState>((set) => ({
  theme: 'system',
  cycleTheme: () =>
    set((state) => ({ theme: ORDER[(ORDER.indexOf(state.theme) + 1) % ORDER.length] })),
  setTheme: (theme) => set({ theme }),
}));
