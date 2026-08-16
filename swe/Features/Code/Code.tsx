import { Component } from "react";

import { langOf, tokenize, type ThemedToken } from "@/Utils/Highlight";
import { cn } from "@/Utils/Class";

import type { FileWrite, WriteLine } from "@/Agent/Parse";

interface CodeProps {

  code: string;
  lang?: string;

  /** Highlighting is skipped while a command is still streaming; the plain text is shown until it settles. */
  streaming?: boolean;

}

interface CodeState {

  lines: ThemedToken[][] | null;
  source: string;

}

const PRE = "m-0 w-full font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap";

function Tokens({ line }: { line: ThemedToken[] }) {

  return (

    <>

      {line.map((token, index) => (

        <span key={index} style={{ color: token.color }}>{token.content}</span>

      ))}

    </>

  );

}

export class Code extends Component<CodeProps, CodeState> {

  state: CodeState = { lines: null, source: "" };

  private token = 0;

  componentDidMount() {

    void this.highlight();

  }

  componentDidUpdate(prev: CodeProps) {

    if (prev.code !== this.props.code || prev.streaming !== this.props.streaming) {

      void this.highlight();

    }

  }

  componentWillUnmount() {

    this.token += 1;

  }

  private async highlight() {

    const { code, lang = "bash", streaming } = this.props;

    if (streaming || !code) {

      return;

    }

    const ticket = (this.token += 1);

    try {

      const lines = await tokenize(code, lang);

      if (ticket === this.token) {

        this.setState({ lines, source: code });

      }

    } catch (err) {

      // never silent: a broken highlighter used to look exactly like an unhighlightable language
      console.warn("highlight failed", err);

    }

  }

  render() {

    const { code } = this.props;
    const { lines, source } = this.state;

    if (!lines || source !== code) {

      return <pre className={PRE}>{code}</pre>;

    }

    return (

      <pre className={PRE}>

        {lines.map((line, index) => (

          <span key={index}>

            <Tokens line={line} />
            {index < lines.length - 1 && "\n"}

          </span>

        ))}

      </pre>

    );

  }

}

const MARKER: Record<WriteLine["kind"], string> = {

  add: "+",
  remove: "−",
  context: " ",
  gap: " ",

};

const ROW: Record<WriteLine["kind"], string> = {

  add: "bg-green-tint",
  remove: "bg-red-tint",
  context: "",
  gap: "",

};

interface WriteProps {

  write: FileWrite;

}

interface WriteState {

  tokens: ThemedToken[][] | null;

  /** The exact line texts `tokens` was produced from, so stale lines can be spotted per-line. */
  texts: string[];

}

const MAX_LINES = 500; // Rendered line budget — a 2000-line rewrite should not cost a frame.

const QUIET_MS = 160; // Quiet period before re-tokenizing, so a half-typed line is not what gets parsed.

const MAX_WAIT_MS = 700; // Ceiling on that wait — a stream that never pauses must still refresh.

/*
  A single file the agent wrote, shown as code rather than as the shell that produced it.
*/
export class FileWriteView extends Component<WriteProps, WriteState> {

  state: WriteState = { tokens: null, texts: [] };

  private token = 0;

  private pendingSince = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;

  componentDidMount() {

    // settled content (an expanded old step) should paint highlighted immediately, not after a delay
    void this.highlight();

  }

  componentDidUpdate(prev: WriteProps) {

    if (prev.write !== this.props.write) {

      this.schedule();

    }

  }

  componentWillUnmount() {

    this.token += 1;

    if (this.timer) {

      clearTimeout(this.timer);

    }

  }

  /*
    Re-tokenizes once the stream pauses, so the grammar sees whole lines rather than half-typed ones, but never stall past MAX_WAIT_MS on a steady stream.
  */
  private schedule() {

    const now = Date.now();

    if (this.pendingSince === 0) {

      this.pendingSince = now;

    }

    if (this.timer) {

      clearTimeout(this.timer);

    }

    const wait = Math.min(QUIET_MS, Math.max(0, MAX_WAIT_MS - (now - this.pendingSince)));

    this.timer = setTimeout(() => {

      this.timer = null;
      this.pendingSince = 0;

      void this.highlight();

    }, wait);

  }

  private get shown(): WriteLine[] {

    return this.props.write.lines.slice(0, MAX_LINES);

  }

  private async highlight() {

    const { write } = this.props;

    const texts = this.shown.map((line) => line.text);
    const source = texts.join("\n");

    if (!source.trim()) {

      return;

    }

    const ticket = (this.token += 1);

    try {

      const tokens = await tokenize(source, langOf(write.file));

      if (ticket === this.token) {

        this.setState({ tokens, texts });

      }

    } catch (err) {

      console.warn("highlight failed", err);

    }

  }

  render() {

    const { write } = this.props;
    const { tokens, texts } = this.state;

    const shown = this.shown;

    return (

      <div className="overflow-hidden rounded-chip border border-line bg-inset">

        <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">

          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{write.file}</span>

          {write.added > 0 ? <span className="shrink-0 font-mono text-[12px] text-green tabular-nums">+{write.added}</span> : null}
          {write.removed > 0 ? <span className="shrink-0 font-mono text-[12px] text-red tabular-nums">−{write.removed}</span> : null}

        </div>

        {write.kind === "delete" && !shown.length ? (

          <p className="px-2.5 py-2 font-mono text-[12.5px] text-ink-3">File deleted.</p>

        ) : (

          <div className="max-h-96 overflow-auto py-1">

            {shown.map((line, index) => {

              // A line keeps its colours until its own text changes, so the block never flashes.

              const known = texts[index];
              const stale = tokens?.[index];

              const grown = known !== undefined && stale !== undefined && line.text.startsWith(known);

              const highlighted = known === line.text || grown ? stale : undefined;
              const tail = grown && known !== line.text ? line.text.slice(known.length) : "";

              return (

                <div key={index} className={cn("flex min-h-[1.3rem] items-start", ROW[line.kind])}>

                  <span className={cn( "w-6 shrink-0 select-none text-center font-mono text-[12.5px] leading-[1.65]", line.kind === "add" ? "text-green" : line.kind === "remove" ? "text-red" : "text-ink-3/50", )} >

                    {MARKER[line.kind]}

                  </span>

                  <pre className={cn(PRE, "flex-1 pr-2.5")}>

                    {highlighted ? <><Tokens line={highlighted} />{tail}</> : line.text}

                  </pre>

                </div>

              );

            })}

            {write.lines.length > shown.length ? (

              <p className="px-2.5 py-1.5 font-mono text-[12px] text-ink-3">

                +{write.lines.length - shown.length} more lines

              </p>

            ) : null}

          </div>

        )}

      </div>

    );

  }

}
