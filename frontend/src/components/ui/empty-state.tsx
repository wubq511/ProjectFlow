"use client"

import * as React from "react"
import { FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
  className?: string
}

export function EmptyState({
  icon = <FolderOpen className="h-12 w-12 text-muted-foreground/60" />,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center",
        className
      )}
    >
      <div className="mb-4">{icon}</div>
      <h3 className="mb-1 text-base font-semibold">{title}</h3>
      {description && (
        <p className="mb-4 max-w-xs text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && (
        <Button onClick={action.onClick} size="sm">
          {action.label}
        </Button>
      )}
    </div>
  )
}
