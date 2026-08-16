import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { LanguageRegistration, ThemeRegistrationAny, ThemedToken } from "@shikijs/types";

import bash from "@shikijs/langs/bash";
import githubDark from "@shikijs/themes/github-dark-default";

export type { ThemedToken };

const THEME = "github-dark-default";

type LangModule = { default: LanguageRegistration | LanguageRegistration[] };

const LOADERS: Record<string, () => Promise<LangModule>> = {

  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  javascript: () => import("@shikijs/langs/javascript"),

  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  xml: () => import("@shikijs/langs/xml"),

  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  html: () => import("@shikijs/langs/html"),
  svelte: () => import("@shikijs/langs/svelte"),
  vue: () => import("@shikijs/langs/vue"),

  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),

  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  swift: () => import("@shikijs/langs/swift"),
  lua: () => import("@shikijs/langs/lua"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  zig: () => import("@shikijs/langs/zig"),

  fish: () => import("@shikijs/langs/fish"),
  powershell: () => import("@shikijs/langs/powershell"),

  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  proto: () => import("@shikijs/langs/proto"),
  docker: () => import("@shikijs/langs/docker"),
  make: () => import("@shikijs/langs/make"),

};

const EXTENSIONS: Record<string, string> = {

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

let ready: Promise<HighlighterCore> | null = null;

function highlighter(): Promise<HighlighterCore> {

  ready ??= createHighlighterCore({

    themes: [githubDark as ThemeRegistrationAny],
    langs: [bash],

    engine: createJavaScriptRegexEngine({ forgiving: true }),

  });

  return ready;

}

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

    const load = LOADERS[resolved];

    try {

      if (load) {

        await shiki.loadLanguage((await load()).default);

      } else {

        resolved = "text";

      }

    } catch {

      resolved = "text";

    }

  }

  return shiki.codeToTokens(code, { lang: resolved, theme: THEME }).tokens;

}
