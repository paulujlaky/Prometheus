import { Download, X } from "lucide-react";
import { Component } from "react";

import { IconButton } from "../../Components/Controls";

import { api, fileURL, type WorkspaceFile } from "../../Lib/api";

interface FilesProps {

  agentId: number;

  /** Changes whenever the agent may have made a file, so the list follows. */
  version: number;

  onClose: () => void;

}

interface FilesState {

  files: WorkspaceFile[] | null;
  error: string | null;

}

export const sizeOf = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

/** The agent's workspace: what the user sent it and what it made, newest first. */
export class Files extends Component<FilesProps, FilesState> {

  state: FilesState = { files: null, error: null };

  componentDidMount() {

    this.load();

  }

  componentDidUpdate(previous: FilesProps) {

    if (previous.version !== this.props.version) {

      this.load();

    }

  }

  load = () => {

    api<WorkspaceFile[]>(`/agents/${this.props.agentId}/files`)
      .then((files) => this.setState({ files: files.sort((a, b) => b.modified - a.modified), error: null }))
      .catch((err) => this.setState({ error: err instanceof Error ? err.message : String(err) }));

  };

  render() {

    const { files, error } = this.state;

    return (

      <aside aria-label="Files" className="absolute inset-0 z-30 flex flex-col bg-ink md:static md:w-80 md:shrink-0 md:border-l md:border-line">

        <div className="flex h-14 shrink-0 items-center justify-between pr-1.5 pl-5">

          <span className="text-[15px] font-medium">Files</span>
          <IconButton label="Close files" onClick={this.props.onClose}><X size={18} /></IconButton>

        </div>

        <ul className="m-0 flex min-h-0 grow list-none flex-col overflow-y-auto px-2 pb-4">

          {error && <li className="px-3 text-[14px] text-dim">{error}</li>}
          {files?.length === 0 && <li className="px-3 text-[14px] text-dim">Nothing yet. Drop a file into the chat to send it.</li>}
          {files?.map((file) => (

            <li key={file.path}>

              <a href={fileURL(this.props.agentId, file.path)} download className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-fg no-underline hover:bg-panel">

                <span className="flex min-w-0 grow flex-col">

                  <span className="truncate text-[14px]">{file.path.split("/").at(-1)}</span>
                  <span className="truncate font-mono text-[11px] text-dim">{file.path.includes("/") ? `${file.path.slice(0, file.path.lastIndexOf("/"))} · ` : ""}{sizeOf(file.size)}</span>

                </span>

                <Download size={15} className="shrink-0 text-dim group-hover:text-fg" />

              </a>

            </li>

          ))}

        </ul>

      </aside>

    );

  }

}
