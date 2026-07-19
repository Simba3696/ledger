import { EARLIEST_YEAR } from "../constants";

interface Props {
  value: number;
  onChange: (year: number) => void;
}

export function YearSelect({ value, onChange }: Props) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - EARLIEST_YEAR + 1 }, (_, i) => EARLIEST_YEAR + i);

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
