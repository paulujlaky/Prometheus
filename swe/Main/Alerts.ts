import { Notification } from "electron";

import { APP_ICON, getWindow } from "./Window";

export const NOTICES = {

  done: "The agent has finished.",

  approval: "Approval is needed to run a command.",
  approvalRisky: "Approval is needed to run a risky command.",

  ask: "The agent is waiting on your input.",
  plan: "The agent is waiting for you to review a plan.",

} as const;

export function alertUser(title: string, body: string) {

  const window = getWindow();

  if (window?.isFocused()) return;
  if (Notification.isSupported()) new Notification({ title, body, icon: APP_ICON }).show();

  window?.flashFrame(true);

}
