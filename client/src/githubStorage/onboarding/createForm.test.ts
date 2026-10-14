import { describe, expect, it } from "vitest";
import { createProblem, MIN_PASSPHRASE } from "./createForm";

const good = { passphrase: "correct horse battery", confirm: "correct horse battery", saved: true, sections: ["expenses" as const], timeZone: "Asia/Kolkata" };

describe("Create's rules (#8)", () => {
  it("a complete form can be sent", () => {
    expect(createProblem(good)).toBeNull();
  });

  it("refuses a passphrase under 12 characters, and nothing else about its makeup", () => {
    expect(createProblem({ ...good, passphrase: "a".repeat(MIN_PASSPHRASE - 1), confirm: "a".repeat(MIN_PASSPHRASE - 1) })).toBe("Use at least 12 characters for the passphrase.");
    expect(createProblem({ ...good, passphrase: "a".repeat(MIN_PASSPHRASE), confirm: "a".repeat(MIN_PASSPHRASE) })).toBeNull();
  });

  it("refuses mismatched passphrases", () => {
    expect(createProblem({ ...good, confirm: "correct horse battery!" })).toBe("The two passphrases don't match.");
  });

  it("refuses an unticked 'I've saved it' box", () => {
    expect(createProblem({ ...good, saved: false })).toBe("Tick the box once you've saved the passphrase somewhere safe.");
  });

  it("refuses no sections, and no time zone", () => {
    expect(createProblem({ ...good, sections: [] })).toBe("Choose at least one section.");
    expect(createProblem({ ...good, timeZone: " " })).toBe("Choose a time zone.");
  });
});
