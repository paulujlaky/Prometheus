export interface Pair {

  find: string;
  replace: string;

}

const FIND_MARK = /^\s*(?:@@\s*FIND|<{5,}\s*SEARCH|@@\s*SEARCH)\s*$/i;
const REPLACE_MARK = /^\s*(?:@@\s*REPLACE|={5,}|>{5,}\s*REPLACE)\s*$/i;
const END_MARK = /^\s*(?:>{5,}\s*REPLACE|@@\s*END)\s*$/i;

/** Both the `@@ FIND` form we document and the `<<<<<<< SEARCH` form models arrive knowing. */
export function parsePairs(body: string): Pair[] {

  const lines = body.split("\n");
  const pairs: Pair[] = [];

  let find: string[] | null = null;
  let replace: string[] | null = null;

  const flush = () => {

    if (find && replace) {

      pairs.push({ find: find.join("\n"), replace: replace.join("\n") });

    }

    find = null;
    replace = null;

  };

  for (const line of lines) {

    if (FIND_MARK.test(line)) {

      flush();
      find = [];
      continue;

    }

    if (find && !replace && REPLACE_MARK.test(line)) {

      replace = [];
      continue;

    }

    if (replace && END_MARK.test(line)) {

      flush();
      continue;

    }

    if (replace) {

      replace.push(line);
      continue;

    }

    if (find) {

      find.push(line);

    }

  }

  flush();

  return pairs;

}
