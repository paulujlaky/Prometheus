import type { ContentBlock, RawPart, ResponseSnapshot, StreamChange, WsData, WsEnvelope, } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {

  if (value != null && typeof value === "object" && !Array.isArray(value)) {

    return value as Record<string, unknown>;

  }

  return null;

}

function asPartArray(value: unknown): RawPart[] {

  if (!Array.isArray(value)) {

    return [];

  }

  return value.filter((item): item is RawPart => asRecord(item) != null);

}

// Pulls human-readable text out of nested content arrays (PlainText, Stream, ...)
export function extractText(content: unknown): string {

  if (typeof content === "string") {

    return content;

  }

  if (!Array.isArray(content)) {

    const rec = asRecord(content);

    if (rec && typeof rec.content === "string") {

      return rec.content;

    }

    return "";

  }

  let out = "";

  for (const item of content) {

    if (typeof item === "string") {

      out += item;
      continue;

    }

    const rec = asRecord(item);

    if (!rec) {

      continue;

    }

    const t = rec.type;

    if (t === "PlainText" || t === "Stream" || t === undefined || typeof rec.content === "string") {

      if (typeof rec.content === "string") {

        out += rec.content;

      }

    }

  }

  return out;

}

function sectionKey(index: number | string): string {

  return `section:${index}`;

}

function linkKey(url: string, title: string): string {

  return `link:${url || title}`;

}

interface SectionState {

  index: number;
  sectionType: string;

  text: string;

  streaming: boolean;

}

// Pure assembler for one assistant generation (one submissionId). Accepts incremental WS parts and full history `responses` arrays
export class ResponseStream {

  readonly chatId: string;

  submissionId: string | null;
  assistantId: string | null = null;
  status: ResponseSnapshot["status"] = "idle";

  private sections = new Map<number, SectionState>();
  private sectionOrder: number[] = [];

  private progressItems: string[] = [];
  private latestProgress: string | null = null;

  private links: Extract<ContentBlock, { kind: "link" }>[] = [];

  private unknowns: Extract<ContentBlock, { kind: "unknown" }>[] = [];

  private unknownSeq = 0;
  private progressSeq = 0;

  constructor(chatId: string, submissionId: string | null = null) {

    this.chatId = chatId;
    this.submissionId = submissionId;

  }

  static fromHistory(chatId: string, parts: RawPart[], meta: { submissionId?: string | null; assistantId?: string | null; complete?: boolean; } = {}): ResponseStream {

    const stream = new ResponseStream(chatId, meta.submissionId ?? null);

    stream.assistantId = meta.assistantId ?? null;

    stream.ingestParts(parts, { replace: true });
    stream.status = meta.complete === false ? "streaming" : "complete";

    return stream;

  }

  reset() {

    this.sections.clear();

    this.sectionOrder = [];
    this.progressItems = [];

    this.latestProgress = null;

    this.links = [];

    this.unknowns = [];
    this.unknownSeq = 0;
    this.progressSeq = 0;

    this.status = "idle";

    this.assistantId = null;

  }

  snapshot(): ResponseSnapshot {

    return {

      chatId: this.chatId,

      submissionId: this.submissionId,
      assistantId: this.assistantId,

      status: this.status,

      text: this.fullText(),
      blocks: this.blocks(),

      progress: this.latestProgress,

      links: [...this.links],

    };

  }

  fullText(): string {

    const parts: string[] = [];

    for (const index of this.sectionOrder) {

      const section = this.sections.get(index);

      if (section?.text) {

        parts.push(section.text);

      }

    }

    return parts.join("\n\n");

  }

  blocks(): ContentBlock[] {

    const out: ContentBlock[] = [];

    for (const index of this.sectionOrder) {

      const section = this.sections.get(index);

      if (!section) {

        continue;

      }

      out.push({

        kind: "text",
        key: sectionKey(index),

        sectionType: section.sectionType,

        text: section.text,

        streaming: section.streaming,

      });

    }

    for (const content of this.progressItems) {

      // we need only include the latest progress item in the snapshot, but we keep all items in the stream for history

      out.push({

        kind: "progress",
        key: `progress:${content}`,

        content,

      });

    }

    for (const link of this.links) {

      out.push(link);

    }

    for (const unknown of this.unknowns) {

      out.push(unknown);

    }

    return out;

  }

