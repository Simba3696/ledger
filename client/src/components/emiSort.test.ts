import { describe, expect, it } from "vitest";
import { sortEmis } from "./emiSort";
import { makeEmi } from "../testUtils";

const names = (list: { cardOrBank: string }[]) => list.map((e) => e.cardOrBank);

describe("sortEmis", () => {
  const amazon = makeEmi({ row: 3, cardOrBank: "Amazon Pay", dueDay: 7, emiAmount: 4770, totalAmount: 95000, remaining: 71000, estimatedPayoffDate: "2028-03-07" });
  const oneCard = makeEmi({ row: 4, cardOrBank: "OneCard", dueDay: 8, emiAmount: 4922, totalAmount: 41320, remaining: 4922, estimatedPayoffDate: "2027-01-08" });
  const kuri = makeEmi({ row: 5, cardOrBank: "Kuri", dueDay: 10, emiAmount: 5000, totalAmount: 50000, remaining: 25000, estimatedPayoffDate: "2027-05-10" });
  const emis = [amazon, oneCard, kuri];

  it("sorts by name, ascending and descending", () => {
    expect(names(sortEmis(emis, "name", "asc"))).toEqual(["Amazon Pay", "Kuri", "OneCard"]);
    expect(names(sortEmis(emis, "name", "desc"))).toEqual(["OneCard", "Kuri", "Amazon Pay"]);
  });

  it("sorts by Months Left using the same payoff date the row shows", () => {
    expect(names(sortEmis(emis, "monthsLeft", "asc"))).toEqual(["OneCard", "Kuri", "Amazon Pay"]);
    expect(names(sortEmis(emis, "monthsLeft", "desc"))).toEqual(["Amazon Pay", "Kuri", "OneCard"]);
  });

  it("puts a paid-off loan (no payoff date) first under Months Left ascending", () => {
    const paidOff = makeEmi({ row: 6, cardOrBank: "Done", remaining: 0, isPaidOff: true, estimatedPayoffDate: null });
    expect(names(sortEmis([...emis, paidOff], "monthsLeft", "asc"))[0]).toBe("Done");
  });

  it("sorts by % paid, not the raw remaining amount", () => {
    // OneCard: 88% paid, Amazon: 25% paid, Kuri: 50% paid.
    expect(names(sortEmis(emis, "percentPaid", "desc"))).toEqual(["OneCard", "Kuri", "Amazon Pay"]);
    expect(names(sortEmis(emis, "remaining", "asc"))).toEqual(["OneCard", "Kuri", "Amazon Pay"]);
  });

  it("sorts by due day, EMI amount and total amount", () => {
    expect(names(sortEmis(emis, "dueDay", "asc"))).toEqual(["Amazon Pay", "OneCard", "Kuri"]);
    expect(names(sortEmis(emis, "emiAmount", "desc"))).toEqual(["Kuri", "OneCard", "Amazon Pay"]);
    expect(names(sortEmis(emis, "totalAmount", "asc"))).toEqual(["OneCard", "Kuri", "Amazon Pay"]);
  });

  it("keeps one card's EMIs in the order they were added under Name", () => {
    const first = makeEmi({ row: 10, cardOrBank: "Rubyx", remarks: "first" });
    const second = makeEmi({ row: 11, cardOrBank: "Rubyx", remarks: "second" });
    const sorted = sortEmis([first, amazon, second], "name", "asc");
    expect(sorted.map((e) => e.row)).toEqual([3, 10, 11]);
  });

  it("does not mutate the list it was given", () => {
    const input = [...emis];
    sortEmis(input, "name", "desc");
    expect(input).toEqual(emis);
  });
});
