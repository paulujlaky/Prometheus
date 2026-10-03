import { Fragment, use, type ReactNode } from "react";

import { withMentions } from "./Glyph/Mention";

import { AgentsContext } from "../App/context";
import type { Agent } from "../Lib/api";

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

function inline(text: string, agents: Agent[]): ReactNode[] {

  return text.split(INLINE).map((part, i) => {

    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {

      return <code key={i} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>;

    }

    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {

      return <strong key={i} className="font-medium">{part.slice(2, -2)}</strong>;

    }

    return <Fragment key={i}>{withMentions(part, agents, `${i}-`)}</Fragment>;

  });

}

/** Just enough markdown for what agents write: paragraphs, bullets, `code` and **bold**. */
export function Memo({ text, className = "" }: { text: string; className?: string }) {

  const agents = use(AgentsContext);

  // runs of bullet lines become lists even when a paragraph sits directly above them, as agents often write
  const runs: { list: boolean; lines: string[] }[] = [];

  for (const block of text.trim().split(/\n\s*\n/)) {

    const start = runs.length;

    for (const line of block.split("\n")) {

      const list = BULLET.test(line);
      const last = runs.length > start ? runs[runs.length - 1] : null;

      if (last?.list === list) {

        last.lines.push(line);
        continue;

      }

      runs.push({ list, lines: [line] });

    }

  }

  return (

    <div className={`flex flex-col gap-3 font-serif text-[18px] leading-relaxed ${className}`}>

      {runs.map((run, i) => {

        if (run.list) {

          return (

            <ul key={i} className="m-0 flex list-disc flex-col gap-1.5 pl-5 marker:text-dim">

              {run.lines.map((line, j) => <li key={j}>{inline(line.replace(BULLET, ""), agents)}</li>)}

            </ul>

          );

        }

        return <p key={i} className="m-0 whitespace-pre-line">{inline(run.lines.join("\n"), agents)}</p>;

      })}

    </div>

  );

}
