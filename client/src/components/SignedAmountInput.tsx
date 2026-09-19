import "./SignedAmountInput.css";

interface Props {
  /** Signed numeric string, e.g. "500", "-500", or "" when empty — the same
   * plain format callers already parse via `Number(value)` everywhere else
   * in this app. This component only changes how that string gets typed,
   * never its shape. */
  value: string;
  onChange: (value: string) => void;
  /** Shown on the button that keeps the amount non-negative. */
  positiveLabel: string;
  /** Shown on the button that negates it. */
  negativeLabel: string;
  placeholder?: string;
  disabled?: boolean;
}

/** `<input type="number">` never gets a "-" key on a phone's numeric or
 * decimal keypad — there's no on-screen way to type a negative amount at
 * all (a real bug report: entering a negative Debts amount was impossible
 * on an iPhone). Splitting sign from magnitude sidesteps this entirely: the
 * magnitude field only ever needs digits, so a keypad without "-" is no
 * obstacle, and the sign becomes an explicit two-button toggle — which also
 * reads more clearly than an implicit "+/-" prefix convention did, even on
 * desktop. */
export function SignedAmountInput({ value, onChange, positiveLabel, negativeLabel, placeholder, disabled }: Props) {
  const isNegative = value.startsWith("-");
  const magnitude = isNegative ? value.slice(1) : value;

  function setNegative(negative: boolean) {
    onChange(negative ? `-${magnitude}` : magnitude);
  }

  function setMagnitude(next: string) {
    // A physical keyboard can still type "-" directly into a number input
    // despite `min="0"` (browsers only enforce that on blur/submit, not as
    // you type) — strip it here so the sign toggle stays the single source
    // of truth instead of silently disagreeing with what's typed.
    const clean = next.replace(/^-/, "");
    onChange(isNegative && clean !== "" ? `-${clean}` : clean);
  }

  return (
    <div className="signed-amount">
      <div className="signed-amount-sign" role="group">
        <button type="button" className={isNegative ? "" : "selected"} onClick={() => setNegative(false)} disabled={disabled}>
          {positiveLabel}
        </button>
        <button type="button" className={isNegative ? "selected" : ""} onClick={() => setNegative(true)} disabled={disabled}>
          {negativeLabel}
        </button>
      </div>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={magnitude}
        onChange={(e) => setMagnitude(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
}
