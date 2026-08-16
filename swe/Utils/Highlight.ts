import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const THEME = "github-dark-default";

let ready: Promise<Highlighter> | null = null;

function highlighter(): Promise<Highlighter> {

  ready ??= createHighlighter({

    themes: [THEME],
    langs: ["bash"],

    engine: createJavaScriptRegexEngine({ forgiving: true }),

  });

  return ready;

}

const EXTENSIONS: Record<string, BundledLanguage> = {

  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx", jsx: "jsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",

  json: "json", jsonc: "jsonc", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",

  css: "css", scss: "scss", less: "less", html: "html", svelte: "svelte", vue: "vue",

  md: "markdown", mdx: "mdx",

  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", lua: "lua", r: "r", dart: "dart", zig: "zig",

  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",

  sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
  dockerfile: "docker", makefile: "make",

};

/** Shiki language id for a path, falling back to plain text. */
export function langOf(file: string): string {

  const name = file.replaceAll("\\", "/").split("/").pop() ?? file;
  const lower = name.toLowerCase();

  // extensionless files that still have a grammar
  if (EXTENSIONS[lower]) {

    return EXTENSIONS[lower];

  }

  const dot = lower.lastIndexOf(".");

  if (dot === -1) {

    return "text";

  }

  return EXTENSIONS[lower.slice(dot + 1)] ?? "text";

}

/**
 * Themed tokens per line. Grammars load on demand; an unknown one degrades to plain text...
*/
export async function tokenize(code: string, lang: string): Promise<ThemedToken[][]> {

  const shiki = await highlighter();

  let resolved = lang;

  if (resolved !== "text" && !shiki.getLoadedLanguages().includes(resolved)) {

    try {

      await shiki.loadLanguage(resolved as BundledLanguage);

    } catch {

      resolved = "text";

    }

  }

  return shiki.codeToTokens(code, { lang: resolved as BundledLanguage, theme: THEME }).tokens;

}
