"use client";

import { useState, useEffect, useCallback } from "react";
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

export function ModelConfigTab() {
  const [models, setModels] = useState<ModelConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state for add/edit
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormState>(defaultFormState);
  const [catalogModels, setCatalogModels] = useState<ProviderCatalogModel[]>([]);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showApiKeyInput, setShowApiKeyInput] = useState<Record<string, boolean>>({});

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
    loadModels();
  }, [loadModels]);

  // When provider changes in form, load catalog models
  const handleProviderChange = useCallback(async (provider: string | null) => {
    if (!provider) return;
    setFormData((prev) => ({ ...prev, provider, name: "" }));
    if (provider && provider !== "openai-compatible" && provider !== "mock") {
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
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteModelConfig(id);
      await loadModels();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      // Set this one as default, unset others
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

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中…</div>;
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 rounded-md p-2">{error}</div>
      )}

      {/* Model list */}
      <div className="space-y-2">
        {models.map((model) => (
          <div
            key={model.id}
            className={`border rounded-lg p-3 space-y-2 ${
              !model.valid ? "border-destructive/50 bg-destructive/5" : ""
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{model.displayName}</span>
                {model.isDefault && (
                  <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">默认</span>
                )}
                {!model.valid && (
                  <span className="text-xs bg-destructive/10 text-destructive px-1.5 py-0.5 rounded">无效</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {!model.isDefault && model.valid && (
                  <Button variant="ghost" size="sm" onClick={() => handleSetDefault(model.id)}>
                    设为默认
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDelete(model.id)}
                >
                  删除
                </Button>
              </div>
            </div>

            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>供应商: {model.provider} · 模型: {model.name}</div>
              <div className="flex items-center gap-2">
                <span>API Key ({model.apiKeyEnvVar}):</span>
                {model.apiKeySet ? (
                  <span className="text-green-600">
                    ✅ 已配置{model.apiKeySuffix && ` (***${model.apiKeySuffix})`}
                  </span>
                ) : (
                  <span className="text-yellow-600">⚠️ 未配置</span>
                )}
                {!showApiKeyInput[model.id] ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-5 text-xs"
                    onClick={() => setShowApiKeyInput((prev) => ({ ...prev, [model.id]: true }))}
                  >
                    设置 Key
                  </Button>
                ) : (
                  <div className="flex items-center gap-1">
                    <Input
                      type="password"
                      className="h-5 text-xs w-48"
                      placeholder="输入 API Key"
                      value={apiKeyInput[model.id] ?? ""}
                      onChange={(e) => setApiKeyInput((prev) => ({ ...prev, [model.id]: e.target.value }))}
                    />
                    <Button size="sm" className="h-5 text-xs" onClick={() => handleSetApiKey(model.id)}>
                      保存
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 text-xs"
                      onClick={() => setShowApiKeyInput((prev) => ({ ...prev, [model.id]: false }))}
                    >
                      取消
                    </Button>
                  </div>
                )}
              </div>
              {!model.valid && model.invalidReason && (
                <div className="text-destructive">原因: {model.invalidReason}</div>
              )}
            </div>
          </div>
        ))}

        {models.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-4">暂无模型配置</div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button onClick={() => { setShowForm(true); setEditingId(null); setFormData(defaultFormState); }}>
          添加模型
        </Button>
        <Button variant="outline" onClick={handleReload}>
          重新加载配置
        </Button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="border rounded-lg p-4 space-y-3">
          <h4 className="font-medium text-sm">添加模型配置</h4>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">供应商</label>
              <Select value={formData.provider} onValueChange={handleProviderChange}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="选择供应商" />
                </SelectTrigger>
                <SelectContent>
                  {BUILTIN_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground">模型</label>
              {catalogModels.length > 0 ? (
                <Select value={formData.name} onValueChange={(v) => {
                  if (!v) return;
                  const catalogModel = catalogModels.find((m) => m.id === v);
                  setFormData((prev) => ({
                    ...prev,
                    name: v,
                    thinking: catalogModel?.reasoning ?? false,
                    vision: catalogModel?.input?.includes("image") ?? false,
                  }));
                }}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalogModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-8 text-sm"
                  placeholder="模型名称"
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                />
              )}
            </div>

            <div>
              <label className="text-xs text-muted-foreground">显示名称</label>
              <Input
                className="h-8 text-sm"
                placeholder="如 DeepSeek V4 Flash"
                value={formData.displayName}
                onChange={(e) => setFormData((prev) => ({ ...prev, displayName: e.target.value }))}
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground">配置 ID</label>
              <Input
                className="h-8 text-sm"
                placeholder="如 deepseek-v4-flash"
                value={formData.id}
                onChange={(e) => setFormData((prev) => ({ ...prev, id: e.target.value }))}
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground">API Key 环境变量名</label>
              <Input
                className="h-8 text-sm"
                placeholder="如 DEEPSEEK_API_KEY"
                value={formData.apiKeyEnvVar}
                onChange={(e) => setFormData((prev) => ({ ...prev, apiKeyEnvVar: e.target.value }))}
              />
            </div>

            {formData.provider === "openai-compatible" && (
              <div>
                <label className="text-xs text-muted-foreground">Base URL</label>
                <Input
                  className="h-8 text-sm"
                  placeholder="https://api.example.com/v1"
                  value={formData.baseUrl}
                  onChange={(e) => setFormData((prev) => ({ ...prev, baseUrl: e.target.value }))}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={formData.isDefault}
                onChange={(e) => setFormData((prev) => ({ ...prev, isDefault: e.target.checked }))}
              />
              设为默认
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={formData.thinking}
                onChange={(e) => setFormData((prev) => ({ ...prev, thinking: e.target.checked }))}
              />
              支持思考模式
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={formData.vision}
                onChange={(e) => setFormData((prev) => ({ ...prev, vision: e.target.checked }))}
              />
              支持图片输入
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={handleAdd} disabled={!formData.id || !formData.provider || !formData.name || !formData.displayName || !formData.apiKeyEnvVar}>
              确认添加
            </Button>
            <Button variant="outline" onClick={() => { setShowForm(false); setFormData(defaultFormState); }}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

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
