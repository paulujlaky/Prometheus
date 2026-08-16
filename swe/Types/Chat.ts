export interface SweChat {

  id: string;
  name: string;
  title: string;
  modified: number;

  /** Normalized project root when known; null/undefined = unassigned. */
  project?: string | null;

  /** Chat that spawned this row; set only while a subagent is running. */
  parentId?: string | null;

  /** A live subagent, not a real chat — it has no id on the server and vanishes when the child ends. */
  subagent?: boolean;

}
