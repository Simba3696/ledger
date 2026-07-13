import type { Category, CategoryOption } from "../api";
import { CATEGORY_SWATCH } from "../categoryColors";

interface Props {
  categories: CategoryOption[];
  value: Category | null;
  onChange: (category: Category) => void;
}

export function CategoryPicker({ categories, value, onChange }: Props) {
  return (
    <div className="category-picker">
      {categories.map((c) => {
        const swatch = CATEGORY_SWATCH[c.id];
        const selected = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            className={`category-chip${selected ? " selected" : ""}`}
            style={{ background: swatch.bg, color: swatch.fg }}
            onClick={() => onChange(c.id)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
