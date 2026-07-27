interface Props {
  active: boolean;
}

/** A spinner over a faded backdrop, absolutely positioned to cover whatever
 * `position: relative` container it's placed in. Used instead of swapping
 * content out for plain "Loading…" text, so the previous content (e.g. last
 * month's stats while this month's are being fetched) stays visible-but-faded
 * underneath rather than flashing to blank. */
export function LoadingOverlay({ active }: Props) {
  if (!active) return null;
  return (
    <div className="loading-overlay">
      <div className="loading-overlay-backdrop" />
      <div className="spinner" />
    </div>
  );
}
