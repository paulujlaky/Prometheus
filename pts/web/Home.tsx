import { Plus, Settings } from "lucide-react";

import { Torch } from "./ui";

import type { Account, Agent, GroupMessage } from "./api";

interface HomeProps {

  agents: Agent[];
  lastGroup: GroupMessage | null;

  account: Account;

  /** Highlighted row when the list sits beside the chat on wide screens. */
  selected: string;

}

const STATUS: Record<Agent["state"], string> = {

  waiting: "Needs you",
  running: "Working…",
  queued: "Queued",
  idle: "Idle",

};

function Row({ href, title, status, strong, selected }: { href: string; title: string; status: string; strong?: boolean; selected: boolean }) {

  return (

    <a href={href} aria-current={selected ? "page" : undefined} className={`flex items-baseline gap-3 px-6 py-3.5 no-underline ${selected ? "bg-panel" : ""}`}>

      <span className="shrink-0 font-medium">{title}</span>
      <span className={`ml-auto min-w-0 truncate text-[14px] ${strong ? "text-fg" : "text-dim"}`}>{status}</span>
      {strong && <span className="size-2 shrink-0 self-center rounded-full bg-fg" aria-hidden="true" />}

    </a>

  );

}

export function Home({ agents, lastGroup, account, selected }: HomeProps) {

  const waiting = agents.filter((agent) => agent.state === "waiting");
  const who = account.name ?? account.email ?? "Boodle account";

  return (

    <div className="flex h-full flex-col">

      <div className="grow overflow-y-auto">

        <header className="flex items-center gap-3 pt-[max(20px,env(safe-area-inset-top))] pr-3 pl-6">

          <Torch size={32} />
          <span className="grow font-serif text-[24px]">Prometheus</span>
          <a href="#/new" aria-label="New agent" title="New agent" className="flex size-11 items-center justify-center rounded-xl text-fg"><Plus size={22} strokeWidth={1.6} /></a>

        </header>

        {!account.set && (

          <a href="#/settings" className="mx-4 mt-8 flex flex-col gap-1 rounded-2xl bg-panel p-5 no-underline">

            <span className="text-[14px] text-dim">One thing first</span>
            <span className="font-serif text-[21px] leading-snug">Connect your Boodle account so agents can think.</span>

          </a>

        )}

        {waiting.map((agent) => (

          <a key={agent.id} href={`#/agent/${agent.id}`} className="mx-4 mt-8 flex flex-col gap-4 rounded-2xl bg-panel p-5 no-underline">

            <span className="flex flex-col gap-1.5">

              <span className="text-[14px] text-dim">{agent.name} needs your OK</span>
              <span className="font-serif text-[21px] leading-snug">{agent.question?.split("\n")[0] ?? "Approve an action"}</span>

            </span>

            <span className="flex h-11 items-center self-start rounded-xl bg-fg px-5 text-[15px] font-medium text-ink">Review</span>

          </a>

        ))}

        <nav aria-label="Agents" className="mt-8 flex flex-col">

          {agents.map((agent) => (

            <Row key={agent.id} href={`#/agent/${agent.id}`} title={agent.name} status={STATUS[agent.state]} strong={agent.state === "waiting"} selected={selected === `agent/${agent.id}`} />

          ))}

          {!agents.length && (

            <a href="#/new" className="mx-6 flex flex-col gap-1 py-3 no-underline">

              <span className="font-serif text-[21px]">No agents yet.</span>
              <span className="text-[15px] text-dim">Create one — give it a name and a model.</span>

            </a>

          )}

          <div className="mx-6 my-2 h-px bg-line" />

          <Row href="#/group" title="Everyone" status={lastGroup ? lastGroup.text.replace(/\s+/g, " ") : "Talk to all at once"} selected={selected === "group"} />

        </nav>

      </div>

      <a href="#/settings" aria-current={selected === "settings" ? "page" : undefined} className={`flex shrink-0 items-center gap-3 border-t border-line px-6 py-3.5 pb-[max(14px,env(safe-area-inset-bottom))] no-underline ${selected === "settings" ? "bg-panel" : ""}`}>

        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-[14px]" aria-hidden="true">{account.set ? who[0].toUpperCase() : "?"}</span>

        <span className="flex min-w-0 grow flex-col leading-tight">

          <span className="truncate text-[14px]">{account.set ? who : "Not connected"}</span>
          {account.set && account.email && account.name && <span className="truncate text-[12px] text-dim">{account.email}</span>}

        </span>

        <Settings size={18} strokeWidth={1.6} className="shrink-0 text-dim" aria-label="Settings" />

      </a>

    </div>

  );

}
