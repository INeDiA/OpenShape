import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, estimatePrint, fitsBed } from "./profile";

describe("print estimates", () => {
  it("weighs a 20 mm PLA cube: walls solid, inside at the infill", () => {
    const p = { ...DEFAULT_PROFILE, infill: 0.2, perimeters: 2, nozzle: 0.4, density: 1.24, pricePerKg: 20 };
    const volume = 8000, area = 2400;
    const shell = 2400 * 0.8; // 1920 mm³
    const grams = ((shell + (volume - shell) * 0.2) / 1000) * 1.24;
    const e = estimatePrint(volume, area, p);
    expect(e.grams).toBeCloseTo(grams, 9);
    expect(e.solidGrams).toBeCloseTo(9.92, 9);
    expect(e.cost).toBeCloseTo((grams / 1000) * 20, 9);
  });

  it("treats thin parts as all wall", () => {
    // A 1 mm plate: the wall thickness covers all of it.
    const e = estimatePrint(100 * 100 * 1, 2 * 100 * 100 + 400, { ...DEFAULT_PROFILE, infill: 0 });
    expect(e.grams).toBeCloseTo(e.solidGrams, 9);
  });

  it("checks the build volume, turning the part if that helps", () => {
    expect(fitsBed([250, 200, 100], [256, 256, 256])).toBe(true);
    expect(fitsBed([240, 200, 100], [250, 210, 220])).toBe(true);
    expect(fitsBed([200, 240, 100], [250, 210, 220])).toBe(true); // turned 90°
    expect(fitsBed([260, 100, 100], [256, 256, 256])).toBe(false);
    expect(fitsBed([100, 100, 300], [256, 256, 256])).toBe(false);
  });
});
