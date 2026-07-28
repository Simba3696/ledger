import { useState } from "react";
import { updateSubscription, type SubscriptionDuration, type SubscriptionEntryComputed } from "../api";

interface Props {
  subscription: SubscriptionEntryComputed;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function EditSubscriptionRow({ subscription, onCancel, onSaved }: Props) {
  const [service, setService] = useState(subscription.service);
  const [amount, setAmount] = useState(String(subscription.amount));
  const [duration, setDuration] = useState<SubscriptionDuration>(subscription.duration);
  const [expiryAnchor, setExpiryAnchor] = useState(subscription.nextExpiry);
  const [cardOrBank, setCardOrBank] = useState(subscription.cardOrBank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave =
    service.trim().length > 0 &&
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0 &&
    expiryAnchor.trim() !== "" &&
    !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateSubscription(subscription.row, {
        service: service.trim(),
        amount: Number(amount),
        duration,
        expiryAnchor,
        cardOrBank: cardOrBank.trim(),
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <li className="subscription-row row-editing">
      <div className="edit-fields subscription-edit-fields">
        <input type="text" value={service} onChange={(e) => setService(e.target.value)} placeholder="Service" />
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
        />
        <select value={duration} onChange={(e) => setDuration(e.target.value as SubscriptionDuration)} className="select">
          <option value="Monthly">Monthly</option>
          <option value="Yearly">Yearly</option>
        </select>
        <input type="date" value={expiryAnchor} onChange={(e) => setExpiryAnchor(e.target.value)} />
        <input
          type="text"
          value={cardOrBank}
          onChange={(e) => setCardOrBank(e.target.value)}
          placeholder="Card / Bank (or N/A)"
        />
      </div>

      {error && <p className="error">{error}</p>}

      <div className="edit-actions">
        <button type="button" className="submit-btn" onClick={handleSave} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </li>
  );
}
