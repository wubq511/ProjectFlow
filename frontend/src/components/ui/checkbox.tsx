"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, children, id: idProp, ...props }, ref) => {
    const generatedId = React.useId();
    const id = idProp ?? generatedId;
    return (
      <label
        htmlFor={id}
        className={cn(
          "inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300",
          props.disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      >
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded border border-neutral-300 bg-white transition-colors dark:border-neutral-700 dark:bg-neutral-900">
          <input
            ref={ref}
            id={id}
            type="checkbox"
            className="peer sr-only"
            {...props}
          />
          <Check className="h-3 w-3 text-white opacity-0 transition-opacity peer-checked:opacity-100" />
          <span className="pointer-events-none absolute inset-0 rounded opacity-0 transition-opacity peer-checked:bg-moss peer-checked:opacity-100 peer-focus-visible:ring-2 peer-focus-visible:ring-moss/50" />
        </span>
        {label ?? children}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";
