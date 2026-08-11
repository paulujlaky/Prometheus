import type { AssistantSummary } from "../../sdk/types";

/** Major chat providers the picker surfaces, in display order. */
const PROVIDERS = [

  "Anthropic",
  "OpenAI",
  "Google",
  "xAI",
  "Meta",
  "Mistral",
  "DeepSeek",
  "Perplexity",
  "Cohere",

] as const;

export type Provider = (typeof PROVIDERS)[number];

const MATCHERS: { provider: Provider; pattern: RegExp }[] = [

  { provider: "Anthropic", pattern: /\b(anthropic|claude)\b/i },
  { provider: "OpenAI", pattern: /\b(openai|gpt[\s-]?[0-9o]|o[1-9]\b|chatgpt)\b/i },
  { provider: "Google", pattern: /\b(google|gemini|gemma)\b/i },
  { provider: "xAI", pattern: /\b(xai|grok)\b/i },
  { provider: "Meta", pattern: /\b(meta|llama)\b/i },
  { provider: "Mistral", pattern: /\b(mistral|mixtral|codestral|pixtral)\b/i },
  { provider: "DeepSeek", pattern: /\bdeepseek\b/i },
  { provider: "Perplexity", pattern: /\b(perplexity|sonar)\b/i },
  { provider: "Cohere", pattern: /\b(cohere|command[\s-]?r)\b/i },

];

/** "GPT 5.6 (Sol)" → "GPT 5.6 Sol" so labels match names without parentheses. */
export function displayName(name: string): string {

  return name
    .replace(/\s*\(([^)]*)\)\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();

}

/** Published context-window sizes for common model families.*/
export function contextLimitOf(assistant: Pick<AssistantSummary, "name" | "alias" | "description"> | string | null | undefined): number {

  const name = typeof assistant === "string"
    ? assistant
    : [assistant?.name, assistant?.alias, assistant?.description].filter(Boolean).join(" ");

  if (!name) {

    return 128_000;

  }

  // Gemini long-context family
  if (/\bgemini\b/i.test(name)) {

    if (/\b(1\.5|2\.0|2\.5|pro|flash|ultra)\b/i.test(name)) {

      return 1_000_000;

    }

    return 128_000;

  }

  // Anthropic — most Claude 3/4 chat models are 200k
  if (/\b(claude|anthropic|sonnet|opus|haiku)\b/i.test(name)) {

    if (/\b(1m|1000k|million)\b/i.test(name)) {

      return 1_000_000;

    }

    return 200_000;

  }

  // OpenAI flagships: many GPT-4.1 / 5.x are 128k–400k; use 128k as the conservative default
  if (/\b(openai|chatgpt|gpt[\s-]?[0-9]|o[1-9]\b)\b/i.test(name)) {

    if (/\b(4\.1|o3|o4|128k|200k)\b/i.test(name)) {

      return 128_000;

    }

    if (/\b(400k|1m)\b/i.test(name)) {

      return 400_000;

    }

    return 128_000;

  }

  if (/\b(xai|grok)\b/i.test(name)) {

    return 131_072;

  }

  if (/\bdeepseek\b/i.test(name)) {

    return 128_000;

  }

  if (/\b(mistral|codestral|mixtral)\b/i.test(name)) {

    return 128_000;

  }

  if (/\b(llama|meta)\b/i.test(name)) {

    return 128_000;

  }

  if (/\b(cohere|command)\b/i.test(name)) {

    return 128_000;

  }

  if (/\b(perplexity|sonar)\b/i.test(name)) {

    return 128_000;

  }

  return 128_000;

}

/** Infer provider from name/alias/description fields the API already returns. */
export function providerOf(assistant: AssistantSummary): Provider | null {

  const haystack = [assistant.name, assistant.alias, assistant.description, assistant.displayCategory].filter(Boolean).join(" ");

  for (const { provider, pattern } of MATCHERS) {

    if (pattern.test(haystack)) {

      return provider;

    }

  }

  return null;

}

export interface ProviderGroup {

  provider: Provider;
  models: AssistantSummary[];

}

/** Keep only major-provider chat models, grouped for the submenu picker. */
export function groupAssistants(assistants: AssistantSummary[]): ProviderGroup[] {

  const buckets = new Map<Provider, AssistantSummary[]>();

  for (const assistant of assistants) {

    const provider = providerOf(assistant);

    if (!provider) {

      continue;

    }

    const list = buckets.get(provider) ?? [];
    list.push(assistant);
    buckets.set(provider, list);

  }

  return PROVIDERS.filter((provider) => buckets.has(provider)).map((provider) => ({

      provider,
      models: (buckets.get(provider) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),

    }));

}
