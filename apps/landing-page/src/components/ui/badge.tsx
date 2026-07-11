import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-3 py-1 text-[0.72rem] font-bold uppercase tracking-[0.08em]",
  {
    variants: {
      variant: {
        default:
          "border-[color:var(--color-line)] bg-[rgba(248,251,252,0.8)] text-[var(--color-ink)]",
        subtle:
          "border-transparent bg-[rgba(87,200,234,0.12)] text-[var(--color-ink)]",
        inverse:
          "border-white/10 bg-white/10 text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
