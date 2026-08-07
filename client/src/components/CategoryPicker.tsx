import type { Category, CategoryOption } from "../api";
import "./CategoryPicker.css";

interface Props {
  categories: CategoryOption[];
  value: Category | null;
  onChange: (category: Category) => void;
}

export function CategoryPicker({ categories, value, onChange }: Props) {
  return (
    <div className="category-picker">
      {categories.map((c) => {
        const selected = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            className={`category-chip${selected ? " selected" : ""}`}
            style={{ background: c.bg, color: c.fg }}
            onClick={() => onChange(c.id)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
