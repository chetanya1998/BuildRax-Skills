import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { Lang } from "./languages.js";

const require = createRequire(import.meta.url);

export interface RawImport {
  /** TS/JS: module specifier. Python: dotted module, with leading dots when relative. */
  specifier: string;
  line: number;
  /** Python `from x import a, b` names. */
  names?: string[];
}

let initPromise: Promise<void> | undefined;
const languages = new Map<Lang, Language>();

async function getParser(lang: Lang): Promise<Parser> {
  initPromise ??= Parser.init();
  await initPromise;
  let language = languages.get(lang);
  if (!language) {
    language = await Language.load(
      require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`),
    );
    languages.set(lang, language);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

function stringValue(node: Node | null): string | undefined {
  if (!node) return undefined;
  const t = node.text;
  if (t.length >= 2 && /^["'`]/.test(t)) return t.slice(1, -1);
  return undefined;
}

/** Extract import-like references from a source file using its syntax tree (no execution). */
export async function extractImports(source: string, lang: Lang): Promise<RawImport[]> {
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    return [];
  }
  try {
    return lang === "python" ? pythonImports(tree.rootNode) : jsImports(tree.rootNode);
  } finally {
    tree.delete();
    parser.delete();
  }
}

function jsImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const n of root.descendantsOfType(["import_statement", "export_statement"])) {
    if (!n) continue;
    const spec = stringValue(n.childForFieldName("source"));
    if (spec !== undefined) out.push({ specifier: spec, line: n.startPosition.row + 1 });
  }
  for (const n of root.descendantsOfType("call_expression")) {
    if (!n) continue;
    const fn = n.childForFieldName("function");
    if (!fn || (fn.type !== "import" && !(fn.type === "identifier" && fn.text === "require")))
      continue;
    const arg = n.childForFieldName("arguments")?.namedChildren[0] ?? null;
    if (arg?.type !== "string") continue;
    const spec = stringValue(arg);
    if (spec !== undefined) out.push({ specifier: spec, line: n.startPosition.row + 1 });
  }
  return out.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function pythonImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const n of root.descendantsOfType("import_statement")) {
    if (!n) continue;
    for (const c of n.childrenForFieldName("name").filter((x): x is Node => !!x)) {
      const dotted = c.type === "aliased_import" ? c.childForFieldName("name") : c;
      if (dotted) out.push({ specifier: dotted.text, line: n.startPosition.row + 1 });
    }
  }
  for (const n of root.descendantsOfType("import_from_statement")) {
    if (!n) continue;
    const mod = n.childForFieldName("module_name");
    if (!mod) continue;
    const names = n
      .childrenForFieldName("name")
      .filter((c): c is Node => !!c)
      .map((c) => (c.type === "aliased_import" ? c.childForFieldName("name")?.text : c.text))
      .filter((x): x is string => !!x);
    out.push({ specifier: mod.text, line: n.startPosition.row + 1, names });
  }
  return out.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}
