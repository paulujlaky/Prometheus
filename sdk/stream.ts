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

function isReasoningSection(sectionType: string): boolean {

  return sectionType.toLowerCase() === "reasoning";

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
  private errors: Extract<ContentBlock, { kind: "error" }>[] = [];

  private unknownSeq = 0;
  private progressSeq = 0;
  private errorSeq = 0;

  private lastError: string | null = null;
  private usage: import("./types").UsageBucket | null = null;

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
    this.errors = [];
    this.unknownSeq = 0;
    this.progressSeq = 0;
    this.errorSeq = 0;

    this.lastError = null;
    this.usage = null;

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
      reasoning: this.reasoningText(),

      blocks: this.blocks(),

      progress: this.latestProgress,

      links: [...this.links],

      error: this.lastError,

      usage: this.usage,

    };

  }

  /** Answer surface only — excludes reasoning so tool parsers stay clean. */
  fullText(): string {

    const parts: string[] = [];

    for (const index of this.sectionOrder) {

      const section = this.sections.get(index);

      // keep non-reasoning sections (Text, WebSearch, CodeExecution, …); drop chain-of-thought
      if (!section?.text || isReasoningSection(section.sectionType)) {

        continue;

      }

      parts.push(section.text);

    }

    return parts.join("\n\n");

  }

  /** Platform chain-of-thought sections only. */
  reasoningText(): string {

    const parts: string[] = [];

    for (const index of this.sectionOrder) {

      const section = this.sections.get(index);

      if (section?.text && isReasoningSection(section.sectionType)) {

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

      if (isReasoningSection(section.sectionType)) {

        out.push({

          kind: "reasoning",
          key: sectionKey(index),

          sectionType: section.sectionType,

          text: section.text,

          streaming: section.streaming,

        });

      } else {

        out.push({

          kind: "text",
          key: sectionKey(index),

          sectionType: section.sectionType,

          text: section.text,

          streaming: section.streaming,

        });

      }

    }

    for (const content of this.progressItems) {

      out.push({

        kind: "progress",
        key: `progress:${content}`,

        content,

      });

    }

    for (const link of this.links) {

      out.push(link);

    }

    for (const err of this.errors) {

      out.push(err);

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
      this.errors = [];
      this.progressItems = [];

      this.latestProgress = null;
      this.lastError = null;

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
    this.bindUsage(data);

    // final payload is authoritative. we must rebuild text/links from it.
    const changes = this.ingestParts(asPartArray(data.message), { replace: true });

    this.latestProgress = null;

    for (const section of this.sections.values()) {

      section.streaming = false;

    }

    if (this.lastError && !this.fullText()) {

      this.status = "error";
      changes.push({

        kind: "error",
        snapshot: this.snapshot(),

        content: this.lastError,

      });

    } else {

      this.status = "complete";
      changes.push({ kind: "complete", snapshot: this.snapshot() });

    }

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

  private bindUsage(data: WsData) {

    if (data.usage != null && typeof data.usage === "object") {

      this.usage = data.usage as import("./types").UsageBucket;

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

      case "Error":

        return this.onError(part);

      default:

        return this.onUnknownPart(part, type);

    }

  }

  private onSectionStart(part: RawPart): StreamChange[] {

    const index = num(part.index);

    if (index == null) {

      return [];

    }

    const sectionType = str(part.sectionType) ?? "Text";

    this.ensureSection(index, sectionType, true);

    return [{

      kind: "section",
      snapshot: this.snapshot(),

      sectionKey: sectionKey(index),
      sectionType,

    }];

  }

  private onStreamSection(part: RawPart): StreamChange[] {

    const index = num(part.index);

    if (index == null) {

      return [];

    }

    // preserve an existing Reasoning/Text type; only default when the section is new
    const existing = this.sections.get(index);
    const section = this.ensureSection(index, existing?.sectionType ?? "Text", true);
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
      const seq = num(rec.seq);

      // empty content with seq -1 is the section end marker, not a text delta
      if (!piece) {

        if (seq === -1) {

          section.streaming = false;

        }

        continue;

      }

      section.text += piece;
      section.streaming = true;

      changes.push({

        kind: "delta",
        sectionKey: sectionKey(index),

        sectionType: section.sectionType,

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

      sectionType,

    }];

  }

  private onError(part: RawPart): StreamChange[] {

    const content = str(part.content) ?? extractText(part.content) ?? "Something went wrong.";
    const opcode = num(part.opcode) ?? undefined;

    this.lastError = content;
    this.errorSeq += 1;

    const block: Extract<ContentBlock, { kind: "error" }> = {

      kind: "error",
      key: `error:${this.errorSeq}`,

      content,
      opcode,

    };

    this.errors.push(block);
    this.status = "error";

    return [{

      kind: "error",
      snapshot: this.snapshot(),

      content,
      opcode,

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

        sectionType: section.sectionType,

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
