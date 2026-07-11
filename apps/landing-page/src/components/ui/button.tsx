import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--color-ink)] text-white shadow-[0_16px_40px_rgba(24,35,33,0.18)] hover:-translate-y-0.5",
        outline:
          "border border-[color:var(--color-line-strong)] bg-[rgba(248,251,252,0.76)] text-[var(--color-ink)] hover:-translate-y-0.5",
        ghost:
          "bg-transparent text-white border border-white/25 hover:-translate-y-0.5",
        subtle:
          "bg-[rgba(87,200,234,0.12)] text-[var(--color-ink)] hover:-translate-y-0.5",
      },
      size: {
        default: "min-h-11 px-5 py-2.5",
        sm: "min-h-9 px-4 py-2 text-xs",
        lg: "min-h-12 px-6 py-3 text-base",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
