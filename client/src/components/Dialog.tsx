import { useEffect, useState } from "react";
import "./Dialog.css";

interface ConfirmOptions {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (Delete/Foreclose etc). */
  destructive?: boolean;
}

interface PromptOptions {
  message: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Matches the underlying <input>'s own type/inputMode — every current
   * caller wants a numeric amount, but this stays generic rather than
   * hardcoding that in. */
  type?: "text" | "number";
  inputMode?: "text" | "decimal" | "numeric";
}

type DialogState =
  | {
      kind: "confirm";
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      destructive: boolean;
      resolve: (value: boolean) => void;
    }
  | {
      kind: "prompt";
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      type: "text" | "number";
      inputMode: "text" | "decimal" | "numeric";
      resolve: (value: string | null) => void;
    }
  | null;

let setDialogState: ((s: DialogState) => void) | null = null;

/** Drop-in replacement for `window.confirm` — resolves `true`/`false`
 * instead of blocking the whole page, via an in-app modal rendered by
 * `DialogHost` (mounted once near the app root). */
export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === "string" ? { message: options } : options;
  return new Promise((resolve) => {
    setDialogState?.({
      kind: "confirm",
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "OK",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      destructive: opts.destructive ?? false,
      resolve,
    });
  });
}

/** Drop-in replacement for `window.prompt` — resolves the entered string, or
 * `null` for Cancel/Escape/dismiss, matching window.prompt's own
 * null-on-cancel convention so callers' existing `if (input === null ...)`
 * checks keep working unchanged. Unlike window.prompt there's no second
 * "default value" argument — pass it via `options.defaultValue` instead. */
export function promptDialog(options: PromptOptions | string): Promise<string | null> {
  const opts = typeof options === "string" ? { message: options } : options;
  return new Promise((resolve) => {
    setDialogState?.({
      kind: "prompt",
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "OK",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      type: opts.type ?? "text",
      inputMode: opts.inputMode ?? "text",
      resolve,
    });
    setPendingValue(opts.defaultValue ?? "");
  });
}

let setPendingValue: (v: string) => void = () => {};

/** Native confirm()/prompt() dialogs render inconsistently across mobile
 * browser chrome, and prompt() specifically is known to misbehave (in some
 * cases silently returning null) in an installed/standalone PWA context —
 * which this app now has, via its manifest. Mount once near the app root;
 * every confirmDialog()/promptDialog() call anywhere renders through this
 * same instance. */
export function DialogHost() {
  const [state, setState] = useState<DialogState>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    setDialogState = setState;
    setPendingValue = setValue;
    return () => {
      setDialogState = null;
      setPendingValue = () => {};
    };
  }, []);

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
