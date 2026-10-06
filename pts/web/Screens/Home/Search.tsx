import { UserRound, Users, X } from "lucide-react";
import { Component, createRef } from "react";

import { Button, IconButton, inputClass, Select } from "../../Components/Controls";
import { Bar } from "../../Components/Layout";

import { api, type Agent, type GroupChat } from "../../Lib/api";
import type { SearchHit } from "../../../Store";

interface SearchProps {

  agents: Agent[];
  groups: GroupChat[];

}

interface SearchState {

  query: string;
  scope: string;
  hits: SearchHit[];
  more: boolean;
  busy: boolean;
  error: string;
  selected: SearchHit | null;
  context: SearchHit[];

}

function highlighted(text: string, query: string) {

  const index = text.toLowerCase().indexOf(query.toLowerCase());

  if (!query || index < 0) {

    return text;

  }

  return <>{text.slice(0, index)}<mark className="rounded bg-fg/20 text-fg">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;

}

function excerpt(text: string, query: string) {

  const index = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase()));
  const start = Math.max(0, index - 90);
  const end = Math.min(text.length, index + query.length + 180);

  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;

}

export class Search extends Component<SearchProps, SearchState> {

  state: SearchState = { query: "", scope: "", hits: [], more: false, busy: false, error: "", selected: null, context: [] };

  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private match = createRef<HTMLDivElement>();
  private field = createRef<HTMLInputElement>();

  componentWillUnmount() {

    clearTimeout(this.timer);
    this.version += 1;

  }

  change = (changes: Partial<Pick<SearchState, "query" | "scope">>) => {

    clearTimeout(this.timer);
    this.version += 1;
    this.setState((state) => ({ query: changes.query ?? state.query, scope: changes.scope ?? state.scope, hits: [], more: false, selected: null, context: [], error: "", busy: true }), () => {

      this.timer = setTimeout(() => this.search(), 250);

    });

  };

  search = async (more = false) => {

    const version = ++this.version;
    const query = this.state.query.trim();

    if (!query) {

      this.setState({ busy: false, hits: [], more: false });
      return;

    }

    this.setState({ busy: true, error: "" });

    try {

      const params = new URLSearchParams({ q: query, scope: this.state.scope, offset: String(more ? this.state.hits.length : 0) });
      const result = await api<{ hits: SearchHit[]; more: boolean }>(`/search?${params}`);

      if (version === this.version) {

        this.setState((state) => ({ hits: more ? [...state.hits, ...result.hits] : result.hits, more: result.more, busy: false }));

      }

    } catch (err) {

      if (version === this.version) {

        this.setState({ error: String(err), busy: false });

      }

    }

  };

  open = async (selected: SearchHit) => {

    const version = ++this.version;

    this.setState({ selected, context: [], busy: true, error: "" });

    try {

      const context = await api<SearchHit[]>(`/search/context?source=${selected.source}&id=${selected.id}`);

      if (version === this.version) {

        this.setState({ context, busy: false }, () => this.match.current?.scrollIntoView({ block: "center" }));

      }

    } catch (err) {

      if (version === this.version) {

        this.setState({ error: String(err), busy: false });

      }

    }

  };

  render() {

    const { query, scope, hits, more, busy, error, selected, context } = this.state;

    return (

      <div className="flex h-full min-h-0 flex-col">

        <Bar title="Search" back="#/" />

        <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-3 px-6 pb-4">

          <div className="relative">

            <input ref={this.field} autoFocus type="search" aria-label="Search messages" placeholder="Search all conversations…" maxLength={200} value={query} onChange={(event) => this.change({ query: event.target.value })} className={`${inputClass} pr-12 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden`} />
            {query && <span className="absolute top-1/2 right-1 -translate-y-1/2"><IconButton label="Clear search" onClick={() => { this.change({ query: "" }); this.field.current?.focus(); }}><X size={18} /></IconButton></span>}

          </div>
          <Select
            label="Conversation"
            wide
            value={scope}
            onChange={(scope) => this.change({ scope })}
            options={[

              { value: "", label: "All conversations", icon: <Users size={16} /> },
              ...this.props.agents.map((agent) => ({ value: `agent:${agent.id}`, label: agent.name, icon: <UserRound size={16} /> })),
              ...this.props.groups.map((group) => ({ value: `group:${group.id}`, label: group.name, icon: <Users size={16} /> })),

            ]}
          />

        </div>

        <div className="min-h-0 grow overflow-y-auto">

          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 pb-6">

            {error && <p role="alert" className="text-danger">{error}</p>}
            {selected ? (

              <>

                <div className="flex items-center justify-between gap-3">

                  <Button onClick={() => { this.version += 1; this.setState({ selected: null, context: [], busy: false, error: "" }); }}>Back to results</Button>
                  <a href={`#/${selected.source}/${selected.threadId}`} className="text-sm underline">Open latest chat</a>

                </div>
                <p className="text-sm text-dim">{selected.title} · Messages around this match</p>
                {context.map((hit) => (

                  <div key={hit.id} ref={hit.id === selected.id ? this.match : undefined} className={`rounded-xl border p-4 ${hit.id === selected.id ? "border-fg/50 bg-panel" : "border-line"}`}>

                    <div className="mb-2 text-xs text-dim">{hit.author} · {new Date(hit.at).toLocaleString()}</div>
                    <div className="whitespace-pre-wrap wrap-anywhere">{highlighted(hit.text, query.trim())}</div>

                  </div>

                ))}
                {!busy && !context.length && <p className="text-dim">This message is no longer available.</p>}

              </>

            ) : (

              <>

                {!query.trim() && <p className="text-dim">Find past answers, requests, and decisions across your agents and groups.</p>}
                {!busy && query.trim() && !hits.length && !error && <p role="status" className="text-dim">No matching messages.</p>}
                {hits.map((hit) => (

                  <button key={`${hit.source}:${hit.id}`} type="button" onClick={() => this.open(hit)} className="rounded-xl border border-line p-4 text-left hover:bg-panel">

                    <div className="mb-2 text-xs text-dim">{hit.title} · {hit.author} · {new Date(hit.at).toLocaleString()}</div>
                    <div className="whitespace-pre-wrap wrap-anywhere">{highlighted(excerpt(hit.text, query.trim()), query.trim())}</div>

                  </button>

                ))}
                {more && <Button disabled={busy} onClick={() => this.search(true)}>Load more results</Button>}

              </>

            )}
            {busy && <p role="status" className="text-dim">Loading…</p>}

          </div>

        </div>

      </div>

    );

  }

}
