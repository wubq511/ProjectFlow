# T42 ProjectMemory V1: Optional Vector Extra & Dependency Guardrails

> Issue #77 · User stories 34, 35, 36, 33

## Overview

ProjectMemory V1 默认使用 **FTS5 + jieba** 中文分词检索，零外部依赖、零网络下载。向量检索作为可选增强，通过 `memory-vector` extra 显式启用。

## 安装

### 默认安装（轻量）

```bash
pip install -e ".[dev]"
```

不安装 torch、sentence-transformers、sqlite-vec 或任何 embedding 模型文件。

### 向量增强安装

```bash
pip install -e ".[dev,memory-vector]"
```

安装 sentence-transformers（自动拉取 torch）和 sqlite-vec。

## 检索 Fallback Chain

```
prefer_vector=True  →  vector  →  fts5  →  sqlite_field  →  none
prefer_vector=False →  fts5  →  sqlite_field  →  none  (默认)
```

- `vector`：sqlite-vec 向量相似度检索（需要 memory-vector extra + warmup）
- `fts5`：SQLite FTS5 全文检索 + jieba 中文分词（默认）
- `sqlite_field`：结构化字段 LIKE 检索（FTS5 不可用时的 fallback）
- `none`：所有检索方式失败

`memory_backend` 始终反映**实际使用的后端**，而非安装状态。即使安装了 memory-vector，如果向量初始化失败，backend 会报告 `fts5`。

## Warmup

```bash
# 无 memory-vector extra → 打印跳过信息，exit 0
python -m app.memory.warmup

# 有 memory-vector extra → 初始化模型，exit 0
python -m app.memory.warmup

# 初始化失败 → 打印错误信息，exit 1
```

Warmup 会下载/缓存配置的 embedding 模型到本地目录。FTS5 检索始终可用，不受 warmup 结果影响。

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `MEMORY_VECTOR_ENABLED` | `false` | 是否优先使用向量检索 |
| `MEMORY_VECTOR_MODEL` | `shibing624/text2vec-base-chinese` | 中文 embedding 模型 |
| `MEMORY_VECTOR_MODEL_DIR` | 空（自动 `data/memory-models/`） | 模型缓存目录 |

## 模型存储

模型文件存储在 `backend/data/memory-models/`，已加入 `.gitignore`。

## 测试

### 默认环境测试（不需要 vector extra）

```bash
pytest app/tests/test_memory_vector_guardrails.py -v
```

验证：
- 默认安装不包含向量依赖
- retriever 模块不触发向量 import
- warmup 无 extra 时跳过
- prefer_vector=True 降级到 FTS5
- memory_backend 反映实际后端

### 向量专属测试（需要 memory-vector extra）

```bash
pip install -e ".[memory-vector]"
pytest app/tests/test_memory_vector.py -v
```

这些测试在默认 CI 中自动 skip，不阻塞主测试路径。

## 降级语义

| 场景 | 行为 |
|------|------|
| memory-vector 未安装 | prefer_vector=True → 直接跳到 FTS5，无报错 |
| sqlite-vec 扩展加载失败 | 打印 warning，降级到 FTS5 |
| embedding 模型初始化失败 | 打印 warning，降级到 FTS5 |
| 向量检索运行时异常 | 打印 warning，降级到 FTS5 |
| FTS5 也不可用 | 降级到 sqlite_field |
| 全部不可用 | backend=none，返回空列表 |

所有降级均保持 FTS5 检索功能不受影响。
