// Small, safe expression language for parameters and variables.
//
//   width * 2 + 5mm        lengths are millimetres; mm, cm, m, in suffixes convert
//   atan2(h, w) + 15deg    angles are degrees; deg and rad suffixes convert
//   max(a, b) / 2          functions: see FUNCTIONS
//
// No eval(): the input is tokenized and parsed into an AST.

export type Ast =
  | { t: "num"; v: number }
  | { t: "var"; name: string }
  | { t: "neg"; a: Ast }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^" | "%"; a: Ast; b: Ast }
  | { t: "call"; fn: string; args: Ast[] };

export class ExprError extends Error {}

const UNITS: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  deg: 1,
  rad: 180 / Math.PI,
};

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...a: number[]) => number }> = {
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  abs: { arity: [1, 1], fn: Math.abs },
  sign: { arity: [1, 1], fn: Math.sign },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  round: { arity: [1, 1], fn: Math.round },
  // Trigonometry works in degrees, like the rest of the UI.
  sin: { arity: [1, 1], fn: (x) => Math.sin(x * D2R) },
  cos: { arity: [1, 1], fn: (x) => Math.cos(x * D2R) },
  tan: { arity: [1, 1], fn: (x) => Math.tan(x * D2R) },
  asin: { arity: [1, 1], fn: (x) => Math.asin(x) * R2D },
  acos: { arity: [1, 1], fn: (x) => Math.acos(x) * R2D },
  atan: { arity: [1, 1], fn: (x) => Math.atan(x) * R2D },
  atan2: { arity: [2, 2], fn: (y, x) => Math.atan2(y, x) * R2D },
  pow: { arity: [2, 2], fn: Math.pow },
  hypot: { arity: [1, 8], fn: Math.hypot },
  min: { arity: [1, 8], fn: Math.min },
  max: { arity: [1, 8], fn: Math.max },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export const RESERVED = new Set([...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), ...Object.keys(UNITS)]);

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      let v = Number(num[0]);
      i += num[0].length;
      // Unit suffix glued to the number: 10mm, 2.5in, 30deg.
      const unit = /^[a-z]+/i.exec(src.slice(i));
      if (unit && UNITS[unit[0].toLowerCase()] !== undefined) {
        v *= UNITS[unit[0].toLowerCase()];
        i += unit[0].length;
      } else if (unit) {
        throw new ExprError(`Unknown unit "${unit[0]}"`);
      }
      out.push({ k: "num", v });
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    if ("+-*/^%(),".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}"`);
  }
  return out;
}

export function parse(src: string): Ast {
  const toks = tokenize(src);
  if (toks.length === 0) throw new ExprError("Empty expression");
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.k === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}"`);
    pos++;
  };

  // expr := term (('+'|'-') term)*
  const expr = (): Ast => {
    let a = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[pos++].v as "+" | "-";
      a = { t: "bin", op, a, b: term() };
    }
    return a;
  };
  // term := unary (('*'|'/'|'%') unary)*
  const term = (): Ast => {
    let a = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[pos++].v as "*" | "/" | "%";
      a = { t: "bin", op, a, b: unary() };
    }
    return a;
  };
  // unary := '-' unary | '+' unary | power
  const unary = (): Ast => {
    if (isOp("-")) {
      pos++;
      return { t: "neg", a: unary() };
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  };
  // power := atom ('^' unary)?   (right associative)
  const power = (): Ast => {
    const a = atom();
    if (isOp("^")) {
      pos++;
      return { t: "bin", op: "^", a, b: unary() };
    }
    return a;
  };
  const atom = (): Ast => {
    const tk = peek();
    if (!tk) throw new ExprError("Unexpected end of expression");
    if (tk.k === "num") {
      pos++;
      return { t: "num", v: tk.v };
    }
    if (tk.k === "id") {
      pos++;
      if (isOp("(")) {
        pos++;
        const args: Ast[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            pos++;
            args.push(expr());
          }
        }
        expect(")");
        const f = FUNCTIONS[tk.v];
        if (!f) throw new ExprError(`Unknown function "${tk.v}"`);
        if (args.length < f.arity[0] || args.length > f.arity[1]) throw new ExprError(`${tk.v}() takes ${f.arity[0] === f.arity[1] ? f.arity[0] : `${f.arity[0]}-${f.arity[1]}`} argument(s)`);
        return { t: "call", fn: tk.v, args };
      }
      return { t: "var", name: tk.v };
    }
    if (isOp("(")) {
      pos++;
      const a = expr();
      expect(")");
      return a;
    }
    throw new ExprError(`Unexpected "${tk.v}"`);
  };

  const ast = expr();
  if (pos < toks.length) throw new ExprError(`Unexpected "${toks[pos].v}"`);
  return ast;
}

export type Scope = ReadonlyMap<string, number>;

export function evaluate(ast: Ast, scope: Scope): number {
  switch (ast.t) {
    case "num":
      return ast.v;
    case "var": {
      if (scope.has(ast.name)) return scope.get(ast.name)!;
      if (ast.name in CONSTANTS) return CONSTANTS[ast.name];
      throw new ExprError(`Unknown variable "${ast.name}"`);
    }
    case "neg":
      return -evaluate(ast.a, scope);
    case "bin": {
      const a = evaluate(ast.a, scope), b = evaluate(ast.b, scope);
      switch (ast.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/":
          if (b === 0) throw new ExprError("Division by zero");
          return a / b;
        case "%": return a % b;
        case "^": return Math.pow(a, b);
      }
    }
    // falls through: exhaustive above
    case "call":
      return FUNCTIONS[(ast as { fn: string }).fn].fn(...(ast as { args: Ast[] }).args.map((x) => evaluate(x, scope)));
  }
}

/** Variable names an expression refers to (constants excluded). */
export function dependencies(ast: Ast, out = new Set<string>()): Set<string> {
  switch (ast.t) {
    case "var":
      if (!(ast.name in CONSTANTS)) out.add(ast.name);
      break;
    case "neg":
      dependencies(ast.a, out);
      break;
    case "bin":
      dependencies(ast.a, out);
      dependencies(ast.b, out);
      break;
    case "call":
      ast.args.forEach((a) => dependencies(a, out));
      break;
  }
  return out;
}

/** Parses and evaluates in one go; throws ExprError with a readable message. */
export function evalExpr(src: string, scope: Scope): number {
  const v = evaluate(parse(src), scope);
  if (!Number.isFinite(v)) throw new ExprError("Result is not a finite number");
  return v;
}

/** True when the text is just a number, so it should be stored as a value, not an expression. */
export function isPlainNumber(src: string): boolean {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(src);
}

export const isValidIdentifier = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !RESERVED.has(s);