  handleEnvelope(envelope: WsEnvelope): StreamChange[] {

    return this.handleData(envelope.data);

  }

  handleData(data: WsData): StreamChange[] {

    const type = data.type;
    const chatId = typeof data.chatId === "string" ? data.chatId : this.chatId;

    if (chatId && chatId !== this.chatId) {

      return [];

    }

    if (type === "MessageSubmission") {

      return this.onSubmission(data);

    }

    if (type === "MessageIncrementalResponse") {

      return this.onIncremental(data);

    }

    if (type === "MessageFinalResponse") {

      return this.onFinal(data);

    }

    return [{ kind: "unknown", snapshot: this.snapshot(), data }];

  }

  // Ingests a batch of parts, optionally replacing existing state. Returns a list of changes that occurred.
  ingestParts( parts: RawPart[], options: { replace?: boolean } = {}, ): StreamChange[] {

    if (options.replace) {

      this.sections.clear();

      this.sectionOrder = [];
      this.links = [];

      this.unknowns = [];
      this.progressItems = [];

      this.latestProgress = null;

    }

    const changes: StreamChange[] = [];

    for (const part of parts) {

      changes.push(...this.applyPart(part));

    }

    return changes;

  }

  private onSubmission(data: WsData): StreamChange[] {

    const submissionId = str(data.submissionId) ?? str(data.id) ?? this.submissionId;

    this.reset();

    this.submissionId = submissionId;
    this.assistantId = str(data.assistantId);
    this.status = "streaming";

    const message = asRecord(data.message);
    const userText = message ? extractText(message) || extractText(message.content) : undefined;

    return [{

      kind: "started",

      snapshot: this.snapshot(),
      userText: userText || undefined,

    }];

  }

  private onIncremental(data: WsData): StreamChange[] {

    this.bindMeta(data);
    this.status = "streaming";

    return this.ingestParts(asPartArray(data.message));

  }

  private onFinal(data: WsData): StreamChange[] {

    this.bindMeta(data);

    // final payload is authoritative. we must rebuild text/links from it.
    const changes = this.ingestParts(asPartArray(data.message), { replace: true });

    this.status = "complete";
    this.latestProgress = null;

    // we can now mark all text sections as non-streaming
    for (const section of this.sections.values()) {

      section.streaming = false;

    }

    changes.push({ kind: "complete", snapshot: this.snapshot() });

    return changes;

  }

  private bindMeta(data: WsData) {

    const submissionId = str(data.submissionId);

    if (submissionId) {

      this.submissionId = submissionId;

    }

    if ("assistantId" in data) {

      this.assistantId = str(data.assistantId);

    }

  }

  private applyPart(part: RawPart): StreamChange[] {

    const type = String(part.type ?? "Unknown");

    switch (type) {

      case "StreamSectionStart":

        return this.onSectionStart(part);

      case "StreamSection":

        return this.onStreamSection(part);

      case "SectionResponse":

        return this.onSectionResponse(part);

      case "Progress":

        return this.onProgress(part);

      case "Link":

        return this.onLink(part);

      default:

        return this.onUnknownPart(part, type);

    }

  }

  private onSectionStart(part: RawPart): StreamChange[] {

    const index = num(part.index);

    if (index == null) {

      return [];

    }

    this.ensureSection(index, str(part.sectionType) ?? "Text", true);

    return [{ kind: "section", snapshot: this.snapshot(), sectionKey: sectionKey(index) }];

  }

