import webpush, { type PushSubscription } from "web-push";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deletePushSub, HOME, listPushSubs } from "../Store";

const KEYS_FILE = join(HOME, "vapid.json");

// Apple rejects a localhost subject, so production needs a real mailto or https URL here
const SUBJECT = process.env.PTS_VAPID_SUBJECT ?? "mailto:pts@localhost";

function vapidKeys(): { publicKey: string; privateKey: string } {

  if (existsSync(KEYS_FILE)) {

    return JSON.parse(readFileSync(KEYS_FILE, "utf8"));

  }

  // generated once: rotating them silently would orphan every subscription the PWA holds
  const keys = webpush.generateVAPIDKeys();

  writeFileSync(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 });

  return keys;

}

const keys = vapidKeys();

webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);

export const VAPID_PUBLIC_KEY = keys.publicKey;

export interface Notice {

  title: string;
  body: string;

  agentId?: number;

}

export async function notify(notice: Notice) {

  await Promise.all(listPushSubs().map(async (json) => {

    const sub = JSON.parse(json) as PushSubscription;

    try {

      await webpush.sendNotification(sub, JSON.stringify(notice), { TTL: 3600 });

    } catch (err) {

      const status = (err as { statusCode?: number }).statusCode;

      // the browser threw this subscription away; it will never deliver again
      if (status === 404 || status === 410) {

        deletePushSub(sub.endpoint);

      }

    }

  }));

}
