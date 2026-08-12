import { Component, createRef, type MouseEvent as ReactMouseEvent } from "react";
import { EllipsisVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SweChat {

  id: string;
  name: string;
  title: string;
  modified: number;

  /** Normalized project root when known; null/undefined = unassigned. */
  project?: string | null;

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

  onSelect: (chat: SweChat) => void;
  onDelete: (chat: SweChat) => void;
  onNew: () => void;

}

interface SidebarState {

  menu: ContextMenu | null;
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

interface ChatGroup {

  key: string;
  label: string;
  title?: string;
  chats: SweChat[];
  current: boolean;

}

/** Group every project’s sessions; active project first, Unknown last. */
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

  for (const list of buckets.values()) {

    list.sort((a, b) => b.modified - a.modified);

  }

  const active = normalizeDir(projectDir);
  const groups: ChatGroup[] = [];

  if (active && buckets.has(active)) {

    groups.push({

      key: active,
      label: folderLabel(active),
      title: active,
      chats: buckets.get(active)!,
      current: true,

    });

    buckets.delete(active);

  }

  const others = [...buckets.entries()]
    .filter(([key]) => key !== "")
    .sort((a, b) => folderLabel(a[0]).localeCompare(folderLabel(b[0])));

  for (const [key, list] of others) {

    groups.push({

      key,
      label: folderLabel(key),
      title: key,
      chats: list,
      current: false,

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

  state: SidebarState = { menu: null, hovered: null, box: null };

  private list = createRef<HTMLDivElement>();

  private rows = new Map<string, HTMLButtonElement>();

  componentDidMount() {

    window.addEventListener("click", this.closeMenu);
    window.addEventListener("scroll", this.closeMenu, true);
    window.addEventListener("keydown", this.onKey);

    this.moveHighlight();

  }

  componentDidUpdate() {

    this.moveHighlight();

  }

  componentWillUnmount() {

    window.removeEventListener("click", this.closeMenu);
    window.removeEventListener("scroll", this.closeMenu, true);
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

      this.setState({ menu: null });

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

    this.setState({ menu: { x: event.clientX, y: event.clientY, chat } });

  };

  private deleteFromMenu = () => {

    const { menu } = this.state;

    if (!menu) {

      return;

    }

    this.setState({ menu: null });
    this.props.onDelete(menu.chat);

  };

  private setRowRef = (id: string, node: HTMLButtonElement | null) => {

    if (node) {

      this.rows.set(id, node);

    } else {

      this.rows.delete(id);

    }

  };

  private renderChatRow = (chat: SweChat) => {

    const { activeId, onSelect } = this.props;
    const { menu } = this.state;

    const active = chat.id === activeId;
    const hovered = this.state.hovered === chat.id;
    const menuFor = menu?.chat.id === chat.id;

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
            hovered || active || menuFor ? "opacity-100" : "opacity-0",
          )}
        >

          <EllipsisVerticalIcon className="size-4" />

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

          <span className="shrink-0 text-[11px] tabular-nums text-ink-3/80">{group.chats.length}</span>

        </div>

        {group.chats.map((chat) => this.renderChatRow(chat))}

      </div>

    );

  };

  render() {

    const { chats, loading, onNew, projectDir } = this.props;
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

        {menu && (

          <div
            className="fixed z-50 min-w-40 overflow-hidden rounded-card bg-surface p-1 text-[13.5px] shadow-overlay"
            style={{

              left: menu.x,
              top: menu.y,

              animation: "pop-in 160ms var(--ease-glide) both",
              transformOrigin: "top left",

            }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >

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