  private onStreamSection(part: RawPart): StreamChange[] {

    const index = num(part.index);

    if (index == null) {

      return [];

    }

    const section = this.ensureSection(index, "Text", true);
    const changes: StreamChange[] = [];
    const chunks = Array.isArray(part.content) ? part.content : [];

    for (const chunk of chunks) {

      const rec = asRecord(chunk);

      if (!rec) {

        continue;

      }

      // we still prefer typed Stream chunks, but can still accept plain content strings.
      if (rec.type != null && rec.type !== "Stream" && typeof rec.content !== "string") {

        continue;

      }

      const piece = typeof rec.content === "string" ? rec.content : "";

      if (!piece) {

        continue;

      }

      section.text += piece;
      section.streaming = true;

      changes.push({

        kind: "delta",
        sectionKey: sectionKey(index),

        snapshot: this.snapshot(),
        text: piece,

      });

    }

    return changes;

  }

  private onSectionResponse(part: RawPart): StreamChange[] {

    const index = num(part.index) ?? this.sectionOrder.length;

    const sectionType = str(part.sectionType) ?? "Text";
    const section = this.ensureSection(index, sectionType, false);

    const text = extractText(part.content);

    section.text = text;
    section.sectionType = sectionType;
    section.streaming = false;

    return [{

      kind: "section",

      snapshot: this.snapshot(),
      sectionKey: sectionKey(index),

    }];

  }

  private onProgress(part: RawPart): StreamChange[] {

    const content = str(part.content) ?? extractText(part.content) ?? "";

    if (!content) {

      return [];

    }

    this.latestProgress = content;

    if (!this.progressItems.includes(content)) {

      this.progressItems.push(content);

    } else {

      // we should refresh order and move to end as "latest"

      this.progressItems = this.progressItems.filter((p) => p !== content);
      this.progressItems.push(content);

    }

    this.progressSeq += 1;

    return [{

      kind: "progress",

      snapshot: this.snapshot(),
      content,

    }];

  }

  private onLink(part: RawPart): StreamChange[] {

    const title = str(part.title) ?? "";
    const url = str(part.url) ?? "";

    const linkType = str(part.linkType) ?? "Web";
    const key = linkKey(url, title);

    if (this.links.some((l) => l.key === key)) {

      return [];

    }

    const block: Extract<ContentBlock, { kind: "link" }> = { kind: "link", key, title, url, linkType };

    this.links.push(block);

    return [{ kind: "block", snapshot: this.snapshot(), block }];

  }

  private onUnknownPart(part: RawPart, type: string): StreamChange[] {

    const maybeText = extractText(part.content); // If it looks like text content, we can surface it as a text block

    if (maybeText && (part.sectionType != null || part.index != null)) {

      const index = num(part.index) ?? Date.now();
      const section = this.ensureSection(index, str(part.sectionType) ?? type, false);

      section.text = maybeText;
      section.streaming = false;

      return [{

        kind: "section",

        snapshot: this.snapshot(),
        sectionKey: sectionKey(index),

      }];

    }

    this.unknownSeq += 1;

    const block: Extract<ContentBlock, { kind: "unknown" }> = {

      kind: "unknown",
      key: `unknown:${type}:${this.unknownSeq}`,

      type,
      raw: { ...part },

    };

    this.unknowns.push(block);

    return [{ kind: "block", snapshot: this.snapshot(), block }];

  }

  private ensureSection( index: number, sectionType: string, streaming: boolean, ): SectionState {

    let section = this.sections.get(index);

    if (!section) {

      section = {

        index,
        sectionType,

        text: "",
        streaming,

      };

      this.sections.set(index, section);
      this.sectionOrder.push(index);

    } else if (sectionType && section.sectionType === "Text" && sectionType !== "Text") {

      section.sectionType = sectionType;

    }

    if (streaming) {

      section.streaming = true;

    }

    return section;

  }

}

function str(value: unknown): string | null {

  if (typeof value === "string") {

    return value;

  }

  if (typeof value === "number" || typeof value === "boolean") {

    return String(value);

  }

  return null;

}

function num(value: unknown): number | null {

  if (typeof value === "number" && Number.isFinite(value)) {

    return value;

  }

  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {

    return Number(value);

  }

  return null;

}

// Kept for compatability with older imports
export class ResponseAssembler extends ResponseStream {

  constructor(chatId = "", submissionId: string | null = null) {

    super(chatId, submissionId);

  }

}
