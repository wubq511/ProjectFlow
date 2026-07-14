"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  getModelConfigs,
  addModelConfig,
  updateModelConfig,
  deleteModelConfig,
  setModelApiKey,
  reloadModelConfigs,
  getProviderCatalogModels,
  BUILTIN_PROVIDERS,
} from "@/lib/api";
import type { ModelConfigEntry, ProviderCatalogModel } from "@/lib/types";

interface FormState {
  id: string;
  provider: string;
  name: string;
  displayName: string;
  baseUrl: string;
  baseUrlEnvVar: string;
  apiKeyEnvVar: string;
  isDefault: boolean;
  thinking: boolean;
  vision: boolean;
}

const defaultFormState: FormState = {
  id: "",
  provider: "",
  name: "",
  displayName: "",
  baseUrl: "",
  baseUrlEnvVar: "",
  apiKeyEnvVar: "",
  isDefault: false,
  thinking: false,
  vision: false,
};

export function ModelConfigTab() {
  const [models, setModels] = useState<ModelConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<FormState>(defaultFormState);
  const [catalogModels, setCatalogModels] = useState<ProviderCatalogModel[]>([]);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showApiKeyInput, setShowApiKeyInput] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const loadModels = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getModelConfigs();
      setModels(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getModelConfigs()
      .then((data) => {
        if (cancelled) return;
        setModels(data);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProviderChange = useCallback(async (provider: string | null) => {
    if (!provider) return;
    setFormData((prev) => ({ ...prev, provider, name: "" }));
    if (provider !== "openai-compatible" && provider !== "mock") {
      try {
        const catalog = await getProviderCatalogModels(provider);
        setCatalogModels(catalog);
      } catch {
        setCatalogModels([]);
      }
    } else {
      setCatalogModels([]);
    }
  }, []);

  const handleAdd = async () => {
    setSubmitting(true);
    try {
      await addModelConfig({
        id: formData.id,
        provider: formData.provider,
        name: formData.name,
        displayName: formData.displayName,
        baseUrl: formData.baseUrl || undefined,
        baseUrlEnvVar: formData.baseUrlEnvVar || undefined,
        apiKeyEnvVar: formData.apiKeyEnvVar,
        isDefault: formData.isDefault,
        capabilities: { thinking: formData.thinking, vision: formData.vision },
      });
      setShowForm(false);
      setFormData(defaultFormState);
      await loadModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("确定要删除这条模型配置吗？")) return;
    try {
      await deleteModelConfig(id);
      await loadModels();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await updateModelConfig(id, { isDefault: true });
      await loadModels();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSetApiKey = async (id: string) => {
    const key = apiKeyInput[id];
    if (!key) return;
    try {
      await setModelApiKey(id, key);
      setApiKeyInput((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setShowApiKeyInput((prev) => ({ ...prev, [id]: false }));
      await loadModels();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReload = async () => {
    try {
      await reloadModelConfigs();
      await loadModels();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const canSubmit =
    formData.id &&
    formData.provider &&
    formData.name &&
    formData.displayName &&
    formData.apiKeyEnvVar;

  if (loading) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 text-neutral-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-xs">加载模型配置…</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">模型配置</h3>
          <p className="mt-1 text-xs text-neutral-500">
            管理可用的模型供应商、API Key 和默认模型。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={handleReload}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重新加载
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => {
              setShowForm(true);
              setFormData(defaultFormState);
              setCatalogModels([]);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            添加模型
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-coral/20 bg-coral/5 p-3 text-xs text-coral">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-3">
        {models.map((model) => (
          <div
            key={model.id}
            className={cn(
              "rounded-xl border bg-white p-4 transition-shadow",
              model.valid
                ? "border-neutral-100 shadow-sm"
                : "border-coral/30 bg-coral/[0.02]",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-900">
                    {model.displayName}
                  </span>
                  {model.isDefault && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-moss/10 px-2 py-0.5 text-[10px] font-medium text-moss">
                      <Check className="h-3 w-3" />
                      默认
                    </span>
                  )}
                  {!model.valid && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-coral/10 px-2 py-0.5 text-[10px] font-medium text-coral">
                      <TriangleAlert className="h-3 w-3" />
                      无效
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                  <span>供应商：{model.provider}</span>
                  <span>模型：{model.name}</span>
                </div>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-neutral-400 hover:text-neutral-700"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">操作</span>
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="min-w-32">
                  {!model.isDefault && model.valid && (
                    <DropdownMenuItem
                      className="text-xs"
                      onClick={() => handleSetDefault(model.id)}
                    >
                      <Check className="mr-2 h-3.5 w-3.5" />
                      设为默认
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-xs text-coral focus:text-coral"
                    onClick={() => handleDelete(model.id)}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-neutral-50/70 px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs">
                <KeyRound className="h-3.5 w-3.5 text-neutral-400" />
                <span className="text-neutral-500">
                  {model.apiKeyEnvVar}
                </span>
                {model.apiKeySet ? (
                  <span className="inline-flex items-center gap-1 font-medium text-moss">
                    <Check className="h-3 w-3" />
                    已配置
                    {model.apiKeySuffix && (
                      <span className="text-neutral-400">
                        （***{model.apiKeySuffix}）
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-amber-600">
                    <TriangleAlert className="h-3 w-3" />
                    未配置
                  </span>
                )}
              </div>

              {!showApiKeyInput[model.id] ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-neutral-600 hover:bg-white hover:text-neutral-900"
                  onClick={() =>
                    setShowApiKeyInput((prev) => ({ ...prev, [model.id]: true }))
                  }
                >
                  {model.apiKeySet ? "更新 Key" : "设置 Key"}
                </Button>
              ) : (
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Input
                    type="password"
                    className="h-7 flex-1 text-xs sm:w-48"
                    placeholder="输入 API Key"
                    value={apiKeyInput[model.id] ?? ""}
                    onChange={(e) =>
                      setApiKeyInput((prev) => ({
                        ...prev,
                        [model.id]: e.target.value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleSetApiKey(model.id)}
                    disabled={!apiKeyInput[model.id]}
                  >
                    保存
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() =>
                      setShowApiKeyInput((prev) => ({
                        ...prev,
                        [model.id]: false,
                      }))
                    }
                  >
                    取消
                  </Button>
                </div>
              )}
            </div>

            {!model.valid && model.invalidReason && (
              <p className="mt-2 text-xs text-coral">{model.invalidReason}</p>
            )}
          </div>
        ))}

        {models.length === 0 && !error && (
          <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50 py-10 text-center">
            <p className="text-sm text-neutral-500">暂无模型配置</p>
            <p className="mt-1 text-xs text-neutral-400">
              点击右上角「添加模型」开始配置
            </p>
          </div>
        )}
      </div>

      {showForm && (
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-medium text-neutral-900">
              添加模型配置
            </h4>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-neutral-400 hover:text-neutral-700"
              onClick={() => {
                setShowForm(false);
                setFormData(defaultFormState);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">
                供应商
              </label>
              <Select
                value={formData.provider}
                onValueChange={handleProviderChange}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="选择供应商" />
                </SelectTrigger>
                <SelectContent>
                  {BUILTIN_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">
                模型
              </label>
              {catalogModels.length > 0 ? (
                <Select
                  value={formData.name}
                  onValueChange={(v) => {
                    if (!v) return;
                    const catalogModel = catalogModels.find((m) => m.id === v);
                    setFormData((prev) => ({
                      ...prev,
                      name: v,
                      thinking: catalogModel?.reasoning ?? false,
                      vision: catalogModel?.input?.includes("image") ?? false,
                    }));
                  }}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalogModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-9 text-sm"
                  placeholder="模型名称"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">
                显示名称
              </label>
              <Input
                className="h-9 text-sm"
                placeholder="如 DeepSeek V4 Flash"
                value={formData.displayName}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    displayName: e.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">
                配置 ID
              </label>
              <Input
                className="h-9 text-sm"
                placeholder="如 deepseek-v4-flash"
                value={formData.id}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, id: e.target.value }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">
                API Key 环境变量名
              </label>
              <Input
                className="h-9 text-sm"
                placeholder="如 DEEPSEEK_API_KEY"
                value={formData.apiKeyEnvVar}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    apiKeyEnvVar: e.target.value,
                  }))
                }
              />
            </div>

            {formData.provider === "openai-compatible" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-neutral-700">
                  Base URL
                </label>
                <Input
                  className="h-9 text-sm"
                  placeholder="https://api.example.com/v1"
                  value={formData.baseUrl}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      baseUrl: e.target.value,
                    }))
                  }
                />
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-300 text-moss focus:ring-moss"
                checked={formData.isDefault}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    isDefault: e.target.checked,
                  }))
                }
              />
              设为默认
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-300 text-moss focus:ring-moss"
                checked={formData.thinking}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    thinking: e.target.checked,
                  }))
                }
              />
              支持思考模式
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-300 text-moss focus:ring-moss"
                checked={formData.vision}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    vision: e.target.checked,
                  }))
                }
              />
              支持图片输入
            </label>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setShowForm(false);
                setFormData(defaultFormState);
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={handleAdd}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              确认添加
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
