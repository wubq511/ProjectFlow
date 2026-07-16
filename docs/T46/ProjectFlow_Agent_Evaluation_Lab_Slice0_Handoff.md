# T46 Evaluation Lab Slice 0 实施交接

> Issue：[#94](https://github.com/wubq511/ProjectFlow/issues/94)
> 范围：Minimum Trustworthy Loop；不包含 Slice 1–4
> 状态：实现完成，等待 PR review/merge

## 1. 交付结论

本 Slice 提供一条可由本地 Coding Agent 直接调用的可信最小闭环：发现和零 Token 校验配置，启动 evaluator-owned backend/sidecar，复用 T43 `answer-no-tool` public HTTP/SSE 场景，执行确定性评分，保存可恢复 checkpoint，发布带 SHA-256 root 的 immutable result graph，并返回机器可读状态与相对报告路径。

Slice 0 只允许 `mock:mock-model`。真实付费模型在缺少冻结价格表和调用前最坏成本预估时以 exit `3` fail-closed；不能用“运行结束后拿到 provider cost”冒充调用前的 `$0.10` 硬上限。

## 2. Coding Agent 使用方式

所有命令从仓库根目录执行：

```bash
scripts/eval-lab list
scripts/eval-lab validate --preset smoke --model mock:mock-model
scripts/eval-lab run --preset smoke --model mock:mock-model --json
scripts/eval-lab status <run-id>
scripts/eval-lab verify <run-id>
scripts/eval-lab show <run-id>
```

中断恢复：

```bash
scripts/eval-lab run \
  --preset smoke \
  --model mock:mock-model \
  --run-id <run-id> \
  --resume \
  --json
```

稳定入口通过已跟踪的 `scripts/project-npm` 固定使用 Node.js `24.15.0` 与 npm `11.12.1`：优先使用当前 checkout 的 `scripts/node`/`scripts/npm`，worktree 会发现主 checkout 的同一稳定入口；只有 PATH 中的 Node/npm 与锁定版本完全一致时才允许回退。依赖继续由 `agent-bridge/package-lock.json` 锁定，不使用 `npx`，版本漂移以 exit `2/3` fail-closed。

## 3. 退出码

| Exit | 含义 | Coding Agent 动作 |
|---:|---|---|
| `0` | 通过 | 返回 summary、integrity root、artifact paths |
| `1` | ProjectFlow Agent 回归 | 查看 Grade/Observation，不归咎基础设施 |
| `2` | 基础设施或证据完整性失败 | 修 runner/environment，不能计入 Agent 分数 |
| `3` | 场景、schema、模型、预算或工具链无效 | 零 Token 修正配置后再运行 |
| `4` | 预算耗尽 | 保留 partial evidence，通过 `--resume` 继续兼容的未完成观察 |

## 4. 隔离边界

每次运行生成独立的：

- 临时根目录与 ownership marker；
- evaluation nonce、instance ID、demo admin token、internal service token；
- SQLite、uploads、`.env`、model config 副本和 artifact staging；
- loopback backend/sidecar process pair。

backend 和 sidecar health 必须同时返回 `APP_ENV=evaluation`、正确 service 和同一 instance ID。Seed/reset 同时验证 nonce、instance ID、ownership marker、绝对 SQLite 路径、真实路径 containment 和 upload containment。开发/生产 health、旧实例凭据、相对路径和 symlink escape 都不能通过 evaluator 身份证明。

## 5. 证据与恢复语义

最终目录：`agent-bridge/artifacts/<run-id>/`，默认被 Git ignore。

```text
manifest.json
status.json
observations/<scenario-id>.json
grades/<scenario-id>.json
checksums/*.json
report.json
integrity.json
```

- observation/grade 先写 evaluator temp staging，再用同目录 hard-link 原子发布；目标存在即拒绝覆盖；
- run/staging 子目录权限为 `0700`，immutable raw evidence 权限为 `0400`，mutable status/lock 权限为 `0600`；
- scenario checksum 是 checkpoint commit marker；缺少 marker 的崩溃残片会在 resume 前丢弃并重跑；
- `integrity.json` 是最终 result graph commit marker；它提交 manifest、observations、grades、checksums 和 report；
- report 记录 Git commit、dirty state、worktree hash、scenario hash、model-config hash、evaluator/public-seam version和运行时版本；
- resume 必须匹配完整场景、预算、模型和代码/工作树指纹；不匹配直接拒绝；
- `verify` 在返回结果前重新计算所有 hash 和 integrity root。

`integrityRootSha256` 应由调用 Coding Agent 一并返回。它是本地 tamper-evidence anchor；若需要跨机器或长期第三方证明，后续 Slice 应把 root 发布到独立可信位置，而不是宣称本地自存 hash 可以抵抗拥有同一账户写权限的攻击者。

## 6. 成本语义

每个 Observation 和汇总分别记录：

- `sutCost`：ProjectFlow Agent；计入 smoke `$0.10`；
- `evaluatorModelCost`：Judge/Simulator；Slice 0 没有模型调用，冻结估计为 `$0`；
- `codingAgentCost`：Codex/Claude Code/Trae 等外部开发 Agent；保持 `unknown`，不计入 SUT cap。

每个 bucket 同时记录 `amountUsd`、`source` 和 `countedAgainstSutCap`。来源只能是 `provider_reported`、`versioned_price_estimate` 或 `unknown`。Slice 0 还执行 input/output token、model request、observation 和 wall-time ceiling。request 与 wall-time 在 runtime 启动前形成硬边界；input/output/cost 在每个模型响应产生 telemetry 时立即中断后续步骤。预算中断事件携带截至中断点的真实 metrics，partial checkpoint 不得把已观测用量重写为 0。

## 7. 明确非目标

- 不实现 full/calibrate、语义 Judge、专家金标、RCA、Repair Packet 或 Dashboard；
- 不把 mock smoke 结果表述为真实用户满意度或生产质量；
- 不自动运行任何付费模型；
- 不修改 Proposal-Confirm、ProjectMemory、会话隐私或现有 Agent Runtime 事实边界。

## 8. 验收命令

```bash
cd backend
.venv/bin/python -m pytest app/tests/ -q
.venv/bin/python -m ruff check app

cd ../agent-bridge
../scripts/eval-lab validate --preset smoke --model mock:mock-model
../scripts/project-npm run test
../scripts/project-npm run typecheck
../scripts/project-npm run build

cd ..
git diff --check main...HEAD
```
