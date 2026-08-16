// Runs a batch again, but for only the blocks that failed.

import type { Action } from "../Agent/Protocol";

const RANGE = /^(\d+)\s*(?:-|–|—|to)\s*(\d+)$/;

/** 1-based positions in the held batch, or null for all of them. */
export function parseRetryRange(action: Action): number[] | null {

  const text = `${action.path} ${action.body}`.replace(/\s+/g, " ").trim();

  if (!text) {

    return null;

  }

  const picked: number[] = [];

  for (const part of text.split(/[\s,]+/).filter(Boolean)) {

    const range = RANGE.exec(part);

    if (range) {

      const from = Number(range[1]);
      const to = Number(range[2]);

      if (from < 1 || to < from) {

        throw new Error(`retry: "${part}" is not a range. Use <retry 2-4>, <retry 1,3>, or bare <retry> for every held block.`);

      }

      for (let n = from; n <= to; n += 1) {

        picked.push(n);

      }

      continue;

    }

    if (!/^\d+$/.test(part)) {

      throw new Error(`retry takes block numbers, not "${part}". Use <retry 2-4>, <retry 1,3>, or bare <retry> for every held block.`);

    }

    picked.push(Number(part));

  }

  return picked.length ? [...new Set(picked)].sort((a, b) => a - b) : null;

}

/** One line per held block, so a bad number can be answered with what the numbers actually are. */
function listing(cancelled: Action[]): string {

  return cancelled.map((action, index) => `  ${index + 1}. <${action.verb}${action.path ? ` ${action.path}` : ""}>${action.label ? ` — ${action.label}` : ""}`).join("\n");

}

export function selectRetry(cancelled: Action[], picked: number[] | null): Action[] {

  if (!cancelled.length) {

    throw new Error("Nothing is held to retry — every block in your last reply ran. Send the block itself.");

  }

  if (!picked) {

    return cancelled;

  }

  const bad = picked.filter((n) => n > cancelled.length);

  if (bad.length) {

    throw new Error(`retry ${bad.join(", ")}: only ${cancelled.length} ${cancelled.length === 1 ? "block is" : "blocks are"} held.\n\n${listing(cancelled)}`);

  }

  return picked.map((n) => cancelled[n - 1]);

}
