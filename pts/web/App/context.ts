import { createContext } from "react";

import type { Agent } from "../Lib/api";

/** Every agent, for anything that turns a name into a glyph: mentions, authors, suggestions. */
export const AgentsContext = createContext<Agent[]>([]);
