import { EARLIEST_YEAR } from "../constants";

interface Props {
  value: number;
  onChange: (year: number) => void;
}

export function YearSelect({ value, onChange }: Props) {
  const currentYear = new Date().getFullYear();
  // +1 beyond the current year so next year is selectable ahead of time (e.g.
  // setting things up in December). A year needs no setup: its months list
  // as empty until the first entry is added there.
  const years = Array.from({ length: currentYear - EARLIEST_YEAR + 2 }, (_, i) => EARLIEST_YEAR + i);

  return (
    <select className="select" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </select>
  );
}
