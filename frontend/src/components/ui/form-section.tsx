"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface FormSectionProps {
  title: string
  children: React.ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  className?: string
}

export function FormSection({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
  className,
}: FormSectionProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen)

  return (
    <Card className={cn("rounded-xl shadow-sm", className)}>
      <CardHeader
        className={cn(
          "pb-4",
          collapsible && "cursor-pointer select-none"
        )}
        onClick={collapsible ? () => setIsOpen(!isOpen) : undefined}
      >
        <CardTitle className="flex items-center justify-between text-base font-semibold">
          {title}
          {collapsible && (
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                !isOpen && "-rotate-90"
              )}
            />
          )}
        </CardTitle>
      </CardHeader>
      {isOpen && <CardContent className="pt-0">{children}</CardContent>}
    </Card>
  )
}
