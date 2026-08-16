import { ChevronDownIcon, FolderOpenIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldIcon } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/UI/Dropdown";

import { folderLabel } from "@/Utils/Paths";

import type { ApprovalMode } from "@/Types/Bridge";

export const MODE_KEY = "swe:approvalMode";

export const MODES: { value: ApprovalMode; label: string; hint: string; icon: typeof ShieldIcon }[] = [

  { value: "ask", label: "Ask every time", hint: "Approve each command before it runs", icon: ShieldIcon },
  { value: "smart", label: "Ask when risky", hint: "Runs routine commands, asks for destructive ones", icon: ShieldAlertIcon },
  { value: "auto", label: "Run everything", hint: "No approvals at all, everything runs", icon: ShieldCheckIcon },

];

interface HeaderProps {

  cwd: string | null;
  recentProjects: { dir: string; count: number }[];
  mode: ApprovalMode;

  onOpenProject: (dir: string) => void;
  onPickFolder: () => void;
  onModeChange: (mode: ApprovalMode) => void;

}

export function Header({ cwd, recentProjects, mode, onOpenProject, onPickFolder, onModeChange }: HeaderProps) {

  const activeMode = MODES.find((option) => option.value === mode) ?? MODES[1];
  const ModeIcon = activeMode.icon;

  return (

    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">

      <DropdownMenu>

        <DropdownMenuTrigger asChild>

          <button type="button" className="flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover">

            <FolderOpenIcon className="size-4 text-ink-3" />
            <span className="max-w-56 truncate">{cwd ? folderLabel(cwd) : "Choose folder"}</span>
            <ChevronDownIcon className="size-3.5 opacity-60" />

          </button>

        </DropdownMenuTrigger>

        <DropdownMenuContent className="min-w-72">

          <DropdownMenuLabel>Recent projects</DropdownMenuLabel>

          {recentProjects.length === 0 ? (

            <div className="px-2 py-1.5 text-sm text-muted-foreground">No recent projects</div>

          ) : recentProjects.map((project) => (

            <DropdownMenuItem key={project.dir} onSelect={() => onOpenProject(project.dir)} title={project.dir}>

              <span className="min-w-0 flex-1 truncate">{folderLabel(project.dir)}</span>
              <span className="ml-3 text-xs tabular-nums text-muted-foreground">{project.count}</span>

            </DropdownMenuItem>

          ))}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={onPickFolder}>

            <FolderOpenIcon className="size-4 text-ink-3" />
            Open new folder…

          </DropdownMenuItem>

        </DropdownMenuContent>

      </DropdownMenu>

      <div className="min-w-0 flex-1" />

      <DropdownMenu>

        <DropdownMenuTrigger asChild>

          <button type="button" className="flex h-9 items-center gap-2 px-3 text-[13px] font-medium">

            <ModeIcon className="size-4 text-ink-3" />
            {activeMode.label}
            <ChevronDownIcon className="size-3.5 opacity-60" />

          </button>

        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-80 text-sm">

          <DropdownMenuLabel className="text-sm">Command approval</DropdownMenuLabel>

          <DropdownMenuSeparator />

          <DropdownMenuRadioGroup value={mode}

            onValueChange={(value) => {

              localStorage.setItem(MODE_KEY, value);
              onModeChange(value as ApprovalMode);

            }}

          >

            {MODES.map((option) => (

              <DropdownMenuRadioItem className="items-start gap-2 py-2.5 text-sm"

                key={option.value}
                value={option.value}

              >

                <div className="flex flex-col gap-0.5">

                  <span className="text-sm">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>

                </div>

              </DropdownMenuRadioItem>

            ))}

          </DropdownMenuRadioGroup>

        </DropdownMenuContent>

      </DropdownMenu>

    </header>

  );

}
