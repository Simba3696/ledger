const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const EARLIEST_YEAR = 2018;

interface Props {
  month: number;
  year: number;
  onMonthChange: (month: number) => void;
  onYearChange: (year: number) => void;
}

export function MonthYearPicker({ month, year, onMonthChange, onYearChange }: Props) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - EARLIEST_YEAR + 1 }, (_, i) => EARLIEST_YEAR + i);

  return (
    <div className="month-picker">
      <select value={month} onChange={(e) => onMonthChange(Number(e.target.value))}>
        {MONTH_NAMES.map((name, idx) => (
          <option key={name} value={idx + 1}>
            {name}
          </option>
        ))}
      </select>
      <select value={year} onChange={(e) => onYearChange(Number(e.target.value))}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
