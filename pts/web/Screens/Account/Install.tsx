import { Share, SquarePlus } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { Torch } from "../../Components/Layout";

// iOS only lets an installed web app keep its session, push notifications and full screen
export const mustInstall = /iphone|ipad|ipod/i.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches && !(navigator as Navigator & { standalone?: boolean }).standalone;

function Step({ n, children }: { n: number; children: ReactNode }) {

  return (

    <li className="flex items-start gap-4">

      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-raised text-[15px] font-medium">{n}</span>
      <span className="pt-1.5 text-[15px] leading-relaxed text-dim">{children}</span>

    </li>

  );

}

export function Install() {

  return (

    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-[max(24px,env(safe-area-inset-top))]">

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }} className="flex w-full max-w-sm flex-col gap-8">

        <div className="flex flex-col items-center gap-4 text-center">

          <Torch size={64} />
          <h1 className="m-0 font-serif text-[34px] font-normal">Install Prometheus</h1>

        </div>

        <ol className="m-0 flex list-none flex-col gap-5 rounded-2xl border border-line bg-panel p-6">

          <Step n={1}>Tap <Share size={16} className="mx-0.5 mb-1 inline text-fg" /> <strong className="font-medium text-fg">Share</strong> in Safari’s toolbar</Step>
          <Step n={2}>Scroll down and tap <SquarePlus size={16} className="mx-0.5 mb-1 inline text-fg" /> <strong className="font-medium text-fg">Add to Home Screen</strong></Step>
          <Step n={3}>Tap <strong className="font-medium text-fg">Add</strong>, then open Prometheus from your Home Screen</Step>

        </ol>

      </motion.div>

    </div>

  );

}
