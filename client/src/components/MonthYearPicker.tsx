import { YearSelect } from "./YearSelect";
import "./MonthYearPicker.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  month: number;
  year: number;
  onMonthChange: (month: number) => void;
  onYearChange: (year: number) => void;
}

export function MonthYearPicker({ month, year, onMonthChange, onYearChange }: Props) {
  return (
    <div className="month-picker">
      <select className="select" value={month} onChange={(e) => onMonthChange(Number(e.target.value))}>
        {MONTH_NAMES.map((name, idx) => (
          <option key={name} value={idx + 1}>
            {name}
          </option>
        ))}
      </select>
      <YearSelect value={year} onChange={onYearChange} />
    </div>
  );
}
