import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteEmi, getEmis, updateEmi } from "./api";
import { makeEmi } from "./testUtils";

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api", () => {
  it("returns the parsed JSON body on success", async () => {
    const emi = makeEmi();
    const fetchMock = stubFetch(new Response(JSON.stringify([emi]), { status: 200 }));
    await expect(getEmis()).resolves.toEqual([emi]);
    expect(fetchMock).toHaveBeenCalledWith("/api/emi");
  });

  it("throws the server's own error message on a failed request", async () => {
    stubFetch(new Response(JSON.stringify({ error: "No EMI entry at row 99" }), { status: 404 }));
    await expect(getEmis()).rejects.toThrow("No EMI entry at row 99");
  });

  it("falls back to the status text when the error body isn't JSON", async () => {
    stubFetch(new Response("<html>gateway down</html>", { status: 502, statusText: "Bad Gateway" }));
    await expect(getEmis()).rejects.toThrow("Bad Gateway");
  });

  it("resolves to undefined for a 204 No Content", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(deleteEmi(5)).resolves.toBeUndefined();
  });

  it("sends an EMI edit as a JSON PUT, Payments left included", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify(makeEmi()), { status: 200 }));
    const edits = {
      cardOrBank: "Moneyview",
      emiAmount: 4387,
      dueDay: 6,
      totalAmount: 105411,
      remarks: "",
      remainingAsOf: 105287,
      durationMonths: 24,
      interestRate: 27.9,
      foreclosureCharge: 0,
    };
    await updateEmi(39, edits);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/emi/39");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual(edits);
  });
});
