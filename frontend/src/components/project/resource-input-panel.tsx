"use client"

import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Plus, X, FileText, Link2, File, ChevronDown, Check, Pencil } from "lucide-react"
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
import { uploadFile } from "@/lib/api"
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

function resourceSummary(res: AddResourceRequest): string {
  if (res.type === "text_note") return res.content_text?.slice(0, 40) || ""
  if (res.type === "link") return res.url || ""
  if (res.type === "file_stub") return res.file_name || ""
  return ""
}

export function ResourceInputPanel({ onChange }: ResourceInputPanelProps) {
  const [resources, setResources] = React.useState<AddResourceRequest[]>([])
  const [isOpen, setIsOpen] = React.useState(true)
  const [collapsed, setCollapsed] = React.useState(new Set<number>())
  const [selectOpenIndex, setSelectOpenIndex] = React.useState<number | null>(null)

  // 下拉菜单打开时，页面滚动即自动关闭
  React.useEffect(() => {
    if (selectOpenIndex === null) return
    const close = () => setSelectOpenIndex(null)
    document.addEventListener("scroll", close, { capture: true })
    return () => document.removeEventListener("scroll", close, { capture: true })
  }, [selectOpenIndex])

  const addResource = () => {
    const updated = [
      ...resources,
      { type: "text_note" as const, title: "", content_text: "" },
    ]
    setResources(updated)
    onChange(updated)
    // 新添加的资源自动展开
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(updated.length - 1)
      return next
    })
  }

  const removeResource = (index: number) => {
    const updated = resources.filter((_, i) => i !== index)
    setResources(updated)
    onChange(updated)
    // 清理折叠状态中已删除的索引
    setCollapsed((prev) => {
      const next = new Set<number>()
      prev.forEach((i) => {
        if (i < index) next.add(i)
        else if (i > index) next.add(i - 1)
      })
      return next
    })
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

  const confirmResource = (index: number) => {
    const res = resources[index]
    if (!res.title.trim()) {
      // 标题为空时自动补默认值
      const defaultTitle =
        res.type === "file_stub" ? (res.file_name || "文件引用")
        : res.type === "link" ? (res.url || "链接")
        : (res.content_text?.slice(0, 20) || "文本笔记")
      updateResource(index, { title: defaultTitle })
    }
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.add(index)
      return next
    })
  }

  const expandResource = (index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(index)
      return next
    })
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
            initial={{ opacity: 0, maxHeight: 0 }}
            animate={{ opacity: 1, maxHeight: 500 }}
            exit={{ opacity: 0, maxHeight: 0 }}
            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
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
                  const isCollapsed = collapsed.has(index)

                  return (
                    <motion.div
                      key={index}
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.15, ease: [0.25, 1, 0.5, 1] }}
                      className="rounded-lg border bg-background"
                    >
                      {/* 折叠状态：摘要条 */}
                      {isCollapsed ? (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => expandResource(index)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              expandResource(index)
                            }
                          }}
                          className="flex w-full items-center justify-between rounded-lg p-3 text-left hover:bg-muted/50 transition-colors cursor-pointer"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <Badge variant="secondary" className="shrink-0 text-xs">
                              {typeLabels[res.type]}
                            </Badge>
                            <span className="truncate text-sm font-medium">
                              {res.title || "未命名资源"}
                            </span>
                            {resourceSummary(res) && (
                              <span className="truncate text-xs text-muted-foreground">
                                — {resourceSummary(res)}
                              </span>
                            )}
                          </div>
                          <div className="ml-2 flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => expandResource(index)}
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
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
                        </div>
                      ) : (
                        /* 展开状态：完整表单 */
                        <div className="p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Icon className="h-4 w-4 text-muted-foreground" />
                              <Badge variant="secondary" className="text-xs">
                                {typeLabels[res.type]}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => confirmResource(index)}
                                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-green-600"
                              >
                                <Check className="h-3 w-3" />
                                确认
                              </Button>
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
                          </div>

                          <div className="mt-3 space-y-3">
                            <div className="space-y-1">
                              <Label className="text-xs text-muted-foreground">
                                类型
                              </Label>
                              <Select
                                value={res.type}
                                open={selectOpenIndex === index}
                                onOpenChange={(open) =>
                                  setSelectOpenIndex(open ? index : null)
                                }
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
                                  文件
                                </Label>
                                <input
                                  type="file"
                                  id={`file-pick-${index}`}
                                  className="hidden"
                                  onChange={async (e) => {
                                    const file = e.target.files?.[0]
                                    if (!file) return
                                    const title = res.title.trim()
                                    updateResource(index, {
                                      file_name: "上传中...",
                                      title: title || file.name,
                                    })
                                    try {
                                      const result = await uploadFile(file)
                                      updateResource(index, {
                                        file_name: result.file_id,
                                        title: title || result.original_name,
                                      })
                                    } catch {
                                      updateResource(index, {
                                        file_name: file.name,
                                      })
                                    }
                                    e.target.value = ""
                                  }}
                                />
                                <div className="flex items-center gap-2">
                                  <Input
                                    value={res.file_name ?? ""}
                                    onChange={(e) =>
                                      updateResource(index, {
                                        file_name: e.target.value,
                                      })
                                    }
                                    placeholder="选择文件上传，或手动输入路径..."
                                    className="flex-1 text-sm"
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      document.getElementById(`file-pick-${index}`)?.click()
                                    }
                                    className="h-9 shrink-0 gap-1 text-xs"
                                  >
                                    <File className="h-3.5 w-3.5" />
                                    选择文件
                                  </Button>
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                  选择文件后将自动上传，也可手动输入路径或链接
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
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
