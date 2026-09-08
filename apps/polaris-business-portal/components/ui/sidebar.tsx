import * as React from "react";
import { cn } from "@/lib/utils";

export function Sidebar({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <aside className={cn("hidden h-screen w-80 shrink-0 flex-col border-r bg-card/80 backdrop-blur md:flex", className)} {...props} />;
}

export function SidebarHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-3 border-b p-4", className)} {...props} />;
}

export function SidebarContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-1 flex-col gap-1 overflow-auto p-4 pt-3", className)} {...props} />;
}

export function SidebarMenuButton({ className, "data-active": dataActive, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { "data-active"?: boolean }) {
  return (
    <button
      data-active={dataActive}
      className={cn("flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground", className)}
      {...props}
    />
  );
}

export function SidebarMenuSub({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ml-4 flex flex-col gap-1 border-l pl-2", className)} {...props} />;
}

export function SidebarMenuSubButton({ className, "data-active": dataActive, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { "data-active"?: boolean }) {
  return (
    <button
      data-active={dataActive}
      className={cn("flex h-8 w-full items-center rounded-md px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[active=true]:bg-primary data-[active=true]:font-medium data-[active=true]:text-primary-foreground", className)}
      {...props}
    />
  );
}
