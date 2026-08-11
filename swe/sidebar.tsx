import { Component, type MouseEvent as ReactMouseEvent } from "react";
import { MessageSquareIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/comps/ui/button";
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

  state: SidebarState = { menu: null };

  componentDidMount() {

    window.addEventListener("click", this.closeMenu);
    window.addEventListener("scroll", this.closeMenu, true);
    window.addEventListener("keydown", this.onKey);

  }

  componentWillUnmount() {

    window.removeEventListener("click", this.closeMenu);
    window.removeEventListener("scroll", this.closeMenu, true);
    window.removeEventListener("keydown", this.onKey);

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

    this.setState({

      menu: {

        x: event.clientX,
        y: event.clientY,
        chat,

      },

    });

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
    const { menu } = this.state;

    return (

      <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-muted/15">

        <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-3">

          <span className="text-sm font-medium text-muted-foreground">Sessions</span>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            title="New session"
            onClick={onNew}
          >

            <PlusIcon className="size-3.5" />

          </Button>

        </div>

        <div className="flex-1 overflow-y-auto px-1.5 py-2">

          {loading && !chats.length && (

            <p className="px-2 py-3 text-xs text-muted-foreground">Loading...</p>

          )}

          {!loading && !chats.length && (

            <p className="px-2 py-3 text-xs text-muted-foreground">No sessions, yet.</p>

          )}

          <ul className="flex flex-col gap-0.5">

            {chats.map((chat) => {

              const active = chat.id === activeId;

              return (

                <li key={chat.id}>

                  <button
                    type="button"
                    onClick={() => onSelect(chat)}
                    onContextMenu={(event) => this.onContextMenu(event, chat)}
                    className={cn(

                      "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                      active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",

                    )}
                  >

                    <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0 opacity-70" />

                    <span className="min-w-0 flex-1">

                      <span className="line-clamp-2 text-[13px] leading-snug font-medium text-foreground/90">

                        {displayTitle(chat)}

                      </span>

                      {chat.modified > 0 && (

                        <span className="mt-0.5 block text-[10px] text-muted-foreground">

                          {relativeTime(chat.modified)}

                        </span>

                      )}

                    </span>

                  </button>

                </li>

              );

            })}

          </ul>

        </div>

        {menu && (

          <div
            className="fixed z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
            style={{ left: menu.x, top: menu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >

            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-destructive hover:bg-destructive/10"
              onClick={this.deleteFromMenu}
            >

              <Trash2Icon className="size-3.5" />
              Delete session

            </button>

          </div>

        )}

      </aside>

    );

  }

}
