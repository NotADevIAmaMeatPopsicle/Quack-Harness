// Imperative confirm() replacement that fits the dark theme. Returns a
// Promise<boolean> so callers can `await confirm({...})` inline.

import { createRoot } from "react-dom/client";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const cleanup = (result: boolean) => {
      root.unmount();
      host.remove();
      resolve(result);
    };

    root.render(
      <div className="confirm-overlay" onClick={() => cleanup(false)}>
        <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
          <h3 style={{ margin: 0 }}>{options.title}</h3>
          <p style={{ margin: 0, color: "var(--muted)" }}>{options.message}</p>
          <div className="confirm-actions">
            <button type="button" className="btn" onClick={() => cleanup(false)}>
              {options.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              className={"btn " + (options.danger ? "btn-danger" : "btn-primary")}
              onClick={() => cleanup(true)}
              autoFocus
            >
              {options.confirmLabel ?? "OK"}
            </button>
          </div>
        </div>
      </div>,
    );
  });
}
