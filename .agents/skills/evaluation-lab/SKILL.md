---
name: evaluation-lab
description: 通过自然语言请求安全地发现、校验、运行、轮询和核验 ProjectFlow Agent 本地评测，并返回机器可读结论与报告路径。
---

# ProjectFlow Evaluation Lab

从仓库根目录使用唯一稳定入口 `scripts/eval-lab`。不要使用裸 `npm`、`npx`、直接调用 `tsx`，也不要手动启动开发数据库参与评测。

## Agent 执行顺序

1. 零 Token 校验：

   ```bash
   scripts/eval-lab validate --preset smoke --model mock:mock-model
   ```

2. 运行 Slice 0 smoke：

   ```bash
   scripts/eval-lab run --preset smoke --model mock:mock-model --json
   ```

3. 长任务轮询：

   ```bash
   scripts/eval-lab status <run-id>
   ```

4. 中断后恢复：

   ```bash
   scripts/eval-lab run --preset smoke --model mock:mock-model --run-id <run-id> --resume --json
   ```

5. 返回结果前验证证据链：

   ```bash
   scripts/eval-lab verify <run-id>
   ```

需要完整报告时使用 `scripts/eval-lab show <run-id>`；发现能力和场景时使用 `scripts/eval-lab list`。

Slice 1 的完整确定性验收使用：

```bash
scripts/eval-lab run --preset full --model mock:mock-model --json
scripts/eval-lab verify <run-id>
scripts/eval-lab exit-gate <run-id> --json
scripts/eval-lab reliability <run-id> --json
```

`reliability` 对没有显式重复组的单次运行应返回 evidence 不足，不能把不同场景伪装成重复试验。对比分支时由评测器创建隔离 worktree/runtime，不要手工复用正在开发的进程或数据库：

```bash
scripts/eval-lab compare --candidate <git-ref> --baseline <git-ref> --preset smoke --model mock:mock-model --json
```

## 退出码

- `0`：通过
- `1`：ProjectFlow Agent 回归
- `2`：基础设施失败
- `3`：配置、模型或标准校验失败
- `4`：预算耗尽或统计证据不足，已保留 partial evidence

最终答复必须包含 `status`、`summary`、`integrityRootSha256` 和 `artifactPaths`。Coding Agent 自身费用不计入 ProjectFlow Agent 的 `$0.10` smoke 上限；若外部费用不可测，保持 `unknown`，不得伪报为 `$0.00`。
