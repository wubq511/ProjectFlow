"use client";

import * as React from "react";
import { File, FileText, Link2, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AddResourceRequest, ProjectResource } from "@/lib/types";

type ProjectResourcesPanelProps = {
  resources: ProjectResource[];
  pending?: boolean;
  onAddResource?: (resource: AddResourceRequest) => void | Promise<void>;
};

const labels: Record<ProjectResource["type"], string> = {
  text_note: "文本笔记",
  link: "链接",
  file_stub: "文件引用",
};

const icons: Record<ProjectResource["type"], React.ElementType> = {
  text_note: FileText,
  link: Link2,
  file_stub: File,
};

export function ProjectResourcesPanel({
  resources,
  pending,
  onAddResource,
}: ProjectResourcesPanelProps) {
  const [type, setType] = React.useState<AddResourceRequest["type"]>("text_note");
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const canSubmit = Boolean(onAddResource && title.trim() && content.trim());

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onAddResource?.({
        type,
        title: title.trim(),
        content_text: type === "text_note" ? content.trim() : null,
        url: type === "link" ? content.trim() : null,
        file_name: type === "file_stub" ? content.trim() : null,
      });
      setTitle("");
      setContent("");
      setType("text_note");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-bold text-ink">项目资源</h2>
        <p className="mt-1 text-sm text-ink/60">训练营要求、文档链接和当前约束</p>
      </div>

      {resources.length === 0 ? (
        <div className="mt-5 rounded-lg border border-dashed border-ink/15 bg-paper/70 p-5 text-sm text-ink/55">
          暂无资源
        </div>
      ) : (
        <div className="mt-5 grid gap-2">
          {resources.map((resource) => {
            const Icon = icons[resource.type];
            return (
              <article key={resource.id} className="rounded-lg border border-ink/10 bg-paper/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon className="h-4 w-4 text-moss" />
                  <p className="font-semibold text-ink">{resource.title}</p>
                  <span className="rounded-full bg-ink/8 px-2 py-0.5 text-xs text-ink/55">
                    {labels[resource.type]}
                  </span>
                </div>
                {resource.url ? (
                  <a
                    className="mt-2 block break-all text-sm text-moss underline-offset-2 hover:underline"
                    href={resource.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {resource.url}
                  </a>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink/65">
                    {resource.content_text ?? resource.file_name}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {onAddResource && (
        <div className="mt-5 grid gap-3 rounded-lg border border-ink/8 bg-paper/60 p-4 md:grid-cols-[140px_1fr]">
          <Select value={type} onValueChange={(value) => setType(value as AddResourceRequest["type"])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text_note">文本笔记</SelectItem>
              <SelectItem value="link">链接</SelectItem>
              <SelectItem value="file_stub">文件引用</SelectItem>
            </SelectContent>
          </Select>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="资源标题" />
          <div className="md:col-span-2">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={3}
              placeholder={type === "link" ? "https://..." : "资源内容"}
            />
          </div>
          <div className="md:col-span-2">
            <Button size="sm" disabled={!canSubmit || pending || submitting} onClick={submit}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              添加资源
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
