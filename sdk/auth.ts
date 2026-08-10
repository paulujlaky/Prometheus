export interface SessionInfo {

  userId: string;
  orgId: string | null;
  preferredAssistantId: string | null;
  cookie: string;

}

function parseCookieMap(cookie: string): Map<string, string> {

  const map = new Map<string, string>();

  for (const part of cookie.split(";")) {

    const trimmed = part.trim();

    if (!trimmed) {

      continue;

    }

    const eq = trimmed.indexOf("=");

    if (eq === -1) {

      continue;

    }

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();

    map.set(key, value);

  }

  return map;

}

function decodeJwtPayload(token: string): Record<string, unknown> {

  const segments = token.split(".");

  if (segments.length < 2) {

    throw new Error("Cookie JWT is malformed (expected three segments)");

  }

  const payload = segments[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");

  return JSON.parse(json) as Record<string, unknown>;

}

function unquote(value: string): string {

  let v = value;

  try {

    v = decodeURIComponent(v);

  } catch {

    // keep raw if not URI-encoded
  }

  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("%22") && v.endsWith("%22"))) {

    // already decoded quotes fall through
  }

  if (v.startsWith('"') && v.endsWith('"')) {

    return v.slice(1, -1);

  }

  return v;

}

export function parseSession(cookie: string): SessionInfo {

  const cookies = parseCookieMap(cookie.trim());
  const d = cookies.get("d");

  if (!d) {

    throw new Error('Cookie must include the "d" JWT (session token)');

  }

  const payload = decodeJwtPayload(d);
  const userId = payload.userId;

  if (typeof userId !== "string" || !userId) {

    throw new Error('JWT payload missing "userId"');

  }

  let orgId: string | null = null;
  const teamRaw = cookies.get("teamID");

  if (teamRaw) {

    orgId = unquote(teamRaw);

  }

  let preferredAssistantId: string | null = null;
  const preferredRaw = cookies.get("preferred-chat-assistant");

  if (preferredRaw) {

    try {

      const decoded = decodeURIComponent(preferredRaw);
      const parsed = JSON.parse(decoded) as { assistantId?: string };

      if (typeof parsed.assistantId === "string") {

        preferredAssistantId = parsed.assistantId;

      }

    } catch {

      // optional preference
    }

  }

  return {

    userId,
    orgId,
    preferredAssistantId,
    cookie: cookie.trim(),

  };

}
