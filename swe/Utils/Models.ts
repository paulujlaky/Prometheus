import type { AssistantSummary, CustomModel } from "../../sdk/types";

export const AGENT_MODEL_PREFIX = "agent:";

export function agentModelId(llmId: string): string {

  return `${AGENT_MODEL_PREFIX}${llmId}`;

}

export function isAgentModelId(id: string | null | undefined): boolean {

  return Boolean(id && id.startsWith(AGENT_MODEL_PREFIX));

}

export function llmIdFromAgentModel(id: string): string {

  return id.slice(AGENT_MODEL_PREFIX.length);

}

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

/** Picks based off of the native 'bot' capability being available */
export function modelLabel(assistant: Pick<AssistantSummary, "name" | "kind"> & { id?: string }): string {

  const provider = providerOf(assistant as AssistantSummary);
  const agent = assistant.kind === "agent" ? " · Agent" : "";

  return `${provider ? `${provider} · ` : ""}${displayName(assistant.name)}${agent}`;

}

/** Turns a model name like "GPT 5.6 (Sol)" to "GPT 5.6 Sol" so labels match everywhere. */
export function displayName(name: string): string {

  return name.replace(/\s*\(([^)]*)\)\s*/g, " $1 ") .replace(/\s+/g, " ").trim();

}

/** Prefers catalog contextLength; falls back to family heuristics. */
export function contextLimitOf(assistant: Pick<AssistantSummary, "name" | "alias" | "description" | "contextLength"> | string | null | undefined): number {

  if (assistant && typeof assistant === "object" && typeof assistant.contextLength === "number" && assistant.contextLength > 0) {

    return assistant.contextLength;

  }

  const name = typeof assistant === "string" ? assistant : [assistant?.name, assistant?.alias, assistant?.description].filter(Boolean).join(" ");

  if (!name) {

    return 128_000; // 128k for all unknowns

  }

  // Gemini long-context family
  if (/\bgemini\b/i.test(name)) {

    if (/\b(1\.5|2\.0|2\.5|pro|flash|ultra)\b/i.test(name)) {

      return 1_000_000; // 1M for Gemini models

    }

    return 128_000; // 128k otherwise

  }

  // Anthropic — most Claude 3/4 chat models are 200k
  if (/\b(claude|anthropic|sonnet|opus|haiku)\b/i.test(name)) {

    if (/\b(1m|1000k|million)\b/i.test(name)) {

      return 1_000_000; // 1M for Claude 3/4 long-context

    }

    return 200_000; // 200k based on Claude 3/4 chat models. Claude 5 however is always 1M tok

  }

  // OpenAI flagships: many GPT-4.1 / 5.x are 128k–400k; use 128k as the conservative default
  if (/\b(openai|chatgpt|gpt[\s-]?[0-9]|o[1-9]\b)\b/i.test(name)) {

    if (/\b(4\.1|o3|o4|128k|200k)\b/i.test(name)) {

      return 128_000; // GPT has bad context length

    }

    if (/\b(400k|1m)\b/i.test(name)) {

      return 400_000; // except for these

    }

    return 128_000; // and these...

  }

  if (/\b(mistral|codestral|mixtral)\b/i.test(name)) {

    return 128_000;

  }

  if (/\b(llama|meta)\b/i.test(name)) {

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
  chat: AssistantSummary[];
  agent: AssistantSummary[];

}

function sortByName(models: AssistantSummary[]): AssistantSummary[] {

  return models.slice().sort((a, b) => a.name.localeCompare(b.name));

}

function isCatalogChat(assistant: AssistantSummary): boolean {

  if (assistant.kind === "agent") {

    return false;

  }

  if (assistant.assistantType && assistant.assistantType !== "SystemCreated") {

    return false;

  }

  if (/^Boombox Agent\b/i.test(assistant.name)) {

    return false;

  }

  return true;

}

/** Catalog chat models plus custom-bot (agent-native) rows, tagged for the picker. */
export function mergeModelLists(assistants: AssistantSummary[], custom: CustomModel[]): AssistantSummary[] {

  const chat = assistants.filter(isCatalogChat).map((assistant) => ({

    ...assistant,
    kind: "chat" as const,

  }));

  const seen = new Set(chat.map((assistant) => assistant.id));
  const agent: AssistantSummary[] = [];

  for (const model of custom) {

    const id = agentModelId(model.id);

    if (seen.has(id)) {

      continue;

    }

    seen.add(id);

    agent.push({

      id,
      name: model.name,

      kind: "agent",

      api: model.api,
      model: model.model,

      contextLength: model.contextLength,
      maxTokens: model.maxTokens,

      premiumCategory: model.premiumCategory,

    });

  }

  return [...chat, ...agent];

}

/** Keep only major-provider models, grouped for the submenu picker. */
export function groupAssistants(assistants: AssistantSummary[]): ProviderGroup[] {

  const chatBuckets = new Map<Provider, AssistantSummary[]>();
  const agentBuckets = new Map<Provider, AssistantSummary[]>();

  for (const assistant of assistants) {

    const provider = providerOf(assistant);

    if (!provider) {

      continue;

    }

    const buckets = assistant.kind === "agent" ? agentBuckets : chatBuckets;
    const list = buckets.get(provider) ?? [];

    list.push(assistant);
    buckets.set(provider, list);

  }

  return PROVIDERS.filter((provider) => chatBuckets.has(provider) || agentBuckets.has(provider)).map((provider) => ({

    provider,

    chat: sortByName(chatBuckets.get(provider) ?? []),
    agent: sortByName(agentBuckets.get(provider) ?? []),

  }));

}

export function filterAssistantGroups(assistants: AssistantSummary[], query: string): { provider: Provider; models: AssistantSummary[] }[] {

  const needle = query.trim().toLowerCase();

  return groupAssistants(assistants).map((group) => ({

      provider: group.provider,

      models: [...group.chat, ...group.agent].filter((assistant) => (
        !needle
        || displayName(assistant.name).toLowerCase().includes(needle)
        || group.provider.toLowerCase().includes(needle)
      )),


    })).filter((group) => group.models.length > 0);

}
