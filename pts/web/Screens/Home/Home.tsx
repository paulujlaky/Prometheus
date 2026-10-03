import { Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";

import { EveryoneGlyph, Glyph } from "../../Components/Glyph/Glyph";
import { Torch } from "../../Components/Layout";

import type { Account, Agent } from "../../Lib/api";

interface HomeProps {

  agents: Agent[];

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

function Row({ href, icon, title, status, strong, selected }: { href: string; icon: ReactNode; title: string; status: string; strong?: boolean; selected: boolean }) {

  return (

    <a href={href} aria-current={selected ? "page" : undefined} className={`flex items-center gap-3 px-5 py-2.5 no-underline ${selected ? "bg-panel" : ""}`}>

      {icon}
      <span className="shrink-0 font-medium">{title}</span>
      <span className={`ml-auto min-w-0 truncate text-[14px] ${strong ? "text-fg" : "text-dim"}`}>{status}</span>
      {strong && <span className="size-1.5 shrink-0 self-center rounded-full bg-fg animate-pulse" aria-hidden="true" />}

    </a>

  );

}

export function Home({ agents, account, selected }: HomeProps) {

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

        <nav aria-label="Agents" className="mt-8 flex flex-col">

          {agents.map((agent) => (

            <Row key={agent.id} href={`#/agent/${agent.id}`} icon={<Glyph glyph={agent.glyph} live={agent.state === "running" || agent.state === "waiting"} />} title={agent.name} status={STATUS[agent.state]} strong={agent.state === "waiting"} selected={selected === `agent/${agent.id}`} />

          ))}

          {!agents.length && (

            <a href="#/new" className="mx-6 flex flex-col gap-1 py-3 no-underline">

              <span className="font-serif text-[21px]">No agents yet.</span>

            </a>

          )}

          <div className="mx-6 my-2 h-px bg-line" />

          <Row href="#/group" icon={<EveryoneGlyph />} title="Everyone" status={`${agents.length} online`} selected={selected === "group"} />

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
