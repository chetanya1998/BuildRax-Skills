export type TokKind = "kw" | "str" | "com" | "num" | "plain";
export interface Tok {
  k: TokKind;
  v: string;
}
/** Carries multi-line comments/strings from one line to the next. */
export interface LexState {
  block?: "*/" | '"""' | "'''";
}

const JS_KW = new Set(
  "import export from default const let var function return if else for while do switch case break continue new class extends implements interface type enum async await try catch finally throw typeof instanceof in of void yield static public private protected readonly as null undefined true false this super".split(
    " ",
  ),
);
const PY_KW = new Set(
  "import from as def class return if elif else for while break continue pass try except finally raise with lambda yield async await in is not and or None True False global nonlocal del assert".split(
    " ",
  ),
);

/**
 * Tiny, dependency-free tokenizer: comments, strings, numbers and keywords. It is a reading aid,
 * not a parser, and never produces HTML (callers render tokens as text nodes).
 */
export function tokenizeLine(
  line: string,
  language: string | undefined,
  state: LexState = {},
): { toks: Tok[]; state: LexState } {
  const py = language === "python";
  const kw = py ? PY_KW : JS_KW;
  const toks: Tok[] = [];
  const push = (k: TokKind, v: string): void => {
    if (!v) return;
    const last = toks[toks.length - 1];
    if (last && last.k === k && (k === "plain" || k === "com")) last.v += v;
    else toks.push({ k, v });
  };
  let i = 0;
  let block = state.block;

  while (i < line.length) {
    if (block) {
      const end = line.indexOf(block, i);
      const kind: TokKind = block === "*/" ? "com" : "str";
      if (end < 0) {
        push(kind, line.slice(i));
        i = line.length;
      } else {
        push(kind, line.slice(i, end + block.length));
        i = end + block.length;
        block = undefined;
      }
      continue;
    }
    const rest = line.slice(i);
    if (!py && rest.startsWith("//")) {
      push("com", rest);
      break;
    }
    if (py && rest.startsWith("#")) {
      push("com", rest);
      break;
    }
    if (!py && rest.startsWith("/*")) {
      block = "*/";
      push("com", "/*");
      i += 2;
      continue;
    }
    if (py && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      block = rest.slice(0, 3) as '"""' | "'''";
      push("str", rest.slice(0, 3));
      i += 3;
      continue;
    }
    const ch = line[i]!;
    if (ch === '"' || ch === "'" || (!py && ch === "`")) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      push("str", line.slice(i, Math.min(j + 1, line.length)));
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9][0-9_.]*(?:e[+-]?[0-9]+)?[a-z]*/i.exec(rest)!;
      push("num", m[0]);
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(rest)!;
      push(kw.has(m[0]) ? "kw" : "plain", m[0]);
      i += m[0].length;
      continue;
    }
    push("plain", ch);
    i++;
  }
  return { toks, state: { block } };
}

/** Tokenize a whole file, threading multi-line state through the lines. */
export function tokenizeFile(text: string, language: string | undefined): Tok[][] {
  let state: LexState = {};
  return text.split("\n").map((line) => {
    const r = tokenizeLine(line, language, state);
    state = r.state;
    return r.toks;
  });
}
