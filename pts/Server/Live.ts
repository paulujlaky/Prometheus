import type { ServerWebSocket } from "bun";

import { handBack, input, takeOver, watch, type Input } from "../Agent/Tools/Browser";
import { getAgentById, workspaceOf } from "../Store";

type Socket = ServerWebSocket<unknown>;

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
  | { live: "input"; event: Input };

interface View {

  agentId: number;
  workspace: string;
  stop: () => void;

}

function validInput(event: unknown): Input | null {

  const e = event as Record<string, unknown> | null;
  const unit = (...values: unknown[]) => values.every((value) => typeof value === "number" && value >= 0 && value <= 1);
  const delta = (...values: unknown[]) => values.every((value) => typeof value === "number" && Math.abs(value) <= 10);
  const short = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;

  switch (e?.kind) {

    case "click":

      return unit(e.x, e.y) ? { kind: "click", x: e.x as number, y: e.y as number } : null;

    case "scroll":

      return unit(e.x, e.y) && delta(e.dx, e.dy) ? { kind: "scroll", x: e.x as number, y: e.y as number, dx: e.dx as number, dy: e.dy as number } : null;

    case "drag":

      return unit(e.x, e.y, e.toX, e.toY) ? { kind: "drag", x: e.x as number, y: e.y as number, toX: e.toX as number, toY: e.toY as number } : null;

    case "text":

      return short(e.text, 2000) ? { kind: "text", text: e.text as string } : null;

    case "key":

      return short(e.key, 40) ? { kind: "key", key: e.key as string } : null;

    case "back":

      return { kind: "back" };

  }

  return null;

}

function reason(err: unknown): string {

  return err instanceof Error ? err.message.split("\n")[0] : String(err);

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

    if (message.live === "watch") {

      this.watch(ws, message.agentId);
      return;

    }

    if (message.live === "unwatch") {

      this.unwatch(ws);
      return;

    }

    const view = this.views.get(ws);

    if (!view) {

      return;

    }

    if (message.live === "take") {

      const size = Number.isFinite(message.width) && Number.isFinite(message.height) ? { width: message.width!, height: message.height! } : undefined;

      this.take(ws, view, size);
      return;

    }

    if (this.holders.get(view.agentId)?.ws !== ws) {

      return;

    }

    if (message.live === "give") {

      this.give(view.agentId);
      return;

    }

    const event = validInput(message.event);

    if (event) {

      this.renew(view.agentId, HOLD_MS);
      input(view.workspace, event).catch((err) => this.send(ws, { type: "browser", agentId: view.agentId, error: reason(err) }));

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

    if (!agent) {

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

  /** The latest device to ask gets the browser; the one that had it drops back to watching. */
  private take(ws: Socket, view: View, size?: { width: number; height: number }) {

    clearTimeout(this.holders.get(view.agentId)?.timer);
    this.holders.set(view.agentId, { ws, workspace: view.workspace, timer: setTimeout(() => this.give(view.agentId), HOLD_MS) });

    takeOver(view.workspace, size).catch((err) => this.send(ws, { type: "browser", agentId: view.agentId, error: reason(err) }));
    this.status(view.agentId);

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
