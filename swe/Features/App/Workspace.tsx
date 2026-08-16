import { AnimatePresence } from "motion/react";

import { AskCard } from "@/Features/Chat/AskCard";
import { ApprovalCard } from "@/Features/Chat/ApprovalCard";
import { Composer } from "@/Features/Chat/Composer";
import { PlanCard } from "@/Features/Chat/PlanCard";
import { StatusBar } from "@/Features/Chat/StatusBar";
import { Transcript, type UndoInfo } from "@/Features/Chat/Transcript";
import { PrefsPanel } from "@/Features/Settings/PrefsPanel";
import { Header } from "@/Layout/Header";
import { Sidebar } from "@/Layout/Sidebar";
import { PromptDock } from "@/UI/Prompt";

import type { AppState } from "@/Features/App/State";
import type { ApprovalMode } from "@/Types/Bridge";
import type { SweChat } from "@/Types/Chat";
import type { Entry } from "@/Types/Transcript";
import type { Answer } from "@/Tools/Ask";
import type { PlanDecision } from "@/Tools/Plan";
import type { Preferences } from "@/Utils/Prefs";

export interface WorkspaceProps {

  state: AppState;
  rows: Entry[];
  status: string;
  usage: { ratio: number; used: number; limit: number };
  diff: { added: number; removed: number };

  chats: SweChat[];
  runningIds: string[];

  isOpen: (entry: Entry) => boolean;
  undoFor: (entry: Entry) => UndoInfo | null;

  onSelect: (chat: SweChat) => void;
  onRename: (chat: SweChat, name: string) => void;
  onDelete: (chat: SweChat) => void;
  onNew: () => void;

  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSavedPrefs: (prefs: Preferences) => void;

  onOpenProject: (dir: string) => void;
  onPickFolder: () => void;
  onModeChange: (mode: ApprovalMode) => void;

  onToggle: (entry: Entry) => void;
  onUndo: (commit: string) => void;

  onResolve: (ok: boolean) => void;
  onAnswer: (answer: Answer) => void;
  onDismissAsk: () => void;
  onBuild: (decision: PlanDecision) => void;
  onDismissPlan: () => void;

  onModelChange: (id: string) => void;
  onSend: (task: string, imagePaths: string[]) => void;
  onStop: () => void;
  onSpeedUp: () => void;

}

export function Workspace(props: WorkspaceProps) {

  const {

    state,
    rows,
    status,
    usage,
    diff,

    chats,
    runningIds,

    isOpen,
    undoFor,

  } = props;

  const { assistants, assistantId, cwd, mode, running, startedAt, approval, ask, plan, chatsLoading, activeChatId, undoBusy, prefsOpen } = state;

  return (

    <div className="flex h-full bg-page">

      <Sidebar

        chats={chats}
        activeId={activeChatId}

        runningIds={runningIds}

        loading={chatsLoading}

        projectDir={cwd}

        onSelect={props.onSelect}
        onRename={props.onRename}
        onDelete={props.onDelete}
        onNew={props.onNew}
        onOpenSettings={props.onOpenSettings}

      />

      <AnimatePresence>

        {prefsOpen ? (

          <PrefsPanel

            models={assistants}

            onClose={props.onCloseSettings}
            onSaved={props.onSavedPrefs}

          />

        ) : null}

      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">

        <Header

          cwd={cwd}
          recentProjects={state.recentProjects}
          mode={mode}

          onOpenProject={props.onOpenProject}
          onPickFolder={props.onPickFolder}
          onModeChange={props.onModeChange}

        />

        <Transcript

          entries={rows}
          running={running}

          empty={cwd ? "Describe a task below to start." : "Choose a working folder to start."}
          usage={state.usage}

          isOpen={isOpen}
          onToggle={props.onToggle}

          undoFor={undoFor}
          onUndo={props.onUndo}
          undoBusy={undoBusy}

        />

        <AnimatePresence>

          {approval ? (

            <PromptDock key="approval">

              <ApprovalCard approval={approval} onResolve={props.onResolve} />

            </PromptDock>

          ) : null}

          {ask ? (

            <PromptDock key="ask">

              <AskCard key={ask.id} question={ask.question} onAnswer={props.onAnswer} onDismiss={props.onDismissAsk} />

            </PromptDock>

          ) : null}

          {plan ? (

            <PromptDock key="plan">

              <PlanCard

                key={plan.id}

                plan={plan.plan}

                assistants={assistants}
                assistantId={assistantId}

                onBuild={props.onBuild}
                onDismiss={props.onDismissPlan}

              />

            </PromptDock>

          ) : null}

        </AnimatePresence>

        <StatusBar status={status} running={running} startedAt={startedAt} diff={diff} />

        <Composer

          assistants={assistants}
          assistantId={assistantId}

          busy={running}
          disabled={!cwd}

          contextRatio={usage.ratio}
          contextUsed={usage.used}
          contextLimit={usage.limit}

          placeholder={running ? "Interject while working..." : activeChatId ? "Follow up on this session..." : "Describe what to build..."}
          disabledPlaceholder="Choose a working folder first..."

          startedAt={startedAt}

          onModelChange={props.onModelChange}
          onSend={props.onSend}
          onPickImages={() => window.swe.pickImages()}
          onFiles={(files) => window.swe.importImages(files)}
          onStop={props.onStop}
          onSpeedUp={props.onSpeedUp}

        />

      </div>

    </div>

  );

}
