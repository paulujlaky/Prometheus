import type { ReactNode } from "react";
import { Streamdown } from "streamdown";

import { cn } from "@/Utils/Class";

/**
 * Tiny inline markdown for step labels (bold / italic / code / links).
 */
function renderInline(text: string): ReactNode[] {

  // split on **bold**, *italic*, `code`, [label](url)
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern);
  const out: ReactNode[] = [];

  for (let i = 0; i < parts.length; i += 1) {

    const part = parts[i];

    if (!part) {

      continue;

    }

    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {

      out.push(<strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>);
      continue;

    }

    if (part.startsWith("*") && part.endsWith("*") && part.length > 2 && !part.startsWith("**")) {

      out.push(<em key={i}>{part.slice(1, -1)}</em>);
      continue;

    }

    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {

      out.push(

        <code key={i} className="rounded bg-muted/70 px-1 py-0.5 font-mono text-[0.85em]">

          {part.slice(1, -1)}

        </code>,

      );
      continue;

    }

    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);

    if (link) {

      out.push(

        <a className="text-primary underline"

          key={i}
          href={link[2]}

          onClick={(e) => e.stopPropagation()}

        >

          {link[1]}

        </a>,

      );
      continue;

    }

    out.push(part);

  }

  return out;

}

/** Lightweight markdown for model prose (labels, freeform replies, done summaries). */
export function Md({ children, className, inline }: { children: string; className?: string; inline?: boolean }) {

  if (!children) {

    return null;

  }

  if (inline) {

    return (

      <span className={cn(

        "min-w-0 truncate text-sm leading-snug text-foreground/90",
        "[&_strong]:font-semibold [&_strong]:text-foreground",
        className,

      )}>

        {renderInline(children)}

      </span>

    );

  }

  return (

    <div className={cn(

      "min-w-0 text-sm leading-relaxed wrap-break-word",
      "[&_p]:my-0 [&_p+p]:mt-2",
      "[&_strong]:font-semibold",
      "[&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
      "[&_ul]:my-1 [&_ul]:list-inside [&_ul]:list-disc [&_ul]:pl-0",
      "[&_ol]:my-1 [&_ol]:list-inside [&_ol]:list-decimal [&_ol]:pl-0",
      "[&_li]:pl-[1.35em] [&_li]:-indent-[1.35em]",
      "[&_li_p]:inline [&_li>ul]:indent-0 [&_li>ol]:indent-0",
      "[&_a]:text-primary [&_a]:underline",
      className,

    )}>

      <Streamdown>{children}</Streamdown>

    </div>

  );

}
