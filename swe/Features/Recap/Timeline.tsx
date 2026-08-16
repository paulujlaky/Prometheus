import { Component } from "react";

import { AnimatePresence, motion } from "motion/react";
import { ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";

import { cn } from "@/Utils/Class";
import { folderLabel, sameDir } from "@/Utils/Paths";
import { formatElapsed, relativeTime } from "@/Utils/Time";

import type { RecapFile, RunRecap } from "@/Types/Recap";

interface RepoNode {

  project: string;
  label: string;

  runs: RunRecap[];

  at: number;

}

export interface RecapViewProps {

  recaps: RecapFile;
  projectDir: string | null;

  onOpenChat: (recap: RunRecap) => void;
  onOpenProject: (dir: string) => void;
  onNew: () => void;

}

interface RecapViewState {

  collapsed: Set<string>;

}

/** Newest run first inside each repo, repo touched most recently at the top. */
function repoNodes(file: RecapFile): RepoNode[] {

  const nodes: RepoNode[] = [];

  for (const [project, rows] of Object.entries(file)) {

    if (!Array.isArray(rows) || !rows.length) {

      continue;

    }

    const runs = [...rows].sort((a, b) => b.at - a.at);

    nodes.push({ project, label: folderLabel(project), runs, at: runs[0].at });

  }

  return nodes.sort((a, b) => b.at - a.at);

}

function runCount(node: RepoNode): string {

  return `${node.runs.length} ${node.runs.length === 1 ? "run" : "runs"}`;

}

export class RecapView extends Component<RecapViewProps, RecapViewState> {

  state: RecapViewState = { collapsed: new Set<string>() };

  private toggleRepo = (project: string) => {

    this.setState((prev) => {

      const collapsed = new Set(prev.collapsed);

      if (collapsed.has(project)) {

        collapsed.delete(project);

      } else {

        collapsed.add(project);

      }

      return { collapsed };

    });

  };

  private renderRun = (recap: RunRecap) => {

    const clickable = Boolean(recap.chatId);

    return (

      <div key={recap.id + recap.at}>

        <button className={cn(

          "group mb-1.5 flex w-full flex-col gap-1.5 rounded-card bg-surface px-3 py-2.5 text-left transition-colors duration-100",
          clickable ? "hover:bg-hover" : "cursor-default",

        )}

          type="button"
          disabled={!clickable}

          onClick={() => this.props.onOpenChat(recap)}

        >

          <span className="text-[13.5px] leading-snug text-ink">{recap.headline}</span>

          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] tabular-nums text-ink-3">

            <span>{relativeTime(recap.at)}</span>
            <span aria-hidden>·</span>
            <span>{formatElapsed(recap.durationMs)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{recap.model}</span>

            {recap.added || recap.removed ? (

              <>

                <span aria-hidden>·</span>
                <span className="text-green">+{recap.added}</span>
                <span className="text-red">−{recap.removed}</span>

              </>

            ) : null}

          </span>

          {recap.unverified.map((line, index) => (

            <span className="text-[11.5px] leading-snug text-ink-2" key={`u${index}`}>

              <span className="font-semibold text-ink">Next up:</span> {line}

            </span>

          ))}

          {recap.risk ? (

            <span className="text-[11.5px] leading-snug text-ink-2">

              <span className="font-semibold text-ink">Risk:</span> {recap.risk}

            </span>

          ) : null}

        </button>

      </div>

    );

  };

  private renderRepo = (node: RepoNode) => {

    const open = !this.state.collapsed.has(node.project);
    const current = sameDir(node.project, this.props.projectDir);

    return (

      <div key={node.project}>

        <div className="flex items-center gap-2 py-1.5">

          <button className="flex min-w-0 items-center gap-1.5 text-left"

            type="button"

            onClick={() => this.toggleRepo(node.project)}

          >

            <ChevronRightIcon className={cn("size-3.5 shrink-0 text-ink-3 transition-transform duration-150", open && "rotate-90")} />

            <span className={cn("min-w-0 truncate text-[14px] font-medium", current ? "text-brand" : "text-ink")}>{node.label}</span>

          </button>

          <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">{runCount(node)}</span>

          <span className="min-w-0 flex-1" aria-hidden />

          {!current ? (

            <button className="shrink-0 rounded-chip px-2 py-1 text-[11.5px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"

              type="button"

              onClick={() => this.props.onOpenProject(node.project)}

            >

              Open

            </button>

          ) : null}

        </div>

        <AnimatePresence initial={false}>

          {open ? (

            <motion.div className="overflow-hidden pb-2"

              key="runs"

              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}

              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}

            >

              {node.runs.map((run) => this.renderRun(run))}

            </motion.div>

          ) : null}

        </AnimatePresence>

      </div>

    );

  };

  render() {

    const nodes = repoNodes(this.props.recaps);

    return (

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-page">

        <div className="mx-auto flex w-full max-w-3xl flex-col px-8 pb-16 pt-10">

          <h1 className="pb-1 text-[20px] font-medium text-ink">Recap</h1>

          {!nodes.length ? (

            <div className="mt-8 flex flex-col items-start gap-3 rounded-card bg-surface px-5 py-6">

              <FolderIcon className="size-5 text-ink-3" />

              <p className="text-[13.5px] leading-relaxed text-ink-2">

                Nothing recapped yet. Finish a session and the agent's own summary of it lands here, grouped by repo.

              </p>

              <button className="flex items-center gap-2 rounded-control bg-brand-tint px-3 py-2 text-[13.5px] font-medium text-brand transition-transform duration-100 active:scale-[0.97]"

                type="button"

                onClick={this.props.onNew}

              >

                <PlusIcon className="size-3.5" strokeWidth={3} />
                New session

              </button>

            </div>

          ) : (

            <div className="mt-4">

              {nodes.map((node) => this.renderRepo(node))}

            </div>

          )}

        </div>

      </div>

    );

  }

}
