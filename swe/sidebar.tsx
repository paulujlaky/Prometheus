import { Component, createRef, type MouseEvent as ReactMouseEvent } from "react";
import { EllipsisVerticalIcon, PencilIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SweChat {

  id: string;
  name: string;
  title: string;
  modified: number;

  /** Normalized project root when known; null/undefined = unassigned. */
  project?: string | null;

  /** Chat that spawned this row; set only while a subagent is running. */
  parentId?: string | null;

  /** A live subagent, not a real chat — it has no id on the server and vanishes when the child ends. */
  subagent?: boolean;

}

interface ContextMenu {

  x: number;
  y: number;
  chat: SweChat;

}

interface SidebarProps {

  chats: SweChat[];
  activeId: string | null;
  loading?: boolean;

  /** Active project folder (absolute). Null when none chosen — used to order/highlight that group. */
  projectDir: string | null;

  /** Chats with a live agent loop — marks a row the user has switched away from. */
  runningIds?: string[];

  onSelect: (chat: SweChat) => void;
  onRename: (chat: SweChat, name: string) => void;
  onDelete: (chat: SweChat) => void;
  onNew: () => void;
  onOpenSettings: () => void;

}

interface SidebarState {

  menu: ContextMenu | null;
  renameValue: string | null;
  hovered: string | null;
  box: { top: number; height: number } | null;

}

function displayTitle(chat: SweChat): string {

  return (chat.title || chat.name || "Untitled").trim() || "Untitled";

}

function relativeTime(ts: number): string {

  if (!ts) {

    return "";

  }

  // Boodle timestamps are often ms; if small, treat as seconds
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const delta = Date.now() - ms;

  if (delta < 60_000) {

    return "just now";

  }

  if (delta < 3_600_000) {

    return `${Math.floor(delta / 60_000)}m`;

  }

  if (delta < 86_400_000) {

    return `${Math.floor(delta / 3_600_000)}h`;

  }

  if (delta < 7 * 86_400_000) {

    return `${Math.floor(delta / 86_400_000)}d`;

  }

  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

}

function normalizeDir(path: string | null | undefined): string {

  if (!path) {

    return "";

  }

  let p = path.replace(/\\/g, "/");

  if (p.length > 3 && p.endsWith("/")) {

    p = p.replace(/\/+$/, "");

  }

  if (/^[a-zA-Z]:/.test(p)) {

    p = `${p[0].toUpperCase()}${p.slice(1)}`;

  }

  return p;

}

function folderLabel(path: string): string {

  const parts = path.split("/").filter(Boolean);

  return parts[parts.length - 1] || path || "Unknown";

}

/** Live subagents ride directly under the chat that spawned them, in the order they started. */
function nestSubagents(list: SweChat[]): SweChat[] {

  const kids = new Map<string, SweChat[]>();
  const rest: SweChat[] = [];

  for (const chat of list) {

    if (!chat.subagent) {

      rest.push(chat);
      continue;

    }

    const key = chat.parentId ?? "";
    const group = kids.get(key);

    if (group) {

      group.push(chat);

    } else {

      kids.set(key, [chat]);

    }

  }

  const out: SweChat[] = [];

  for (const chat of rest) {

    out.push(chat);

    for (const kid of kids.get(chat.id) ?? []) {

      out.push(kid);

    }

    kids.delete(chat.id);

  }

  // a run that has not been saved yet has no parent row to sit under, and losing the row is worse
  for (const orphans of kids.values()) {

    out.push(...orphans);

  }

  return out;

}

interface ChatGroup {

  key: string;
  label: string;
  title?: string;
  chats: SweChat[];
  current: boolean;

}

/** Group every project’s sessions by recency of their latest chat. Unknown last. */
function groupChats(chats: SweChat[], projectDir: string | null): ChatGroup[] {

  const buckets = new Map<string, SweChat[]>();

  for (const chat of chats) {

    const key = normalizeDir(chat.project ?? "");
    const list = buckets.get(key);

    if (list) {

      list.push(chat);

    } else {

      buckets.set(key, [chat]);

    }

  }

  for (const [key, list] of buckets) {

    list.sort((a, b) => b.modified - a.modified);

    buckets.set(key, nestSubagents(list));

  }

  const active = normalizeDir(projectDir);
  const groups: ChatGroup[] = [];

  const known = [...buckets.entries()].filter(([key]) => key !== "");

  // opening a chat must not reshuffle groups — only a newer modified time does
  known.sort((a, b) => {

    const delta = (b[1][0]?.modified ?? 0) - (a[1][0]?.modified ?? 0);

    return delta !== 0 ? delta : folderLabel(a[0]).localeCompare(folderLabel(b[0]));

  });

  for (const [key, list] of known) {

    groups.push({

      key,
      label: folderLabel(key),
      title: key,
      chats: list,
      current: key === active,

    });

  }

  const unknown = buckets.get("");

  if (unknown?.length) {

    groups.push({

      key: "",
      label: "Unknown",
      chats: unknown,
      current: false,

    });

  }

  return groups;

}

export class Sidebar extends Component<SidebarProps, SidebarState> {

  state: SidebarState = { menu: null, renameValue: null, hovered: null, box: null };

  private list = createRef<HTMLDivElement>();
  private menu = createRef<HTMLDivElement>();
  private renameInput = createRef<HTMLInputElement>();

  private rows = new Map<string, HTMLButtonElement>();

  componentDidMount() {

    window.addEventListener("mousedown", this.onPointerDown, true);
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("keydown", this.onKey);

    this.moveHighlight();

  }

  componentDidUpdate(_: SidebarProps, previousState: SidebarState) {

    this.moveHighlight();

    if (this.state.renameValue !== null && previousState.renameValue === null) {

      this.renameInput.current?.focus();
      this.renameInput.current?.select();

    }

  }

  componentWillUnmount() {

    window.removeEventListener("mousedown", this.onPointerDown, true);
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("keydown", this.onKey);

  }

  /** One pill glides between rows instead of each row toggling its own background. */
  private moveHighlight() {

    const container = this.list.current;
    const target = this.rows.get(this.state.hovered ?? this.props.activeId ?? "");

    if (!container || !target) {

      if (this.state.box) {

        this.setState({ box: null });

      }

      return;

    }

    const top = target.offsetTop;
    const height = target.offsetHeight;
    const box = this.state.box;

    if (box?.top !== top || box.height !== height) {

      this.setState({ box: { top, height } });

    }

  }

  private closeMenu = () => {

    if (this.state.menu) {

      this.setState({ menu: null, renameValue: null });

    }

  };

  /**
   * Dismiss on a press that landed outside the menu. Asking the menu whether it contains the
   * target beats relying on a stopPropagation deep in a React handler reaching window: the
   * click that opened the menu, and the click on Rename inside it, both used to close it.
   */
  private onPointerDown = (event: Event) => {

    if (!this.state.menu) {

      return;

    }

    const target = event.target as Node | null;

    if (target && this.menu.current?.contains(target)) {

      return;

    }

    this.closeMenu();

  };

  /** Focusing the rename input can scroll an ancestor, and that must not read as a dismissal. */
  private onScroll = () => {

    if (this.state.renameValue === null) {

      this.closeMenu();

    }

  };

  private onKey = (event: KeyboardEvent) => {

    if (event.key === "Escape") {

      this.closeMenu();

    }

  };

  private onContextMenu = (event: ReactMouseEvent, chat: SweChat) => {

    event.preventDefault();
    event.stopPropagation();

    this.setState({ menu: { x: event.clientX, y: event.clientY, chat }, renameValue: null });

  };

  private renameFromMenu = () => {

    const { menu } = this.state;

    if (!menu) {

      return;

    }

    this.setState({ renameValue: displayTitle(menu.chat) });

  };

  private submitRename = () => {

    const { menu, renameValue } = this.state;

    if (!menu || renameValue === null) {

      return;

    }

    const current = displayTitle(menu.chat);
    const name = renameValue.trim();

    this.setState({ menu: null, renameValue: null });

    if (!name || name === current) {

      return;

    }

    this.props.onRename(menu.chat, name);

  };

  private deleteFromMenu = () => {

    const { menu } = this.state;

    if (!menu) {

      return;

    }

    this.setState({ menu: null, renameValue: null });
    this.props.onDelete(menu.chat);

  };

  private setRowRef = (id: string, node: HTMLButtonElement | null) => {

    if (node) {

      this.rows.set(id, node);

    } else {

      this.rows.delete(id);

    }

  };

  /** Not a button: there is no chat to open, and it must not steal the hover pill from real rows. */
  private renderSubagentRow = (chat: SweChat) => {

    return (

      <div key={chat.id} className="relative z-10 flex w-full items-center gap-2 py-1.5 pl-6 pr-2" title={chat.title}>

        <span className="size-1.5 shrink-0 rounded-full bg-ink" style={{ animation: "pixel-on 1200ms ease-in-out infinite" }} />

        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{chat.title}</span>

      </div>

    );

  };

  private renderChatRow = (chat: SweChat) => {

    const { activeId, onSelect, runningIds } = this.props;
    const { menu } = this.state;

    const active = chat.id === activeId;
    const hovered = this.state.hovered === chat.id;
    const menuFor = menu?.chat.id === chat.id;

    // the slot holds one thing: the options button whenever it is reachable, the pulse otherwise
    const away = Boolean(runningIds?.includes(chat.id)) && !active && !hovered && !menuFor;

    return (

      <button
        key={chat.id}
        className="relative z-10 flex w-full items-center gap-1.5 rounded-control py-2 pl-2.5 pr-1.5 text-left transition-transform duration-150 active:scale-[0.98]"
        ref={(node) => this.setRowRef(chat.id, node)}
        type="button"
        onClick={() => onSelect(chat)}
        onMouseEnter={() => this.setState({ hovered: chat.id })}
        onFocus={() => this.setState({ hovered: chat.id })}
        onContextMenu={(event) => this.onContextMenu(event, chat)}
        aria-current={active ? "page" : undefined}
      >

        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">

          <span className={cn("line-clamp-2 w-full wrap-break-word text-[13.5px] leading-snug", active ? "font-medium text-ink" : "text-ink-2")}>

            {displayTitle(chat)}

          </span>

          {chat.modified > 0 && (

            <span className="w-full truncate text-[11.5px] text-ink-3 tabular-nums">{relativeTime(chat.modified)}</span>

          )}

        </span>

        <span
          role="button"
          tabIndex={-1}
          aria-label="Session options"
          onClick={(event) => this.onContextMenu(event, chat)}
          onContextMenu={(event) => this.onContextMenu(event, chat)}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center self-center rounded-chip text-ink-3 transition-[opacity,color,background-color] duration-150 hover:bg-hover hover:text-ink-2",
            hovered || active || menuFor || away ? "opacity-100" : "opacity-0",
          )}
        >

          {away ? (

            <span className="size-1.5 rounded-full bg-ink" style={{ animation: "pixel-on 1200ms ease-in-out infinite" }} title="Still running" />

          ) : (

            <EllipsisVerticalIcon className="size-4" />

          )}

        </span>

      </button>

    );

  };

  /** Quiet group label — project name or Unknown, with session count on the right. */
  private renderGroup = (group: ChatGroup) => {

    if (!group.chats.length) {

      return null;

    }

    return (

      <div key={group.key || "unknown"} className="flex flex-col gap-px">

        <div className="flex items-center gap-2 px-2.5 pb-0.5 pt-3 first:pt-1" title={group.title} >

          <span className={cn(
            "min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide",
            group.current ? "text-ink-2" : "text-ink-3",
          )}>

            {group.label}

          </span>

          <span className="shrink-0 text-[11px] tabular-nums text-ink-3/80">{group.chats.filter((chat) => !chat.subagent).length}</span>

        </div>

        {group.chats.map((chat) => (chat.subagent ? this.renderSubagentRow(chat) : this.renderChatRow(chat)))}

      </div>

    );

  };

  render() {

    const { chats, loading, onNew, onOpenSettings, projectDir } = this.props;
    const { menu, box } = this.state;

    const groups = groupChats(chats, projectDir);
    const hasProject = Boolean(projectDir);
    const empty = !chats.length;

    return (

      <aside className="flex h-full w-64 shrink-0 flex-col gap-2 border-r border-line bg-canvas p-2.5 pt-2.5">

        <button
          type="button"
          onClick={onNew}
          disabled={!hasProject}
          className={cn(
            "flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-[14px] font-medium transition-[background-color,transform,opacity] duration-100 active:scale-[0.97]",
            hasProject
              ? "bg-brand-tint text-brand hover:bg-brand-tint"
              : "cursor-not-allowed bg-hover/60 text-ink-3 opacity-70",
          )}
        >

          <span className="min-w-0 flex-1 truncate text-left">New session</span>

          <span className={cn(
            "flex size-5 shrink-0 items-center justify-center",
            hasProject ? "text-brand" : "text-ink-3",
          )}>

            <PlusIcon className="size-3" strokeWidth={3} />

          </span>

        </button>

        <div className="min-h-0 flex-1 overflow-y-auto">

          {loading && empty && (

            <p className="px-2.5 py-2 text-[13px] text-ink-3">Loading…</p>

          )}

          {!loading && empty && (

            <p className="px-2.5 py-2 text-[13px] leading-relaxed text-ink-3">

              {hasProject ? "No sessions yet." : "Choose a folder to start. Past projects appear here once you open them."}

            </p>

          )}

          <div
            ref={this.list}
            onMouseLeave={() => this.setState({ hovered: null })}
            className="relative flex flex-col"
          >

            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 rounded-control bg-hover"
              style={{

                top: box?.top ?? 0,
                height: box?.height ?? 0,

                opacity: box ? 1 : 0,

                transition: "top 220ms var(--ease-glide), height 220ms var(--ease-glide), opacity 150ms ease",

              }}
            />

            {groups.map((group) => this.renderGroup(group))}

          </div>

        </div>

        {/* pinned below the scroller, so a long session list never pushes it out of reach */}
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full shrink-0 items-center gap-2 rounded-control px-2.5 py-2 text-[13.5px] text-ink-2 transition-colors duration-100 bg-surface hover:bg-hover hover:text-ink"
        >

          <SettingsIcon className="size-4 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-left">Settings</span>

        </button>

        {menu && (

          <div
            ref={this.menu}
            className="fixed z-50 min-w-40 overflow-hidden rounded-card bg-surface p-1 text-[13.5px] shadow-overlay"
            style={{

              left: menu.x,
              top: menu.y,

              animation: "pop-in 160ms var(--ease-glide) both",
              transformOrigin: "top left",

            }}
            onContextMenu={(event) => event.preventDefault()}
          >

            {this.state.renameValue === null ? (

              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-chip px-2.5 py-2 text-left text-ink-2 transition-colors duration-100 hover:bg-hover"
                onClick={this.renameFromMenu}
              >

                <PencilIcon className="size-4" />
                Rename session

              </button>

            ) : (

              <form
                className="p-1"
                onSubmit={(event) => {

                  event.preventDefault();
                  this.submitRename();

                }}
              >

                <input
                  ref={this.renameInput}
                  value={this.state.renameValue}
                  aria-label="Session name"
                  className="h-8 w-full rounded-chip border border-line bg-field px-2 text-[13.5px] text-ink outline-none focus:border-brand"
                  onChange={(event) => this.setState({ renameValue: event.target.value })}
                  onKeyDown={(event) => {

                    if (event.key === "Escape") {

                      event.stopPropagation();
                      this.closeMenu();

                    }

                  }}
                />

              </form>

            )}

            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-chip px-2.5 py-2 text-left text-red transition-colors duration-100 hover:bg-red-tint"
              onClick={this.deleteFromMenu}
            >

              <Trash2Icon className="size-4" />
              Delete session

            </button>

          </div>

        )}

      </aside>

    );

  }

}
