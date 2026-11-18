import { describe, expect, it } from "vitest";
import { matchScore } from "./CommandPalette";

describe("command palette matching", () => {
  it("prefers prefixes, then substrings, then letters in order", () => {
    expect(matchScore("ext", "Extrude")).toBe(0);
    expect(matchScore("flat", "Lay flat")!).toBeGreaterThan(0);
    expect(matchScore("flat", "Lay flat")!).toBeLessThan(2);
    expect(matchScore("ppl", "Push/Pull")).not.toBeNull();
    expect(matchScore("ppl", "Push/Pull")!).toBeGreaterThanOrEqual(2);
    expect(matchScore("xyz", "Fillet")).toBeNull();
    expect(matchScore("", "Fillet")).toBe(0);
  });
});
