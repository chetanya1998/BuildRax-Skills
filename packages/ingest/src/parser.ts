import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { Lang } from "./languages.js";
import { emptyFacts, jsFacts, pyFacts, type FileFacts } from "./routes/facts.js";
import { jsDataFacts, pyDataFacts } from "./dataops/facts.js";
import { jsEntities, pyEntities } from "./entities/facts.js";

const require = createRequire(import.meta.url);

export interface RawImport {
  /** TS/JS: module specifier. Python: dotted module, with leading dots when relative. */
  specifier: string;
  line: number;
  /** Python `from x import a, b` names. */
  names?: string[];
  /**
   * Local names the import binds in this file (`import x from`, `{ a as b }` → b, `* as ns`,
   * `const r = require()`, Python aliases). Used to follow router mounts across files.
   */
  locals?: string[];
}

export interface FileParse {
  imports: RawImport[];
  facts: FileFacts;
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
  return (await parseFile(source, lang)).imports;
}

/** One parse per file: imports plus the facts endpoint detection needs. */
export async function parseFile(source: string, lang: Lang): Promise<FileParse> {
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    return { imports: [], facts: emptyFacts() };
  }
  try {
    const root = tree.rootNode;
    if (lang === "python") {
      const data = pyDataFacts(root);
      return {
        imports: pythonImports(root),
        facts: { ...pyFacts(root), ...data, entities: pyEntities(root) },
      };
    }
    return {
      imports: jsImports(root),
      facts: { ...jsFacts(root), ...jsDataFacts(root), entities: jsEntities(root) },
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}

function jsLocals(stmt: Node): string[] {
  const clause = stmt.namedChildren.find((c) => c?.type === "import_clause");
  if (!clause) return [];
  const out: string[] = [];
  for (const c of clause.namedChildren) {
    if (!c) continue;
    if (c.type === "identifier") out.push(c.text);
    else if (c.type === "namespace_import") {
      const id = c.namedChildren.find((x) => x?.type === "identifier");
      if (id) out.push(id.text);
    } else if (c.type === "named_imports")
      for (const sp of c.namedChildren) {
        if (sp?.type !== "import_specifier") continue;
        const local = sp.childForFieldName("alias") ?? sp.childForFieldName("name");
        if (local) out.push(local.text);
      }
  }
  return out;
}

function jsImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const n of root.descendantsOfType(["import_statement", "export_statement"])) {
    if (!n) continue;
    const spec = stringValue(n.childForFieldName("source"));
    if (spec === undefined) continue;
    const locals = n.type === "import_statement" ? jsLocals(n) : [];
    out.push({
      specifier: spec,
      line: n.startPosition.row + 1,
      ...(locals.length ? { locals } : {}),
    });
  }
  for (const n of root.descendantsOfType("call_expression")) {
    if (!n) continue;
    const fn = n.childForFieldName("function");
    if (!fn || (fn.type !== "import" && !(fn.type === "identifier" && fn.text === "require")))
      continue;
    const arg = n.childForFieldName("arguments")?.namedChildren[0] ?? null;
    if (arg?.type !== "string") continue;
    const spec = stringValue(arg);
    if (spec === undefined) continue;
    // const router = require("./routes")
    const decl =
      n.parent?.type === "variable_declarator" ? n.parent.childForFieldName("name") : null;
    out.push({
      specifier: spec,
      line: n.startPosition.row + 1,
      ...(decl?.type === "identifier" ? { locals: [decl.text] } : {}),
    });
  }
  return out.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function pythonImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const n of root.descendantsOfType("import_statement")) {
    if (!n) continue;
    for (const c of n.childrenForFieldName("name").filter((x): x is Node => !!x)) {
      const dotted = c.type === "aliased_import" ? c.childForFieldName("name") : c;
      const local =
        c.type === "aliased_import"
          ? c.childForFieldName("alias")?.text
          : dotted?.text.split(".")[0];
      if (dotted)
        out.push({
          specifier: dotted.text,
          line: n.startPosition.row + 1,
          ...(local ? { locals: [local] } : {}),
        });
    }
  }
  for (const n of root.descendantsOfType("import_from_statement")) {
    if (!n) continue;
    const mod = n.childForFieldName("module_name");
    if (!mod) continue;
    const parts = n.childrenForFieldName("name").filter((c): c is Node => !!c);
    const names = parts
      .map((c) => (c.type === "aliased_import" ? c.childForFieldName("name")?.text : c.text))
      .filter((x): x is string => !!x);
    const locals = parts
      .map((c) => (c.type === "aliased_import" ? c.childForFieldName("alias")?.text : c.text))
      .filter((x): x is string => !!x);
    out.push({ specifier: mod.text, line: n.startPosition.row + 1, names, locals });
  }
  return out.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}
