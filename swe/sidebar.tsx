import { Component, createRef, type MouseEvent as ReactMouseEvent } from "react";
import { EllipsisVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SweChat {

  id: string;
  name: string;
  title: string;
  modified: number;

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

  render() {

    const { chats, activeId, loading, onSelect, onNew } = this.props;
    const { menu, box } = this.state;

    // pt centres the first control against the 56px header across the split
    return (

      <aside className="flex h-full w-64 shrink-0 flex-col gap-2 border-r border-line bg-canvas p-2.5 pt-[10px]">

        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-[14px] font-medium text-brand transition-[background-color,transform] duration-100 hover:bg-brand-tint active:scale-[0.97]"
        >

          <span className="min-w-0 flex-1 truncate text-left">New session</span>

          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-white">

            <PlusIcon className="size-3" strokeWidth={3} />

          </span>

        </button>

        <div className="min-h-0 flex-1 overflow-y-auto">

          {loading && !chats.length && <p className="px-2.5 py-2 text-[13px] text-ink-3">Loading...</p>}

          {!loading && !chats.length && <p className="px-2.5 py-2 text-[13px] text-ink-3">No sessions, yet.</p>}

          <div ref={this.list} onMouseLeave={() => this.setState({ hovered: null })} className="relative flex flex-col gap-px" >

            <span aria-hidden className="pointer-events-none absolute inset-x-0 rounded-control bg-hover"

              style={{

                top: box?.top ?? 0,
                height: box?.height ?? 0,

                opacity: box ? 1 : 0,

                transition: "top 220ms var(--ease-glide), height 220ms var(--ease-glide), opacity 150ms ease",

              }}

            />

            {chats.map((chat) => {

              const active = chat.id === activeId;
              const hovered = this.state.hovered === chat.id;
              const menuFor = menu?.chat.id === chat.id;

              return (

                <button key={chat.id} className="relative z-10 flex w-full items-center gap-1.5 rounded-control py-2 pl-2.5 pr-1.5 text-left transition-transform duration-150 active:scale-[0.98]"

                  ref={(node) => {

                    if (node) {

                      this.rows.set(chat.id, node);

                    } else {

                      this.rows.delete(chat.id);

                    }

                  }}

                  type="button"

                  onClick={() => onSelect(chat)}
                  onMouseEnter={() => this.setState({ hovered: chat.id })}
                  onFocus={() => this.setState({ hovered: chat.id })}
                  onContextMenu={(event) => this.onContextMenu(event, chat)}

                  aria-current={active ? "page" : undefined}

                >

                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">

                    <span className={cn("line-clamp-2 w-full break-words text-[13.5px] leading-snug", active ? "font-medium text-ink" : "text-ink-2")}>

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

            })}

          </div>

        </div>

        {menu && (

          <div className="fixed z-50 min-w-40 overflow-hidden rounded-card bg-surface p-1 text-[13.5px] shadow-overlay"

            style={{

              left: menu.x,
              top: menu.y,

              animation: "pop-in 160ms var(--ease-glide) both",
              transformOrigin: "top left"

            }}

            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}

          >

            <button type="button" className="flex w-full items-center gap-2 rounded-chip px-2.5 py-2 text-left text-red transition-colors duration-100 hover:bg-red-tint" onClick={this.deleteFromMenu} >

              <Trash2Icon className="size-4" />
              Delete session

            </button>

          </div>

        )}

      </aside>

    );

  }

}
