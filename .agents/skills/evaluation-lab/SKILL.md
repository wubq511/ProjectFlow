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

Slice 2 (Issue #97) 的诊断与修复路径：先对失败 observation 运行 `diagnose` 生成 evidence-graded diagnosis；再运行 `rca-benchmark` 验证 RCA 准确率/反事实/false attribution/calibration 五个 gate；运行 `repair-packet` 生成 immutable Repair Packet 与 Coding Agent 修复 prompt；`fault-catalog` 单独校验 8 类 fault profile 的完整性。

```bash
scripts/eval-lab diagnose <run-id> --json
scripts/eval-lab rca-benchmark <run-id> --json
scripts/eval-lab repair-packet <run-id> --packet-id <optional-id> --json
scripts/eval-lab fault-catalog --json
```

`diagnose` 对全 pass 的 run 返回 `diagnosis_skipped` (exit 0)；`repair-packet` 在没有 diagnosis 时返回 `repair_packets_empty` (exit 0)；`rca-benchmark` 通过 5 个 gate (`top1Accuracy ≥ 0.5`、`falseAttributionRate ≤ 0.3`、`confidenceCalibration ≥ 0.7`、`evidenceCompleteness ≥ 0.7`、`top3Recall - top1Accuracy ≤ 0.4`) 才返回 `passed: true`。Repair Packet 包含 schema version 1、fix/investigation gate、scrub (secrets / temp paths / hidden facts / hidden reasoning)、stale detection 和 candidate regression governance，不可绕过 frozen standards。

Slice 3 (Issue #98，已合并关闭) 的 governed calibration 与 semantic standards 路径：先 `validate --preset calibrate` 做零 Token JSON 校验；再 `calibrate <run-id>` 运行 15 步 calibration pipeline 产出 immutable calibration artifact（active/candidate registries 严格分离、6 类 standard conflict pattern、5 类 verdict、6 类 bias metric、9 类 fail-safe、三类 cost provenance）；`promote-standard` 是唯一构造 promotion approval record 的命令，必须显式 `--approver-robert`，禁止任何 Agent/Judge/普通命令自动 promotion；`conflict-catalog` 单独校验 6 类 frozen conflict pattern 的完整性。

```bash
scripts/eval-lab validate --preset calibrate --model mock:mock-model
scripts/eval-lab calibrate <run-id> --json
scripts/eval-lab promote-standard \
  --candidate-id <id> --approver-robert \
  --diff-path <path> --commit <sha> \
  --before-fingerprint <fp> --after-fingerprint <fp> --json
scripts/eval-lab conflict-catalog --json
```

`calibrate` 在 mock Judge 下完整跑通（不调用付费模型）；fail-safe 触发时仍产出 artifact（保留 partial evidence），active registry 必须 byte-identical；`promote-standard` 必须显式 `--approver-robert`，否则 exit `3`。ProjectFlow deterministic hard gates 永远优先；Semantic Judge 默认只是 soft evidence；`semanticHardGateEligible` 默认 `false`，必须由独立校准证据单独提升，不能由单次成功 Judge 调用冒充。Cost provenance 三类：`provider_reported` / `versioned_price_estimate` / `unknown`；unknown cost 不得显示为 `$0`。SUT 预算上限 `$3`，不包含 Coding Agent 与 evaluator Judge。本 ticket 验收使用 mock/deterministic Judge。

## 退出码

- `0`：通过
- `1`：ProjectFlow Agent 回归
- `2`：基础设施失败
- `3`：配置、模型或标准校验失败
- `4`：预算耗尽或统计证据不足，已保留 partial evidence

最终答复必须包含 `status`、`summary`、`integrityRootSha256` 和 `artifactPaths`。Coding Agent 自身费用不计入 ProjectFlow Agent 的 `$0.10` smoke 上限；若外部费用不可测，保持 `unknown`，不得伪报为 `$0.00`。
