"use client"

import * as React from "react"
import { X, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

interface TagInputProps {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  suggestions?: string[]
  placeholder?: string
  maxTags?: number
  className?: string
}

export function TagInput({
  tags,
  onTagsChange,
  suggestions = [],
  placeholder = "输入后按回车添加",
  maxTags = 10,
  className,
}: TagInputProps) {
  const [inputValue, setInputValue] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement>(null)

  const addTag = (tag: string) => {
    const trimmed = tag.trim()
    if (!trimmed) return
    if (tags.includes(trimmed)) return
    if (tags.length >= maxTags) return
    onTagsChange([...tags, trimmed])
    setInputValue("")
  }

  const removeTag = (tagToRemove: string) => {
    onTagsChange(tags.filter((tag) => tag !== tagToRemove))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      addTag(inputValue)
    } else if (e.key === "Backspace" && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    }
  }

  const availableSuggestions = suggestions.filter(
    (s) => !tags.includes(s) && s.toLowerCase().includes(inputValue.toLowerCase())
  )

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className={cn(
          "flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5",
          "focus-within:ring-1 focus-within:ring-ring"
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="flex items-center gap-1 px-2 py-0.5"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeTag(tag)
              }}
              className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : ""}
          className="h-7 min-w-20 flex-1 border-0 bg-transparent px-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>
      {availableSuggestions.length > 0 && inputValue.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground">建议：</span>
          {availableSuggestions.slice(0, 5).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => addTag(suggestion)}
              className="inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
            >
              <Plus className="h-3 w-3" />
              {suggestion}
            </button>
          ))}
        </div>
      )}
      {tags.length >= maxTags && (
        <p className="text-xs text-muted-foreground">最多 {maxTags} 个标签</p>
      )}
    </div>
  )
}
