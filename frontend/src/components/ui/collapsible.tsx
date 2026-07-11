"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import type { ReactNode } from "react"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  )
}

interface CollapsibleContentProps {
  children?: ReactNode
  className?: string
  id?: string
}

function CollapsibleContent({ children, className, id }: CollapsibleContentProps) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      id={id}
      className="grid transition-[grid-template-rows_200ms_ease-out] [&[data-closed]]:grid-rows-[0fr] [&[data-open]]:grid-rows-[1fr] [&>div]:overflow-hidden"
    >
      <div className={className}>{children}</div>
    </CollapsiblePrimitive.Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
