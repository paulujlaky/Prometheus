import { Component } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDownIcon, FolderOpenIcon, PlayIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldIcon, SquareIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Composer } from "@/comps/composer";
import { Button } from "@/comps/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/comps/ui/dropdown-menu";
import { Spinner } from "@/comps/ui/spinner";

import { displayName } from "@/lib/models";
import { cn } from "@/lib/utils";

import { splitReply, streamStep, Transcript, type Entry } from "./transcript";

import type { AgentEvent } from "./agent";
import type { AssistantSummary } from "../sdk/types";

import "./index.css";

interface SweBridge {

  models: () => Promise<AssistantSummary[]>;
  pickDir: () => Promise<string | null>;
  lastCwd: () => Promise<string | null>;

  start: (options: { task: string; cwd: string; assistantId?: string; mode: ApprovalMode }) => Promise<void>;
  stop: () => Promise<void>;

  approve: (id: number, ok: boolean) => Promise<void>;

  onEvent: (handler: (event: AgentEvent) => void) => void;
  onApproval: (handler: (request: Approval) => void) => void;

}

type ApprovalMode = "ask" | "smart" | "auto";

interface Approval {

  id: number;
  command: string;

  reason: string | null;

}

const MODES: { value: ApprovalMode; label: string; hint: string; icon: typeof ShieldIcon }[] = [

  { value: "ask", label: "Ask every time", hint: "Approve each command before it runs", icon: ShieldIcon },
  { value: "smart", label: "Ask when risky", hint: "Runs routine commands, asks for destructive ones", icon: ShieldAlertIcon },
  { value: "auto", label: "Run everything", hint: "No approvals at all, everything runs", icon: ShieldCheckIcon },

];

declare global {

  interface Window {

    swe: SweBridge;

  }

}

const MODEL_KEY = "swe:assistantId";
const MODE_KEY = "swe:approvalMode";

// distributes over the Entry union, unlike a bare Omit
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

type NewEntry = WithoutId<Entry>;

interface AppState {

  entries: Entry[];

  assistants: AssistantSummary[];
  assistantId: string | null;

  cwd: string | null;
  mode: ApprovalMode;

  running: boolean;

  status: string;

  stream: string | null;

  toggled: Set<string>;

  approval: Approval | null;

}

export class App extends Component<{}, AppState> {

  state: AppState = {

    entries: [],

    assistants: [],
    assistantId: localStorage.getItem(MODEL_KEY),

    cwd: null,
    mode: (localStorage.getItem(MODE_KEY) as ApprovalMode | null) ?? "smart",

    running: false,

    status: "Idle",

    stream: null,

    toggled: new Set<string>(),

    approval: null,

  };

  private seq = 0;

  componentDidMount() {

    window.swe.onEvent(this.onEvent);

    window.swe.onApproval((approval) => this.setState({ approval }));

    void window.swe.lastCwd().then((cwd) => {

      if (cwd) {

        this.setState({ cwd });

      }

    });

    void window.swe.models().then((assistants) => {

      this.setState((prev) => ({ assistants, assistantId: prev.assistantId ?? assistants[0]?.id ?? null }));

    }).catch((err) => this.push({ kind: "error", text: `Could not load models: ${String(err)}` }));

  }

  private push(entry: NewEntry) {

    this.seq += 1;

    this.setState((prev) => ({ entries: [...prev.entries, { ...entry, id: `e${this.seq}` } as Entry] }));

  }

  /** Steps stay folded until the user opens one; the label alone carries the transcript. */
  private isOpen = (entry: Entry) => entry.kind === "step" && this.state.toggled.has(entry.id);

  private toggle = (entry: Entry) => {

    this.setState((prev) => {

      const toggled = new Set(prev.toggled);

      if (toggled.has(entry.id)) {

        toggled.delete(entry.id);

      } else {

        toggled.add(entry.id);

      }

      return { toggled };

    });

  };

  private onEvent = (event: AgentEvent) => {

    if (event.type === "status") {

      this.setState({ status: event.text });

      return;

    }

    if (event.type === "delta") {

      this.setState((prev) => ({ stream: (prev.stream ?? "") + event.text }));

      return;

    }

    if (event.type === "assistant") {

      // settle the streamed step into a real entry in one update, so nothing flickers between the two
      const { prose, command } = splitReply(event.text);

      this.setState((prev) => {

        const id = `e${(this.seq += 1)}`;
        const toggled = new Set(prev.toggled);

        // an opened live step keeps its id changing underneath it; carry the choice over so it does not snap shut
        if (toggled.delete("stream")) {

          toggled.add(id);

        }

        return {

          entries: [...prev.entries, { id, kind: "step", prose, command, output: null, exitCode: null, streaming: false }],
          stream: null,

          toggled,

        };

      });

      return;

    }

    if (event.type === "command") {

      // the reply already carried this command; the event only matters when the two parses disagree
      this.setState((prev) => {

        const last = prev.entries[prev.entries.length - 1];

        if (last?.kind === "step" && last.command === event.command) {

          return null;

        }

        if (last?.kind === "step" && last.command === null && last.output === null) {

          return { entries: [...prev.entries.slice(0, -1), { ...last, command: event.command }] };

        }

        return { entries: [...prev.entries, { id: `e${(this.seq += 1)}`, kind: "step", prose: "", command: event.command, output: null, exitCode: null, streaming: false }] };

      });

      return;

    }

    if (event.type === "observation") {

      this.setState((prev) => {

        const last = prev.entries[prev.entries.length - 1];

        if (last?.kind === "step" && last.output === null) {

          return { entries: [...prev.entries.slice(0, -1), { ...last, output: event.text, exitCode: event.exitCode }] };

        }

        return { entries: [...prev.entries, { id: `e${(this.seq += 1)}`, kind: "step", prose: "", command: null, output: event.text, exitCode: event.exitCode, streaming: false }] };

      });

      return;

    }

    if (event.type === "done") {

      this.push({ kind: "done", text: event.summary });
      this.setState({ status: "Done" });

      return;

    }

    this.push({ kind: "error", text: event.message });
    this.setState({ status: "Error" });

  };

