import { describe, it, expect } from "vitest";
import { MODULES, parseEnabledModules } from "../src/modules.js";

describe("parseEnabledModules", () => {
  it("enables every module when unset or blank", () => {
    expect(parseEnabledModules(undefined)).toEqual([...MODULES]);
    expect(parseEnabledModules("")).toEqual([...MODULES]);
    expect(parseEnabledModules("   ")).toEqual([...MODULES]);
    expect(parseEnabledModules(" , ,")).toEqual([...MODULES]);
  });

  it("accepts a single module", () => {
    expect(parseEnabledModules("expenses")).toEqual(["expenses"]);
  });

  it("is case-insensitive and whitespace-tolerant, and returns canonical order", () => {
    expect(parseEnabledModules(" Subscriptions ,DEBTS,  expenses ")).toEqual(["expenses", "debts", "subscriptions"]);
    expect(parseEnabledModules("Credit-Cards,emi")).toEqual(["emi", "credit-cards"]);
  });

  it("ignores duplicates and empty items", () => {
    expect(parseEnabledModules("debts,,Debts, debts ,")).toEqual(["debts"]);
  });

  it("lists every module when all are named", () => {
    expect(parseEnabledModules([...MODULES].reverse().join(","))).toEqual([...MODULES]);
  });

  it("throws on an unknown name, listing the valid ones", () => {
    expect(() => parseEnabledModules("expenses,debt")).toThrow(
      "Unknown module in ENABLED_MODULES: debt. Valid names: expenses, finances, debts, emi, credit-cards, subscriptions",
    );
  });

  it("names every unknown entry", () => {
    expect(() => parseEnabledModules("dashboard, credit_cards")).toThrow(
      "Unknown modules in ENABLED_MODULES: dashboard, credit_cards.",
    );
  });
});
