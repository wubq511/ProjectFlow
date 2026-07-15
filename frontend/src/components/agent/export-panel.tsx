"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { exportReviewSummary } from "@/lib/api";

type ExportPanelProps = {
  projectId: string;
};

export function ExportPanel({ projectId }: ExportPanelProps) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const result = await exportReviewSummary(projectId);
      setMarkdown(result.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制到剪贴板失败");
    }
  };

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">导出评审摘要</h2>
          <p className="mt-1 text-sm text-ink/60">
            生成可用于项目评审的 Markdown 摘要。
          </p>
        </div>
        <Button
          disabled={loading}
          onClick={handleExport}
          className="bg-ink text-white hover:bg-ink/85"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {loading ? "生成中..." : "生成摘要"}
        </Button>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-coral/20 bg-coral/10 p-3 text-sm text-coral">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <div className="flex-1">
            <p>{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              className="mt-1 h-7 text-xs"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              重试
            </Button>
          </div>
        </div>
      )}

      {markdown && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold tracking-wider text-ink/45">
              预览
            </p>
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
          </div>
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-ink/5 p-4 text-xs text-ink/80">
            {markdown}
          </pre>
        </div>
      )}
    </section>
  );
}
