export type Lang = "typescript" | "tsx" | "javascript" | "python";

const EXT: Record<string, Lang> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
};

export function langForFile(file: string): Lang | undefined {
  const i = file.lastIndexOf(".");
  return i < 0 ? undefined : EXT[file.slice(i).toLowerCase()];
}

/** Language label stored on file nodes. */
export function languageLabel(lang: Lang): string {
  return lang === "tsx" ? "typescript" : lang;
}
