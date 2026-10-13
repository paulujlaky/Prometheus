export type CardBlock = (

  | { type: "text"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "metric"; label: string; value: string; detail?: string }
  | { type: "image"; url: string; alt: string }
  | { type: "link"; url: string; label: string }
  | { type: "section"; title?: string; blocks: CardBlock[] }

) & { icon?: string };

export interface Card {

  title?: string;
  icon?: string;
  blocks: CardBlock[];
  actions?: { label: string; reply: string; icon?: string }[];
  fields?: { name: string; label: string; placeholder?: string; required?: boolean; multiline?: boolean }[];
  submit?: string;

}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const validIcon = (value: unknown): boolean => value === undefined || value === "" || (typeof value === "string" && value.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value));

export function webURL(value: unknown): value is string {

  if (typeof value !== "string" || !/^https?:\/\//.test(value)) {

    return false;

  }

  try {

    const url = new URL(value);

    return Boolean(url.hostname) && !url.username && !url.password;

  } catch {

    return false;

  }

}

export function parseCard(source: string): Card | null {

  if (new TextEncoder().encode(source).length > 65536) {

    return null;

  }

  try {

    const card: unknown = JSON.parse(source);
    let count = 0;

    const blocks = (value: unknown, depth = 0): boolean => {

      if (!Array.isArray(value) || !value.length || depth > 3) {

        return false;

      }

      return value.every((block: unknown) => {

        if (!object(block) || !validIcon(block.icon) || ++count > 100) {

          return false;

        }

        switch (block.type) {

          case "text": return text(block.text);
          case "list": return strings(block.items) && block.items.length > 0 && block.items.length <= 100;
          case "table": return strings(block.columns) && block.columns.length > 0 && block.columns.length <= 12 && Array.isArray(block.rows) && block.rows.length <= 100 && block.rows.every((row) => strings(row) && row.length === (block.columns as string[]).length);
          case "metric": return text(block.label) && text(block.value) && (block.detail === undefined || typeof block.detail === "string");
          case "image": return webURL(block.url) && text(block.alt);
          case "link": return webURL(block.url) && text(block.label);
          case "section": return (block.title === undefined || typeof block.title === "string") && blocks(block.blocks, depth + 1);
          default: return false;

        }

      });

    };

    if (!object(card) || !validIcon(card.icon) || !blocks(card.blocks) || (card.title !== undefined && typeof card.title !== "string") || (card.submit !== undefined && typeof card.submit !== "string")) {

      return null;

    }

    if (card.actions !== undefined && (!Array.isArray(card.actions) || card.actions.length > 8 || !card.actions.every((action: unknown) => object(action) && text(action.label) && text(action.reply) && validIcon(action.icon)))) {

      return null;

    }

    const names = new Set<string>();

    if (card.fields !== undefined && (!Array.isArray(card.fields) || card.fields.length > 12 || !card.fields.every((field: unknown) => {

      if (!object(field) || !text(field.name) || !text(field.label) || names.has(field.name) || (field.placeholder !== undefined && typeof field.placeholder !== "string") || (field.required !== undefined && typeof field.required !== "boolean") || (field.multiline !== undefined && typeof field.multiline !== "boolean")) {

        return false;

      }

      names.add(field.name);

      return true;

    }))) {

      return null;

    }

    return card as unknown as Card;

  } catch {

    return null;

  }

}

export function cardReply(card: Card, values: FormData): string {

  return [card.title || "Form response", ...(card.fields ?? []).map((field) => `${field.label}: ${String(values.get(field.name) ?? "").trim()}`)].join("\n");

}
