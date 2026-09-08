"use client";

import * as React from "react";
import { GripVertical } from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
} from "react-resizable-panels";
import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof Group>) {
  return <Group className={cn("h-full w-full", className)} {...props} />;
}

const ResizablePanel = Panel;

function ResizableHandle({
  className,
  withHandle = false,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}) {
  return (
    <Separator
      className={cn(
        "group relative flex w-px items-center justify-center bg-border outline-none transition-colors hover:bg-primary/50 focus-visible:bg-primary/50 data-[separator-active]:bg-primary/60",
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex size-5 items-center justify-center rounded-sm border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <GripVertical className="size-3" aria-hidden="true" />
        </div>
      ) : null}
    </Separator>
  );
}

export {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useDefaultLayout,
  usePanelRef,
};
