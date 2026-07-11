import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-11 w-full rounded-full border border-[color:var(--color-line-strong)] bg-[rgba(248,251,252,0.9)] px-4 py-2 text-sm text-[var(--color-ink)] placeholder:text-[rgba(24,35,33,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)] focus-visible:ring-offset-2",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";

export { Input };
