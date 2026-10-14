import { describe, expect, it } from "vitest";
import { defaultSections, defaultTimeZone, parseDefaultSections, SECTION_LABELS, SECTIONS, timeZones } from "./defaults";

describe("VITE_DEFAULT_MODULES (#8, T7)", () => {
  it("unset or blank ticks every section", () => {
    expect(parseDefaultSections(undefined)).toEqual({ ok: true, sections: [...SECTIONS] });
    expect(parseDefaultSections("  ")).toEqual({ ok: true, sections: [...SECTIONS] });
  });

  it("a subset comes back in canonical order, duplicates dropped", () => {
    expect(parseDefaultSections("subscriptions,expenses,expenses")).toEqual({ ok: true, sections: ["expenses", "subscriptions"] });
  });

  it("is case-insensitive and whitespace tolerant", () => {
    expect(parseDefaultSections(" Expenses , CREDIT-CARDS ")).toEqual({ ok: true, sections: ["expenses", "credit-cards"] });
  });

  it("an unknown name is a misconfigured copy, named with the server's wording", () => {
    expect(parseDefaultSections("expenses,bogus")).toEqual({
      ok: false,
      message: "Unknown module in VITE_DEFAULT_MODULES: bogus. Valid names: expenses, finances, debts, emi, credit-cards, subscriptions (leave it unset to enable all).",
    });
  });

  it("this build has no VITE_DEFAULT_MODULES, so every section is ticked, each with its label", () => {
    expect(defaultSections()).toEqual({ ok: true, sections: [...SECTIONS] });
    expect(SECTIONS.map((s) => SECTION_LABELS[s])).toEqual(["Expenses", "Finances", "Debts", "EMI", "Credit Cards", "Subscriptions"]);
  });

  it("the default time zone is the device's, and the picker always lists it, UTC and the ledger's own zone", () => {
    expect(defaultTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // ICU lists canonical names only: "Asia/Calcutta" but not "Asia/Kolkata",
    // and no "UTC", though both are valid and a ledger may hold either.
    const zones = timeZones(["Asia/Kolkata"]);
    expect(zones).not.toBeNull();
    expect(zones).toEqual(expect.arrayContaining([defaultTimeZone(), "UTC", "Asia/Kolkata"]));
    expect(zones).toEqual([...new Set(zones)].sort());
  });
});