  private pickFolder = async () => {

    const picked = await window.swe.pickDir();

    if (picked) {

      this.setState({ cwd: picked });

    }

  };

  private resolveApproval(ok: boolean) {

    const approval = this.state.approval;

    if (!approval) {

      return;

    }

    void window.swe.approve(approval.id, ok);
    this.setState({ approval: null });

  }

  private start = async (task: string) => {

    const { cwd, assistantId, mode } = this.state;

    if (!cwd) {

      return;

    }

    this.push({ kind: "task", text: task });
    this.setState({ running: true, status: "Starting…", toggled: new Set<string>() });

    try {

      await window.swe.start({ task, cwd, assistantId: assistantId ?? undefined, mode });

    } catch (err) {

      this.push({ kind: "error", text: err instanceof Error ? err.message : String(err) });

    } finally {

      this.setState({ running: false, approval: null, stream: null });

    }

  };

  render() {

    const { entries, assistants, assistantId, cwd, mode, running, status, stream, approval } = this.state;

    const model = assistants.find((a) => a.id === assistantId);
    const rows = stream === null ? entries : [...entries, streamStep(stream)];
    const activeMode = MODES.find((m) => m.value === mode) ?? MODES[1];
    const ModeIcon = activeMode.icon;

    return (

      <div className="flex h-full flex-col">

        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">

          <Button variant="ghost" size="default" className="gap-1.5 text-sm" onClick={() => void this.pickFolder()}>

            <FolderOpenIcon className="size-4" />
            {cwd ? "Change folder" : "Choose folder"}

          </Button>

          <div className="min-w-0 flex-1" />

          <DropdownMenu>

            <DropdownMenuTrigger asChild>

              <Button variant="ghost" size="default" className="gap-1.5 bg-secondary/50 text-sm font-normal text-foreground hover:bg-secondary">

                <ModeIcon className="size-4 text-muted-foreground" />
                {activeMode.label}
                <ChevronDownIcon className="size-4 opacity-50" />

              </Button>

            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-80 text-sm">

              <DropdownMenuLabel className="text-sm">Command approval</DropdownMenuLabel>

              <DropdownMenuSeparator />

              <DropdownMenuRadioGroup
                value={mode}
                onValueChange={(value) => {

                  localStorage.setItem(MODE_KEY, value);
                  this.setState({ mode: value as ApprovalMode });

                }}
              >

                {MODES.map((option) => (

                  <DropdownMenuRadioItem key={option.value} value={option.value} className="items-start gap-2 py-2.5 text-sm">

                    <div className="flex flex-col gap-0.5">

                      <span className="text-sm">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.hint}</span>

                    </div>

                  </DropdownMenuRadioItem>

                ))}

              </DropdownMenuRadioGroup>

            </DropdownMenuContent>

          </DropdownMenu>

          {running && (

            <Button variant="secondary" size="default" className="gap-1.5 text-sm" onClick={() => void window.swe.stop()}>

              <SquareIcon className="size-3.5 fill-current" />
              Stop

            </Button>

          )}

        </header>

        <Transcript
          entries={rows}
          modelName={model ? displayName(model.name) : undefined}
          empty={cwd ? "Describe a task below to start." : "Choose a working folder to start."}
          isOpen={this.isOpen}
          onToggle={this.toggle}
        />

        {approval && (

          <div className="mx-auto w-full max-w-3xl px-4">

            <div className={cn(

              "flex items-center gap-2 rounded-xl border p-2",
              approval.reason ? "border-destructive/50 bg-destructive/10" : "border-primary/40 bg-primary/5",

            )}>

              <div className="min-w-0 flex-1">

                {approval.reason && (

                  <div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-destructive">

                    <TriangleAlertIcon className="size-3.5" />
                    Looks destructive — {approval.reason}

                  </div>

                )}

                <code className="block max-h-24 overflow-y-auto px-1 font-mono text-xs whitespace-pre-wrap">{approval.command}</code>

              </div>

              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => this.resolveApproval(false)}>

                <XIcon className="size-3.5" />
                Skip

              </Button>

              <Button size="sm" variant={approval.reason ? "destructive" : "default"} className="gap-1.5" onClick={() => this.resolveApproval(true)}>

                <PlayIcon className="size-3.5" />
                Run

              </Button>

            </div>

          </div>

        )}

        <div className="flex justify-center pb-3">

          <div className="flex w-fit items-center justify-center gap-2 rounded-full bg-muted px-3 py-1.5 text-sm text-muted-foreground">

            {running && <Spinner className="size-3.5" />}

            <span>{status}</span>

          </div>

        </div>

        <Composer
          assistants={assistants}
          assistantId={assistantId}
          busy={running}
          disabled={!cwd}
          placeholder="Describe the task..."
          disabledPlaceholder="Choose a working folder first..."
          onModelChange={(id) => {

            localStorage.setItem(MODEL_KEY, id);
            this.setState({ assistantId: id });

          }}
          onSend={(task) => void this.start(task)}
          onStop={() => void window.swe.stop()}
        />

      </div>

    );

  }

}

createRoot(document.getElementById("root")!).render(<App />);
