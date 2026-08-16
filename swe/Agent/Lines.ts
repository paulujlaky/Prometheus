const BULLET = /^[-*•]\s+/;
const NUMBERED = /^\d+[.)]\s+/;

export function isMarked(line: string): boolean {

  return BULLET.test(line) || NUMBERED.test(line);

}

export function unmark(line: string): string {

  return line.replace(BULLET, "").replace(NUMBERED, "").trim();

}

export function bodyLines(body: string): string[] {

  return body.split("\n").map((line) => line.trim()).filter(Boolean);

}
