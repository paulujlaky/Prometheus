/** Gets a stable project key (forward slashes, no trailing slash, drive letter uppercased). */
export function normalizeDir(path: string | null | undefined): string {

  if (!path) {

    return "";

  }

  let next = path.replace(/\\/g, "/");

  if (next.length > 3 && next.endsWith("/")) {

    next = next.replace(/\/+$/, "");

  } else if (next.length > 1 && next.endsWith("/") && !/^[A-Za-z]:\/$/.test(next)) {

    next = next.replace(/\/+$/, "");

  }

  if (/^[a-zA-Z]:/.test(next)) {

    next = `${next[0].toUpperCase()}${next.slice(1)}`;

  }

  return next;

}

export function folderLabel(path: string): string {

  const parts = normalizeDir(path).split("/").filter(Boolean);

  return parts[parts.length - 1] || path || "Unknown";

}

export function fileName(path: string): string {

  const parts = path.replaceAll("\\", "/").split("/");

  return parts[parts.length - 1] || path;

}

export function sameDir(a: string | null | undefined, b: string | null | undefined): boolean {

  const left = normalizeDir(a);
  const right = normalizeDir(b);

  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());

}
