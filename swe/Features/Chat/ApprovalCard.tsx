import { PlayIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { ActionButton, PromptBody, PromptCard, PromptFooter, PromptHeader, PromptIcon } from "@/UI/Prompt";

import type { Approval } from "@/Types/Bridge";

interface ApprovalCardProps {

  approval: Approval;
  onResolve: (ok: boolean) => void;

}

export function ApprovalCard({ approval, onResolve }: ApprovalCardProps) {

  return (

    <PromptCard>

      <PromptHeader>

        {approval.reason ? (

          <PromptIcon tone="red"><TriangleAlertIcon className="size-3.5" strokeWidth={2.5} /></PromptIcon>

        ) : null}

        <span className="text-[14px] font-medium text-ink">

          {approval.reason ? `Looks destructive — ${approval.reason}` : "Run this command?"}

        </span>

      </PromptHeader>

      <PromptBody>

        <pre className="max-h-32 overflow-y-auto font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap text-ink-2">

          {approval.command}

        </pre>

      </PromptBody>

      <PromptFooter>

        <ActionButton onClick={() => onResolve(false)}>

          <XIcon className="size-4" />
          Skip

        </ActionButton>

        <ActionButton tone={approval.reason ? "danger" : "primary"} onClick={() => onResolve(true)}>

          <PlayIcon className="size-4 fill-current" />
          Run

        </ActionButton>

      </PromptFooter>

    </PromptCard>

  );

}
