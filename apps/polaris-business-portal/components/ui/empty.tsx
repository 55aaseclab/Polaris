import * as React from "react";
import { cn } from "@/lib/utils";

export function Empty({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center", className)} {...props} />;
}

export function EmptyTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-medium", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("max-w-sm text-sm text-muted-foreground", className)} {...props} />;
}
