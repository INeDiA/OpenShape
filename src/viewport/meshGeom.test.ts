import { describe, expect, it } from "vitest";
import { splitPair } from "./meshGeom";

describe("edge name parsing", () => {
  it("splits at the top-level bar only", () => {
    expect(splitPair("a:end|b:side:l1")).toEqual(["a:end", "b:side:l1"]);
    expect(splitPair("pp:end|pp:side:[ex:end|fi:blend:[ex:end|ex:side:l4]]")).toEqual(["pp:end", "pp:side:[ex:end|fi:blend:[ex:end|ex:side:l4]]"]);
  });
});
