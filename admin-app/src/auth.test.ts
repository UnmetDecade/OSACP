import { describe, expect, it } from "vitest";
import { strongPassword } from "./auth";

describe("strongPassword", () => {
  it("accepts a password longer than 8 characters with mixed case and a symbol", () => {
    expect(strongPassword("Abcdef1!x")).toBe(true);
    expect(strongPassword("Longer-Pass9")).toBe(true);
  });

  it("rejects passwords that are too short or miss a character class", () => {
    expect(strongPassword("Abcdef1!")).toBe(false); // exactly 8
    expect(strongPassword("abcdef1!x")).toBe(false); // no uppercase
    expect(strongPassword("ABCDEF1!X")).toBe(false); // no lowercase
    expect(strongPassword("Abcdef12x")).toBe(false); // no symbol
    expect(strongPassword("")).toBe(false);
  });
});
