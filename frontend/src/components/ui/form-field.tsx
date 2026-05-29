"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

interface FormFieldProps {
  label: string
  required?: boolean
  error?: string
  hint?: string
  children: React.ReactNode
  className?: string
}

export function FormField({
  label,
  required = false,
  error,
  hint,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={cn("mb-5", className)}>
      <Label className="mb-1.5 flex items-center gap-1 text-sm font-medium">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {hint && !error && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
