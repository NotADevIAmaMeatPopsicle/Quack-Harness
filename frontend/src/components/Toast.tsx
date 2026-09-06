// ─── Toast / Notification System ───────────────────────────────────
// Lightweight imperative toast API backed by a Zustand-style store.
// Hooked once in <App />, accessed anywhere via `toast.success(...)` /
// `toast.error(...)`.

import { useEffect } from "react";
import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  expiresAt: number;
}

interface ToastStore {
  toasts: ToastEntry[];
  push: (kind: ToastKind, title: string, detail?: string) => void;
  dismiss: (id: number) => void;
}

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (kind, title, detail) => {
    const id = Date.now() + Math.random();
    const ttlMs = kind === "error" ? 8000 : 4000;
    const entry: ToastEntry = { id, kind, title, detail, expiresAt: Date.now() + ttlMs };
    set((s) => ({ toasts: [...s.toasts, entry] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, ttlMs);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative facade so callers don't need to grab a hook to fire a toast. */
export const toast = {
  success: (title: string, detail?: string) => useToastStore.getState().push("success", title, detail),
  error: (title: string, detail?: string) => useToastStore.getState().push("error", title, detail),
  info: (title: string, detail?: string) => useToastStore.getState().push("info", title, detail),
};

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  // Re-render every second so expiry is visually consistent if a toast
  // is held open by hover (future enhancement).
  useEffect(() => {
    const id = setInterval(() => {
      // No-op render trigger; the store already prunes via setTimeout.
    }, 1000);
    return () => clearInterval(id);
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <div className="toast-title">{t.title}</div>
          {t.detail && <div className="toast-detail">{t.detail}</div>}
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >×</button>
        </div>
      ))}
    </div>
  );
}
