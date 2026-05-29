"use client"

import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Plus, X, FileText, Link2, File, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { AddResourceRequest } from "@/lib/types"

interface ResourceInputPanelProps {
  onChange: (resources: AddResourceRequest[]) => void
}

const typeIcons: Record<string, React.ElementType> = {
  text_note: FileText,
  link: Link2,
  file_stub: File,
}

const typeLabels: Record<string, string> = {
  text_note: "文本笔记",
  link: "链接",
  file_stub: "文件",
}

export function ResourceInputPanel({ onChange }: ResourceInputPanelProps) {
  const [resources, setResources] = React.useState<AddResourceRequest[]>([])
  const [isOpen, setIsOpen] = React.useState(true)

  const addResource = () => {
    const updated = [
      ...resources,
      { type: "text_note" as const, title: "", content_text: "" },
    ]
    setResources(updated)
    onChange(updated)
  }

  const removeResource = (index: number) => {
    const updated = resources.filter((_, i) => i !== index)
    setResources(updated)
    onChange(updated)
  }

  const updateResource = (
    index: number,
    updates: Partial<AddResourceRequest>
  ) => {
    const updated = resources.map((r, i) =>
      i === index ? { ...r, ...updates } : r
    )
    setResources(updated)
    onChange(updated)
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between rounded-lg border border-dashed px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          {resources.length > 0
            ? `已添加 ${resources.length} 个资源`
            : "添加现有资源"}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-4 rounded-lg border bg-card p-4">
              {resources.length === 0 && (
                <p className="py-3 text-center text-sm text-muted-foreground">
                  还没有添加资源，点击下方按钮添加文本笔记、链接或文件引用
                </p>
              )}

              <AnimatePresence>
                {resources.map((res, index) => {
                  const Icon = typeIcons[res.type] ?? FileText
                  return (
                    <motion.div
                      key={index}
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.15 }}
                      className="rounded-lg border bg-background p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <Badge variant="secondary" className="text-xs">
                            {typeLabels[res.type]}
                          </Badge>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeResource(index)}
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>

                      <div className="mt-3 space-y-3">
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">
                            类型
                          </Label>
                          <Select
                            value={res.type}
                            onValueChange={(v) =>
                              updateResource(index, {
                                type: v as AddResourceRequest["type"],
                                content_text:
                                  v === "text_note"
                                    ? (res.content_text ?? "")
                                    : null,
                                url:
                                  v === "link" ? (res.url ?? "") : null,
                                file_name:
                                  v === "file_stub"
                                    ? (res.file_name ?? "")
                                    : null,
                              })
                            }
                          >
                            <SelectTrigger className="text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="text_note">文本笔记</SelectItem>
                              <SelectItem value="link">链接</SelectItem>
                              <SelectItem value="file_stub">文件引用</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">
                            标题 *
                          </Label>
                          <Input
                            value={res.title}
                            onChange={(e) =>
                              updateResource(index, { title: e.target.value })
                            }
                            placeholder="资源标题"
                            className="text-sm"
                          />
                        </div>

                        {res.type === "text_note" && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              内容
                            </Label>
                            <Textarea
                              value={res.content_text ?? ""}
                              onChange={(e) =>
                                updateResource(index, {
                                  content_text: e.target.value,
                                })
                              }
                              placeholder="在此粘贴或输入内容..."
                              rows={3}
                              className="text-sm"
                            />
                          </div>
                        )}

                        {res.type === "link" && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              URL
                            </Label>
                            <Input
                              value={res.url ?? ""}
                              onChange={(e) =>
                                updateResource(index, { url: e.target.value })
                              }
                              placeholder="https://..."
                              className="text-sm"
                            />
                          </div>
                        )}

                        {res.type === "file_stub" && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              文件名
                            </Label>
                            <Input
                              value={res.file_name ?? ""}
                              onChange={(e) =>
                                updateResource(index, {
                                  file_name: e.target.value,
                                })
                              }
                              placeholder="document.pdf"
                              className="text-sm"
                            />
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )
                })}
              </AnimatePresence>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addResource}
                className="gap-1 text-xs"
              >
                <Plus className="h-3 w-3" />
                添加资源
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
