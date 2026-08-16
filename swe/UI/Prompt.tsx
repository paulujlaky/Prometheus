import type { ButtonHTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";

import { cn } from "@/Utils/Class";
import { fadeUp } from "@/Utils/Motion";

export function PromptDock({ children }: { children: ReactNode }) {

  return (

    <motion.div className="mx-auto w-full max-w-3xl px-5 pb-2"

      initial={fadeUp.initial}
      animate={fadeUp.animate}
      exit={fadeUp.exit}

      transition={fadeUp.transition}

    >

      {children}

    </motion.div>

  );

}

export function PromptCard({ children, className }: { children: ReactNode; className?: string }) {

  return (

    <div className={cn("overflow-hidden rounded-card bg-surface shadow-card", className)}>

      {children}

    </div>

  );

}

export function PromptIcon({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "red" }) {

  return (

    <span className={cn(

      "flex size-6 shrink-0 items-center justify-center rounded-full",
      tone === "red" ? "bg-red text-white" : "bg-ink text-page",

    )}>

      {children}

    </span>

  );

}

export function PromptHeader({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {

  return (

    <div className="flex shrink-0 items-center gap-2.5 p-3.5">

      {children}

      {trailing}

    </div>

  );

}

export function PromptBody({ children, className }: { children: ReactNode; className?: string }) {

  return <div className={cn("border-t border-line bg-inset px-3.5 py-3", className)}>{children}</div>;

}

export function PromptFooter({ children }: { children: ReactNode }) {

  return <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3.5 py-3">{children}</div>;

}

const ACTION = {

  ghost: "flex h-9 items-center gap-2 rounded-control px-3 text-[13px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink",
  primary: "flex h-9 items-center gap-2 rounded-control bg-ink px-3 text-[13px] font-medium text-page transition-[background-color,transform] duration-100 hover:bg-ink/85 active:scale-[0.97]",
  danger: "flex h-9 items-center gap-2 rounded-control bg-red px-3 text-[13px] font-medium text-white transition-[background-color,transform] duration-100 hover:bg-red/85 active:scale-[0.97]",
  muted: "flex h-9 cursor-not-allowed items-center gap-2 rounded-control bg-field px-3 text-[13px] font-medium text-ink-3",

} as const;

interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {

  tone?: keyof typeof ACTION;

}

export function ActionButton({ tone = "ghost", className, type = "button", ...props }: ActionButtonProps) {

  return <button type={type} className={cn(ACTION[tone], className)} {...props} />;

}
