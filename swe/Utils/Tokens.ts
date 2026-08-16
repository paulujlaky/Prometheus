// Local token estimates.
export function estimateTokens(text: string): number {

  if (!text) {

    return 0;

  }

  return Math.max(1, Math.ceil(text.length / 4));

}

/** Compact human label: 1.2k, 128k, etc. */
export function formatTokens(n: number): string {

  if (n < 1000) {

    return String(n);

  }

  if (n < 10_000) {

    return `${(n / 1000).toFixed(1)}k`;

  }

  if (n < 1_000_000) {

    return `${Math.round(n / 1000)}k`;

  }

  return `${(n / 1_000_000).toFixed(1)}M`;

}

export interface ContextUsage {

  used: number;
  limit: number;

  /** 0–1, capped at 1 for the bar */
  ratio: number;

}

export function usageOf(used: number, limit: number): ContextUsage {

  const safeLimit = Math.max(1, limit);

  return {

    used,

    limit: safeLimit,
    ratio: Math.min(1, used / safeLimit),

  };

}
