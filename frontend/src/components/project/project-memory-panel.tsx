"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProjectMemory } from "@/lib/types";
import {
  exportProjectMemoriesMarkdown,
  listProjectMemories,
} from "@/lib/api";

type MemoryTopic = {
  key: string;
  title: string;
  typeSet: Set<string>;
  historical: boolean;
};

const TOPICS: MemoryTopic[] = [
  { key: "direction", title: "方向与边界", typeSet: new Set(["direction", "boundary"]), historical: false },
  { key: "rejection", title: "被拒绝方案", typeSet: new Set(["rejection"]), historical: false },
  { key: "assignment", title: "分工与资源", typeSet: new Set(["assignment", "member_constraint"]), historical: false },
  { key: "tradeoff", title: "重排取舍", typeSet: new Set(["plan", "tradeoff"]), historical: false },
  { key: "historical", title: "被替代或归档的历史判断", typeSet: new Set(), historical: true },
];

const SOURCE_TYPE_CN: Record<string, string> = {
  direction_card_confirmed: "方向卡确认",
  proposal_rejected: "方案拒绝",
  assignment_confirmed: "分工确认",
  replan_confirmed: "重排确认",
  replan_rejected: "重排拒绝",
};

const VISIBILITY_CN: Record<string, string> = {
  team: "团队可见",
  subject_and_owner: "相关成员和负责人可见",
};

const STATUS_CN: Record<string, string> = {
  active: "有效",
  superseded: "已被替代",
  archived: "已归档",
};

function memoryMatchesTopic(memory: ProjectMemory, topic: MemoryTopic): boolean {
  if (topic.historical) {
    return memory.status === "superseded" || memory.status === "archived";
  }
  return topic.typeSet.has(memory.memory_type);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "长期";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

export type ProjectMemoryPanelProps = {
  projectId: string;
  projectName: string;
  currentUserId?: string;
};

export function ProjectMemoryPanel({ projectId, projectName, currentUserId }: ProjectMemoryPanelProps) {
  const [memories, setMemories] = useState<ProjectMemory[]>([]);
  const [loading, setLoading] = useState(Boolean(currentUserId));
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchMemories = useCallback(async () => {
    if (!currentUserId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await listProjectMemories(projectId, currentUserId);
      setMemories(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "加载项目记忆失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    let ignore = false;
    listProjectMemories(projectId, currentUserId)
      .then((data) => {
        if (!ignore) setMemories(data);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : "加载项目记忆失败");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [projectId, currentUserId]);

  const grouped = useMemo(() => {
    const map = new Map<string, ProjectMemory[]>();
    for (const topic of TOPICS) {
      const items = memories.filter((m) => memoryMatchesTopic(m, topic));
      if (items.length > 0) {
        map.set(topic.title, items);
      }
    }
    return map;
  }, [memories]);

  const hasMemories = grouped.size > 0;

  const handleExport = async () => {
    if (!currentUserId) return;
    setExporting(true);
    setExportError(null);
    setMarkdown(null);
    setCopied(false);
    try {
      const md = await exportProjectMemoriesMarkdown(projectId, currentUserId);
      setMarkdown(md);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "导出 Markdown 失败");
    } finally {
      setExporting(false);
    }
  };

  const handleDownload = () => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName}-项目记忆.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setExportError("复制到剪贴板失败");
    }
  };

  if (!currentUserId) {
    return (
      <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-neutral-400" />
          <h2 className="text-lg font-bold text-ink">项目记忆</h2>
        </div>
        <div className="mt-4 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-200 p-6 text-center">
          <AlertCircle className="h-6 w-6 text-neutral-300" />
          <p className="text-sm text-neutral-500">请在左侧选择当前成员身份后查看项目记忆。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-bold text-ink">项目记忆</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchMemories}
            disabled={loading}
            className="h-8 text-xs"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1">{loading ? "加载中" : "刷新"}</span>
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            disabled={exporting}
            className="h-8 bg-moss text-xs text-white hover:bg-moss/85"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            <span className="ml-1">{exporting ? "导出中" : "导出 Markdown"}</span>
          </Button>
        </div>
      </div>

      <p className="mt-1 text-sm text-neutral-500">
        只读展示当前身份可见的项目决策记忆，按主题聚合。
      </p>

      {(error || exportError) && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-coral/20 bg-coral/10 p-3 text-sm text-coral">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <p>{error ?? exportError}</p>
            {(error || exportError) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (error) fetchMemories();
                  if (exportError) handleExport();
                }}
                className="mt-1 h-7 text-xs"
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                重试
              </Button>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div className="mt-6 flex items-center justify-center gap-2 py-10 text-sm text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载项目记忆…
        </div>
      )}

      {!loading && !error && memories.length === 0 && (
        <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-200 py-10 text-center">
          <BookOpen className="h-8 w-8 text-neutral-300" />
          <p className="text-sm text-neutral-500">暂无可见项目记忆</p>
          <p className="text-xs text-neutral-400">确认方向卡、拒绝方案、分工或重排计划后会自动生成。</p>
        </div>
      )}

      {!loading && hasMemories && (
        <div className="mt-6 space-y-6">
          {Array.from(grouped.entries()).map(([topicTitle, items]) => (
            <div key={topicTitle}>
              <h3 className="text-sm font-semibold text-neutral-900">{topicTitle}</h3>
              <ul className="mt-2 space-y-3">
                {items.map((memory) => (
                  <li
                    key={memory.id}
                    className={cn(
                      "rounded-lg border p-3 transition-colors",
                      memory.status === "active"
                        ? "border-neutral-100 bg-neutral-50/50 hover:bg-neutral-50"
                        : "border-neutral-100 bg-neutral-50/30 text-neutral-500"
                    )}
                  >
                    <p className="text-sm font-medium text-neutral-900">{memory.content}</p>
                    <p className="mt-1 text-xs text-neutral-500">{memory.rationale}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {SOURCE_TYPE_CN[memory.source_type] ?? memory.source_type}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          memory.status === "active" && "border-moss/30 text-moss",
                          memory.status === "superseded" && "border-amber-400/50 text-amber-600",
                          memory.status === "archived" && "border-neutral-300 text-neutral-500"
                        )}
                      >
                        {STATUS_CN[memory.status] ?? memory.status}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {VISIBILITY_CN[memory.visibility] ?? memory.visibility}
                      </Badge>
                      <span className="text-[10px] text-neutral-400">
                        有效期 {formatDateTime(memory.valid_until)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {markdown && (
        <div className="mt-6 border-t border-neutral-100 pt-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-neutral-900">Markdown 导出预览</p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="h-7 text-xs"
              >
                {copied ? (
                  <>
                    <CheckCircle2 className="mr-1 h-3 w-3 text-moss" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-3 w-3" />
                    复制
                  </>
                )}
              </Button>
              <Button
                size="sm"
                onClick={handleDownload}
                className="h-7 bg-ink text-xs text-white hover:bg-ink/85"
              >
                <Download className="mr-1 h-3 w-3" />
                下载
              </Button>
            </div>
          </div>
          <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-neutral-50 p-4 text-xs text-neutral-700">
            {markdown}
          </pre>
        </div>
      )}
    </section>
  );
}
