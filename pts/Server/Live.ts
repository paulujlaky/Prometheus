import type { ServerWebSocket } from "bun";

import { handBack, input, reason, takeOver, userTab, watch, type Input, type TabAction } from "../Agent/Tools/Browser";
import { getAgentById, workspaceOf } from "../Store";

type Socket = ServerWebSocket<{ userId: number }>;

// a take-over left alone (phone locked, tab forgotten) must not park the agent forever
const HOLD_MS = Number(process.env.PTS_HOLD_MS ?? 5 * 60_000);

// iOS drops the socket when the user switches apps, say to copy a sign-in code; they get this long to come back
const GRACE_MS = Number(process.env.PTS_HOLD_GRACE_MS ?? 2 * 60_000);

// a slow connection gets fewer frames rather than a growing backlog of stale ones; a few frames is already a lag
const MAX_BUFFERED = 300_000;

export type LiveMessage =

  | { live: "watch"; agentId: number }
  | { live: "unwatch" }
  | { live: "take"; width?: number; height?: number }
  | { live: "give" }
  | { live: "input"; event: Input }
  | { live: "tab"; action: TabAction; id?: number };

interface View {

  agentId: number;
  workspace: string;
  stop: () => void;

}

/** Only the known fields of a well-formed input, so nothing else from the socket reaches the page. */
function validInput(event: unknown): Input | null {

  const e = event as Record<string, any> | null;
  const unit = (...values: unknown[]) => values.every((value) => typeof value === "number" && value >= 0 && value <= 1);
  const delta = (...values: unknown[]) => values.every((value) => typeof value === "number" && Math.abs(value) <= 10);
  const short = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;

  switch (e?.kind) {

    case "click":

      return unit(e.x, e.y) ? { kind: "click", x: e.x, y: e.y } : null;

    case "scroll":

      return unit(e.x, e.y) && delta(e.dx, e.dy) ? { kind: "scroll", x: e.x, y: e.y, dx: e.dx, dy: e.dy } : null;

    case "drag":

      return unit(e.x, e.y, e.toX, e.toY) ? { kind: "drag", x: e.x, y: e.y, toX: e.toX, toY: e.toY } : null;

    case "text":

      return short(e.text, 20_000) ? { kind: "text", text: e.text } : null;

    case "key":

      return short(e.key, 40) ? { kind: "key", key: e.key } : null;

    case "back":

      return { kind: "back" };

  }

  return null;

}

/**
 * Watching an agent's browser and taking it over, over the app's one socket. `onGive` runs when a take-over ends.
 * Workspaces are kept from the moment of watching, so an agent deleted mid-take-over still gets its browser handed back.
 */
export class Live {

  private views = new Map<Socket, View>();

  /** `ws` is null while the device that took over is reconnecting. */
  private holders = new Map<number, { ws: Socket | null; workspace: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private onGive: (agentId: number) => void) {}

  message(ws: Socket, message: LiveMessage) {

    const view = this.views.get(ws);
    const mine = view && this.holders.get(view.agentId)?.ws === ws;
    const fail = (err: unknown) => this.send(ws, { type: "browser", agentId: view?.agentId, error: reason(err) });

    if (message.live === "watch") {

      this.watch(ws, message.agentId);

    } else if (message.live === "unwatch") {

      this.unwatch(ws);

    } else if (view && message.live === "take") {

      const size = Number.isFinite(message.width) && Number.isFinite(message.height) ? { width: message.width!, height: message.height! } : undefined;

      clearTimeout(this.holders.get(view.agentId)?.timer);

      // the latest device to ask gets the browser; the one that had it drops back to watching
      this.holders.set(view.agentId, { ws, workspace: view.workspace, timer: setTimeout(() => this.give(view.agentId), HOLD_MS) });
      takeOver(view.workspace, size).catch(fail);
      this.status(view.agentId);

    } else if (mine && message.live === "give") {

      this.give(view.agentId);

    } else if (mine && message.live === "tab" && ["switch", "close", "new"].includes(message.action) && (message.action === "new" || Number.isInteger(message.id))) {

      this.renew(view.agentId, HOLD_MS);
      userTab(view.workspace, message.action, message.id).catch(fail);

    } else if (mine && message.live === "input") {

      const event = validInput(message.event);

      if (event) {

        this.renew(view.agentId, HOLD_MS);
        input(view.workspace, event).catch(fail);

      }

    }

  }

  /** A lost connection keeps its take-over for a while; leaving the browser screen gives it back at once. */
  close(ws: Socket) {

    const view = this.views.get(ws);
    const holder = view && this.holders.get(view.agentId);

    if (view && holder?.ws === ws) {

      holder.ws = null;
      this.renew(view.agentId, GRACE_MS);

    }

    this.unwatch(ws);

  }

  private send(ws: Socket, message: unknown) {

    ws.send(JSON.stringify(message));

  }

  private status(agentId: number) {

    const holder = this.holders.get(agentId)?.ws;

    for (const [ws, view] of this.views) {

      if (view.agentId === agentId) {

        this.send(ws, { type: "browser", agentId, held: this.holders.has(agentId), mine: holder === ws });

      }

    }

  }

  private watch(ws: Socket, agentId: unknown) {

    const agent = Number.isInteger(agentId) ? getAgentById(agentId as number) : null;

    this.unwatch(ws);

    // another user's agent is as good as missing
    if (agent?.userId !== ws.data.userId) {

      return;

    }

    const workspace = workspaceOf(agent);

    // frames go as raw JPEG bytes: a third smaller than base64, and the socket only ever streams the one browser it watches
    const stop = watch(workspace, {

      frame: (jpeg) => {

        if (!jpeg) {

          this.send(ws, { type: "browser", agentId: agent.id, blank: true });

        } else if (ws.getBufferedAmount() < MAX_BUFFERED) {

          ws.send(jpeg);

        }

      },

      fail: (message) => this.send(ws, { type: "browser", agentId: agent.id, error: message }),
      tabs: (tabs) => this.send(ws, { type: "tabs", agentId: agent.id, tabs }),

    });

    this.views.set(ws, { agentId: agent.id, workspace, stop });
    this.status(agent.id);

  }

  private unwatch(ws: Socket) {

    const view = this.views.get(ws);

    if (!view) {

      return;

    }

    this.views.delete(ws);
    view.stop();

    if (this.holders.get(view.agentId)?.ws === ws) {

      this.give(view.agentId);

    }

  }

  private renew(agentId: number, ms: number) {

    const holder = this.holders.get(agentId);

    if (holder) {

      clearTimeout(holder.timer);
      holder.timer = setTimeout(() => this.give(agentId), ms);

    }

  }

  private give(agentId: number) {

    const holder = this.holders.get(agentId);

    if (!holder) {

      return;

    }

    clearTimeout(holder.timer);
    this.holders.delete(agentId);

    handBack(holder.workspace).catch(() => {});

    this.onGive(agentId);
    this.status(agentId);

  }

}
