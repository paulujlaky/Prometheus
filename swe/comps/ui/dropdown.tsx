import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const CONTENT = "z-50 max-h-(--radix-dropdown-menu-content-available-height) w-(--radix-dropdown-menu-trigger-width) min-w-32 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/15 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";
const SUB_CONTENT = "z-50 min-w-24 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg bg-popover p-1.5 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/15 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const ITEM = "relative flex cursor-default items-center gap-1.5 rounded-md text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

interface InsetProps {

  inset?: boolean;

}

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {

  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;

}

function DropdownMenuTrigger({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {

  return (

    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      className={cn(
        "outline-none ring-0 focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0",
        className,
      )}
      {...props}
    />

  );

}

function DropdownMenuContent({ className, align = "start", sideOffset = 4, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {

  return (

    <DropdownMenuPrimitive.Portal>

      <DropdownMenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} align={align} className={cn(CONTENT, className)} {...props} />

    </DropdownMenuPrimitive.Portal>

  );

}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {

  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;

}

function DropdownMenuRadioItem({ className, children, inset, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & InsetProps) {

  return (

    <DropdownMenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" data-inset={inset} className={cn(ITEM, "py-1.5 pr-8 pl-2", className)} {...props} >

      <span className="pointer-events-none absolute right-2 flex items-center justify-center" data-slot="dropdown-menu-radio-item-indicator" >

        <DropdownMenuPrimitive.ItemIndicator>

          <CheckIcon />

        </DropdownMenuPrimitive.ItemIndicator>

      </span>

      {children}

    </DropdownMenuPrimitive.RadioItem>

  );

}

function DropdownMenuLabel({ className, inset, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & InsetProps) {

  return (

    <DropdownMenuPrimitive.Label data-slot="dropdown-menu-label" data-inset={inset} className={cn("px-2 py-1.5 text-sm font-medium text-muted-foreground data-inset:pl-7", className)} {...props} />

  );

}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {

  return (

    <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />

  );

}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {

  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;

}

function DropdownMenuSubTrigger({ className, inset, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & InsetProps) {

  return (

    <DropdownMenuPrimitive.SubTrigger data-slot="dropdown-menu-sub-trigger" data-inset={inset} className={cn(ITEM, "px-2 py-1.5 data-open:bg-accent data-open:text-accent-foreground", className)} {...props} >

      {children}

      <ChevronRightIcon className="ml-auto" />

    </DropdownMenuPrimitive.SubTrigger>

  );

}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {

  return (

    <DropdownMenuPrimitive.SubContent data-slot="dropdown-menu-sub-content" className={cn(SUB_CONTENT, className)} {...props} />

  );

}

export {

  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,

};
