// ─── UI Preferences Store ──────────────────────────────────────────
// Zustand for small local UI state (sidebar collapsed, theme, etc).
// Persisted to localStorage so reload preserves the operator's view.

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiPrefsState {
  sidebarCollapsed: boolean;
  theme: "system" | "light" | "dark";
  toggleSidebar: () => void;
  setTheme: (theme: UiPrefsState["theme"]) => void;
}

export const useUiPrefs = create<UiPrefsState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: "system",
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
    }),
    { name: "quack-ui-prefs" },
  ),
);
