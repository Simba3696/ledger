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

export type DialogState =
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

/** Called from `DialogHost`'s mount effect so confirmDialog()/promptDialog()
 * render through it; returns the matching unregister for the effect cleanup,
 * after which calls go nowhere again (their promises never settle) until a
 * host mounts. */
export function registerDialogHost(
  setState: (s: DialogState) => void,
  setValue: (v: string) => void,
): () => void {
  setDialogState = setState;
  setPendingValue = setValue;
  return () => {
    setDialogState = null;
    setPendingValue = () => {};
  };
}
