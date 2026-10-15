import { describe, expect, it } from "vitest";
import { lossText } from "./forgetFlow";

describe("what Forget this device says would be lost (#8)", () => {
  it("nothing unsaved: no warning", () => {
    expect(lossText({ pendingCount: 0, leftBehindOwnCount: 0 })).toBeNull();
  });

  it("names changes not on GitHub and left-behind groups separately, and that Re-apply keeps the groups", () => {
    expect(lossText({ pendingCount: 1, leftBehindOwnCount: 0 })).toBe("1 change on this device hasn't reached GitHub yet");
    expect(lossText({ pendingCount: 0, leftBehindOwnCount: 2 })).toBe("2 groups of your changes a restore left behind haven't been re-applied (Re-apply keeps them)");
    expect(lossText({ pendingCount: 3, leftBehindOwnCount: 1 })).toBe(
      "3 changes on this device haven't reached GitHub yet, and 1 group of your changes a restore left behind hasn't been re-applied (Re-apply keeps it)",
    );
  });
});
