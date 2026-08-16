import { Fragment } from "react";
import { CheckIcon } from "lucide-react";

import { cn } from "@/Utils/Class";
import { Elapsed } from "@/Features/Chat/Elapsed";

interface StatusBarProps {

  status: string;
  running: boolean;

  startedAt: number | null;
  diff: { added: number; removed: number };

}

export function StatusBar({ status, running, startedAt, diff }: StatusBarProps) {

  const hasDiff = diff.added > 0 || diff.removed > 0;

  return (

    <div className="flex justify-center pt-1 pb-4">

      <div className="flex w-fit items-center gap-2.5 rounded-full bg-field px-3.5 py-1.5 shadow-hairline">

        {status.startsWith("Done in ") ? <CheckIcon className="size-3.5 text-green" strokeWidth={3} /> : null}

        {status.split(" · ").map((part, index) => (

          <Fragment key={index}>

            {index > 0 ? <span className="text-[13px] text-ink-3">·</span> : null}

            <span className={cn(
              "text-[13px] font-medium",
              status === "Error" ? "text-red" : status.startsWith("Done in ") ? "text-green" : "text-ink-2",
            )}>

              {part}

            </span>

          </Fragment>

        ))}

        {running && hasDiff ? (

          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12.5px] tabular-nums">

            {diff.added > 0 ? <span className="text-green">+{diff.added}</span> : null}
            {diff.removed > 0 ? <span className="text-red">−{diff.removed}</span> : null}

          </span>

        ) : running && startedAt != null ? (

          <Elapsed since={startedAt} />

        ) : null}

      </div>

    </div>

  );

}
