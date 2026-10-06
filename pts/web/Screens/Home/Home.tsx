import { Plus, Search, Settings, UserPlus, Users } from "lucide-react";
import { Fragment, type MouseEvent, type ReactNode } from "react";

import { EveryoneGlyph, Glyph, GroupGlyph } from "../../Components/Glyph/Glyph";
import { Torch } from "../../Components/Layout";

import type { Account, Agent, GroupChat } from "../../Lib/api";

interface HomeProps {

  agents: Agent[];
  groups: GroupChat[];

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

    <a href={href} aria-current={selected ? "page" : undefined} className={`mx-2 flex items-center gap-3 rounded-xl px-3 py-2.5 no-underline ${selected ? "bg-panel" : ""}`}>

      {icon}
      <span className="min-w-0 truncate font-medium">{title}</span>
      <span className={`ml-auto shrink-0 text-[14px] ${strong ? "text-fg" : "text-dim"}`}>{status}</span>
      {strong && <span className="size-1.5 shrink-0 self-center rounded-full bg-fg animate-pulse" aria-hidden="true" />}

    </a>

  );

}

function unread(count: number): string {

  return `${count} new message${count === 1 ? "" : "s"}`;

}

// the popover sits in the top layer, so it is placed under the button by hand
function placeMenu(event: MouseEvent<HTMLButtonElement>) {

  const { bottom, right } = event.currentTarget.getBoundingClientRect();
  const menu = document.getElementById("new-menu")!;

  menu.style.top = `${bottom + 6}px`;
  menu.style.left = `${right}px`;

}

export function Home({ agents, groups, account, selected }: HomeProps) {

  const who = account.name ?? account.email ?? "Boodle account";
  const categories = [...new Set(agents.map((agent) => agent.category))].sort();

  return (

    <div className="flex h-full flex-col">

      <div className="grow overflow-y-auto">

        <header className="flex items-center gap-3 pt-[max(20px,env(safe-area-inset-top))] pr-3 pl-6">

          <Torch size={32} />
          <span className="grow font-serif text-[24px]">Prometheus</span>

          <a href="#/search" aria-label="Search conversations" title="Search conversations" className="flex size-11 items-center mb-0.5 pl-4 justify-center rounded-xl text-fg hover:text-fg"><Search size={20} /></a>
          <button type="button" popoverTarget="new-menu" onClick={placeMenu} aria-label="New" title="New" className="flex size-11 items-center justify-center rounded-xl text-fg"><Plus size={22} strokeWidth={1.6} /></button>

          <div id="new-menu" popover="auto" onClick={(event) => event.currentTarget.hidePopover()} className="m-0 -translate-x-full rounded-xl border border-line bg-panel p-1 text-fg shadow-[0_16px_40px_rgb(0_0_0/0.5)]">

            <nav className="flex flex-col">

              <a href="#/new" className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[15px] whitespace-nowrap no-underline hover:bg-raised"><UserPlus size={16} strokeWidth={1.6} className="text-dim" />New agent</a>
              <a href="#/new/group" className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[15px] whitespace-nowrap no-underline hover:bg-raised"><Users size={16} strokeWidth={1.6} className="text-dim" />New group chat</a>

            </nav>

          </div>

        </header>

        {!account.set && (

          <a href="#/settings" className="mx-4 mt-8 flex flex-col gap-1 rounded-2xl bg-panel p-5 no-underline">

            <span className="text-[14px] text-dim">One thing first</span>
            <span className="font-serif text-[21px] leading-snug">Connect your Boodle account so agents can think.</span>

          </a>

        )}

        <nav aria-label="Agents" className="mt-8 flex flex-col">

          {categories.map((category) => (

            <Fragment key={category}>

              {category && <span className="mx-6 mt-5 mb-1 truncate text-[13px] text-dim">{category}</span>}

              {agents.filter((agent) => agent.category === category).map((agent) => (

                <Row key={agent.id} href={`#/agent/${agent.id}`} icon={<Glyph glyph={agent.glyph} live={agent.state === "running" || agent.state === "waiting"} />} title={agent.name} status={agent.state !== "waiting" && agent.unread ? unread(agent.unread) : STATUS[agent.state]} strong={agent.state === "waiting" || agent.unread > 0} selected={selected === `agent/${agent.id}`} />

              ))}

            </Fragment>

          ))}

          {!agents.length && (

            <a href="#/new" className="mx-6 flex flex-col gap-1 py-3 no-underline">

              <span className="font-serif text-[21px]">No agents yet.</span>

            </a>

          )}

          <div className="mx-6 my-2 h-px bg-line" />

          {groups.map((group) => {

            const members = agents.filter((agent) => group.members.includes(agent.id));

            return (

              <Row
                key={group.id}
                href={group.id ? `#/group/${group.id}` : "#/group"}
                icon={group.id ? <GroupGlyph glyphs={members.map((agent) => agent.glyph)} /> : <EveryoneGlyph />}
                title={group.name}
                status={group.unread ? unread(group.unread) : `${group.id ? members.length : agents.length} online`}
                strong={group.unread > 0}
                selected={selected === `group/${group.id}`}
              />

            );

          })}

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
