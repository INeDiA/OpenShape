import { describe, expect, it } from "vitest";
import { dependencies, evalExpr, ExprError, isPlainNumber, isValidIdentifier, parse } from "./expr";

const scope = new Map([
  ["width", 40],
  ["h", 30],
]);

describe("expressions", () => {
  it("respects precedence and associativity", () => {
    expect(evalExpr("1 + 2 * 3", scope)).toBe(7);
    expect(evalExpr("(1 + 2) * 3", scope)).toBe(9);
    expect(evalExpr("2 ^ 3 ^ 2", scope)).toBe(512);
    expect(evalExpr("-2 ^ 2", scope)).toBe(-4);
    expect(evalExpr("10 - 4 - 3", scope)).toBe(3);
  });

  it("uses variables, functions and constants", () => {
    expect(evalExpr("width / 2", scope)).toBe(20);
    expect(evalExpr("max(width, h) - min(width, h)", scope)).toBe(10);
    expect(evalExpr("sqrt(h^2 + width^2)", scope)).toBe(50);
    expect(evalExpr("2 * pi", scope)).toBeCloseTo(Math.PI * 2);
  });

  it("works in degrees", () => {
    expect(evalExpr("sin(30)", scope)).toBeCloseTo(0.5);
    expect(evalExpr("atan2(1, 1)", scope)).toBeCloseTo(45);
    expect(evalExpr("1rad", scope)).toBeCloseTo(57.2958, 3);
  });

  it("converts length units to millimetres", () => {
    expect(evalExpr("2cm + 5mm", scope)).toBe(25);
    expect(evalExpr("1in", scope)).toBe(25.4);
  });

  it("reports readable errors", () => {
    expect(() => evalExpr("depth * 2", scope)).toThrow(/Unknown variable "depth"/);
    expect(() => evalExpr("1 +", scope)).toThrow(ExprError);
    expect(() => evalExpr("foo(1)", scope)).toThrow(/Unknown function/);
    expect(() => evalExpr("3 / 0", scope)).toThrow(/Division by zero/);
    expect(() => evalExpr("10 furlongs", scope)).toThrow(/Unknown unit|Unexpected/);
    expect(() => evalExpr("atan2(1)", scope)).toThrow(/2 argument/);
  });

  it("lists dependencies", () => {
    expect([...dependencies(parse("width * 2 + max(h, pi)"))].sort()).toEqual(["h", "width"]);
  });

  it("classifies inputs", () => {
    expect(isPlainNumber("12.5")).toBe(true);
    expect(isPlainNumber("-3e2")).toBe(true);
    expect(isPlainNumber("width")).toBe(false);
    expect(isValidIdentifier("plate_w2")).toBe(true);
    expect(isValidIdentifier("2w")).toBe(false);
    expect(isValidIdentifier("sin")).toBe(false);
  });
});
