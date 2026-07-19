import "./PaymentToggle.css";

interface Props {
  isCard: boolean;
  onChange: (isCard: boolean) => void;
}

export function PaymentToggle({ isCard, onChange }: Props) {
  return (
    <div className="payment-toggle">
      <button type="button" className={!isCard ? "selected" : ""} onClick={() => onChange(false)}>
        Cash
      </button>
      <button type="button" className={isCard ? "selected" : ""} onClick={() => onChange(true)}>
        Credit Card
      </button>
    </div>
  );
}
