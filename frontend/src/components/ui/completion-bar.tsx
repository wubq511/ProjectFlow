"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"

interface CompletionBarProps {
  percentage: number
  label?: string
  showPercentage?: boolean
  size?: "sm" | "md"
  className?: string
}

export function CompletionBar({
  percentage,
  label,
  showPercentage = true,
  size = "md",
  className,
}: CompletionBarProps) {
  const clamped = Math.min(100, Math.max(0, percentage))

  return (
    <div className={cn("space-y-1.5", className)}>
      {(label || showPercentage) && (
        <div className="flex items-center justify-between text-sm">
          {label && <span className="text-muted-foreground">{label}</span>}
          {showPercentage && (
            <span className="font-medium">{Math.round(clamped)}%</span>
          )}
        </div>
      )}
      <Progress
        value={clamped}
        className={cn(
          size === "sm" ? "h-1.5" : "h-2"
        )}
      />
    </div>
  )
}
