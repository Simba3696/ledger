import { useEffect, useState } from "react";
import { registerDialogHost, type DialogState } from "./dialogs";
import "./Dialog.css";

/** Native confirm()/prompt() dialogs render inconsistently across mobile
 * browser chrome, and prompt() specifically is known to misbehave (in some
 * cases silently returning null) in an installed/standalone PWA context —
 * which this app now has, via its manifest. Mount once near the app root;
 * every confirmDialog()/promptDialog() call anywhere renders through this
 * same instance. */
export function DialogHost() {
  const [state, setState] = useState<DialogState>(null);
  const [value, setValue] = useState("");

  useEffect(() => registerDialogHost(setState, setValue), []);

  useEffect(() => {
    if (!state) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close(state!.kind === "confirm" ? false : null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!state) return null;

  function close(result: boolean | string | null) {
    if (state!.kind === "confirm") state!.resolve(result as boolean);
    else state!.resolve(result as string | null);
    setState(null);
  }

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close(state.kind === "confirm" ? false : null);
      }}
    >
      <div className="dialog-card" role={state.kind === "confirm" ? "alertdialog" : "dialog"} aria-modal="true">
        <p className="dialog-message">{state.message}</p>
        {state.kind === "prompt" && (
          <input
            type={state.type}
            inputMode={state.inputMode}
            className="dialog-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              // Bubbles to the document-level Escape handler above too, but
              // Enter needs handling here specifically to submit the input.
              if (e.key === "Enter") close(value);
            }}
          />
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-cancel"
            autoFocus={state.kind === "confirm"}
            onClick={() => close(state.kind === "confirm" ? false : null)}
          >
            {state.cancelLabel}
          </button>
          <button
            type="button"
            className={`dialog-confirm${state.kind === "confirm" && state.destructive ? " destructive" : ""}`}
            onClick={() => close(state.kind === "confirm" ? true : value)}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
