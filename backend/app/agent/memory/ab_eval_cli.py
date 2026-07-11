"""Command-line entry point for the R8 Agent A/B effect evaluation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from sqlmodel import Session

from app.agent.memory.ab_eval import (
    ABEvalConfig,
    DirectAPIRunner,
    MockAgentRunner,
    SCENARIOS,
    ScenarioId,
    SidecarAgentRunner,
    compute_full_metrics,
    deserialize_run_bundle,
    generate_report,
    generate_blind_review_rows,
    run_ab_eval,
    serialize_run_bundle,
    validate_fixture_project_isolation,
    write_scenario_memories,
)
from app.core.config import settings
from app.core.database import engine


def _parse_scenarios(parser: argparse.ArgumentParser, values: list[str] | None):
    if not values:
        return SCENARIOS
    available = {scenario_id.value: scenario_id for scenario_id in ScenarioId}
    unknown = [value for value in values if value not in available]
    if unknown:
        parser.error(
            f"unknown scenario(s): {', '.join(unknown)}; "
            f"available: {', '.join(available)}"
        )
    selected = {available[value] for value in values}
    return [scenario for scenario in SCENARIOS if scenario.scenario_id in selected]


def _require_real_args(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    required = {
        "--workspace-id": args.workspace_id,
        "--project-id": args.project_id,
        "--conversation-id": args.conversation_id,
        "--owner-user-id": args.owner_user_id,
        "--member-user-id": args.member_user_id,
        "--viewer-user-id": args.viewer_user_id,
        "--privacy-viewer-user-id": args.privacy_viewer_user_id,
    }
    missing = [flag for flag, value in required.items() if not value]
    if missing:
        parser.error("real evaluation requires " + ", ".join(missing))


def validate_release_pilot_config(config: ABEvalConfig) -> None:
    """Validate one scenario slice of the 150-pair release Pilot."""
    if config.instances != 10 or config.repeats != 3:
        raise ValueError("release Pilot requires exactly 10 variants and 3 repeats")
    if config.scenarios is None or len(config.scenarios) != 1:
        raise ValueError("release Pilot must run exactly one scenario per dedicated project")


def validate_release_aggregate(
    a_runs: list,
    b_runs: list,
) -> None:
    """Validate the combined five-scenario 150-pair release dataset."""
    expected_scenarios = {scenario.scenario_id for scenario in SCENARIOS}
    if {run.scenario_id for run in a_runs} != expected_scenarios:
        raise ValueError("release aggregate must include all five scenarios")
    if {run.scenario_id for run in b_runs} != expected_scenarios:
        raise ValueError("release aggregate must include all five scenarios")

    for scenario_id in expected_scenarios:
        scenario_a = [run for run in a_runs if run.scenario_id == scenario_id]
        scenario_b = [run for run in b_runs if run.scenario_id == scenario_id]
        if len(scenario_a) != 30 or len(scenario_b) != 30:
            raise ValueError(
                f"{scenario_id.value} must contain 30 A and 30 B runs"
            )
        expected_cells = {(instance, repeat) for instance in range(10) for repeat in range(3)}
        if {(run.instance, run.repeat) for run in scenario_a} != expected_cells:
            raise ValueError(f"{scenario_id.value} A runs do not cover 10 variants x 3 repeats")
        if {(run.instance, run.repeat) for run in scenario_b} != expected_cells:
            raise ValueError(f"{scenario_id.value} B runs do not cover 10 variants x 3 repeats")

    if any(run.memory_context_text is not None for run in a_runs):
        raise ValueError("release A runs must have memory context disabled")
    if not all(run.runtime_memory_evidence_verified for run in [*a_runs, *b_runs]):
        raise ValueError("release runs require sidecar runtime memory evidence")
    if any(run.runtime_memory_mode != "disabled" for run in a_runs):
        raise ValueError("release A runs require runtime memory mode disabled")
    if any(run.runtime_memory_mode != "enabled" for run in b_runs):
        raise ValueError("release B runs require runtime memory mode enabled")
    active_memory_b_runs = [
        run for run in b_runs if run.scenario_id != ScenarioId.PRIVACY
    ]
    if any(not run.memory_context_text for run in active_memory_b_runs):
        raise ValueError("release S1-S4 B runs require injected memory context")
    if any(run.runtime_memory_injected_count <= 0 for run in active_memory_b_runs):
        raise ValueError("release S1-S4 B runs require runtime-injected memory")
    privacy_runs = [
        run
        for run in [*a_runs, *b_runs]
        if run.scenario_id == ScenarioId.PRIVACY
    ]
    if any(run.memory_context_text for run in privacy_runs):
        raise ValueError("release privacy runs require an empty memory context")
    if any(run.runtime_memory_injected_count != 0 for run in privacy_runs):
        raise ValueError("release privacy runs must inject zero memories")
    if not privacy_runs or not all(
        run.privacy_visibility_verified for run in privacy_runs
    ):
        raise ValueError("release privacy runs require FastAPI viewer verification")


def validate_release_bundle_metadata(metadata_rows: list[dict]) -> None:
    """Require five isolated sidecar slices with one fixed model."""
    if len(metadata_rows) != len(SCENARIOS):
        raise ValueError("release aggregate requires exactly five scenario bundles")
    if {str(row.get("evidence_mode", "")) for row in metadata_rows} != {
        "sidecar_end_to_end"
    }:
        raise ValueError("release aggregate only accepts sidecar_end_to_end bundles")
    if len({str(row.get("model", "")) for row in metadata_rows}) != 1:
        raise ValueError("release aggregate must use one fixed model")
    project_ids = {str(row.get("project_id", "")) for row in metadata_rows}
    conversation_ids = {
        str(row.get("conversation_id", "")) for row in metadata_rows
    }
    if "" in project_ids or len(project_ids) != len(SCENARIOS):
        raise ValueError("release aggregate requires five dedicated projects")
    if "" in conversation_ids or len(conversation_ids) != len(SCENARIOS):
        raise ValueError("release aggregate requires five dedicated conversations")
    scenario_slices = [tuple(row.get("scenarios", [])) for row in metadata_rows]
    if any(len(scenarios) != 1 for scenarios in scenario_slices):
        raise ValueError("each release bundle must contain exactly one scenario")
    if {scenarios[0] for scenarios in scenario_slices} != {
        scenario.scenario_id.value for scenario in SCENARIOS
    }:
        raise ValueError("release bundle metadata must cover all five scenarios")


def _write_review_files(
    a_runs: list,
    b_runs: list,
    *,
    review_output: str,
    review_key_output: str,
) -> None:
    review_rows, review_key = generate_blind_review_rows(a_runs, b_runs)
    Path(review_output).write_text(
        json.dumps(review_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(review_key_output).write_text(
        json.dumps(review_key, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="ProjectMemory V1 Agent A/B Effect Evaluation (R8)",
    )
    runner_mode = parser.add_mutually_exclusive_group()
    runner_mode.add_argument(
        "--mock",
        action="store_true",
        help="run only the deterministic structural smoke test",
    )
    runner_mode.add_argument(
        "--direct",
        action="store_true",
        help="exploratory direct LLM call; reads the key from --api-key-env",
    )
    parser.add_argument(
        "--api-key-env",
        default="PROJECTFLOW_AB_EVAL_API_KEY",
        help="environment variable containing the direct-run API key",
    )
    parser.add_argument(
        "--api-base-url",
        default="https://api.deepseek.com/anthropic",
        help="Base URL for direct LLM API (default: DeepSeek Anthropic endpoint)",
    )
    parser.add_argument(
        "--model",
        default="deepseek-v4-pro",
        help="Model name for direct LLM calls (default: deepseek-v4-pro)",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=2048,
        help="Max output tokens for direct LLM calls (default: 2048)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="Request timeout in seconds for direct LLM calls (default: 120)",
    )
    parser.add_argument(
        "--instances",
        type=int,
        default=10,
        help="distinct problem instances per scenario (default: 10)",
    )
    parser.add_argument(
        "--repeats",
        type=int,
        default=3,
        help="repetitions per instance (default: 3)",
    )
    parser.add_argument(
        "--runs",
        type=int,
        help="expected total A and B executions; validated against instances/repeats/scenarios",
    )
    parser.add_argument("--output", default="ab_eval_report.md")
    parser.add_argument("--scenarios", nargs="*")
    parser.add_argument("--sidecar-base-url", default=settings.sidecar_base_url)
    parser.add_argument("--workspace-id")
    parser.add_argument("--project-id")
    parser.add_argument("--conversation-id")
    parser.add_argument("--owner-user-id")
    parser.add_argument("--member-user-id")
    parser.add_argument("--viewer-user-id")
    parser.add_argument("--privacy-viewer-user-id")
    parser.add_argument("--model-provider", default=settings.llm_provider)
    parser.add_argument("--model-name", default=settings.llm_model)
    parser.add_argument("--max-steps", type=int, default=8)
    parser.add_argument("--max-tool-calls", type=int, default=6)
    parser.add_argument("--timeout-ms", type=int, default=180000)
    parser.add_argument(
        "--release-pilot",
        action="store_true",
        help="enforce one release slice: 10 variants x 3 repeats x A/B = 60 calls",
    )
    parser.add_argument("--review-output", help="blinded JSON review worksheet path")
    parser.add_argument("--review-key-output", help="separate JSON unblinding key path")
    parser.add_argument("--reviewed-input", help="completed blinded review worksheet JSON")
    parser.add_argument("--runs-output", help="machine-readable raw run bundle path")
    parser.add_argument(
        "--aggregate-inputs",
        nargs="+",
        help="aggregate per-scenario run bundle JSON files without model calls",
    )
    parser.add_argument(
        "--prepare-fixtures",
        action="store_true",
        help="write idempotent R8 fixtures to the supplied project before a real run",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.aggregate_inputs:
        if args.mock or args.direct:
            parser.error("--aggregate-inputs cannot be combined with a runner mode")
        all_a_runs = []
        all_b_runs = []
        aggregate_metadata = []
        seen_run_keys: set[tuple[str, str, int, int]] = set()
        for input_path in args.aggregate_inputs:
            payload = json.loads(Path(input_path).read_text(encoding="utf-8"))
            a_slice, b_slice, metadata = deserialize_run_bundle(payload)
            for run in [*a_slice, *b_slice]:
                run_key = (
                    run.group,
                    run.scenario_id.value,
                    run.instance,
                    run.repeat,
                )
                if run_key in seen_run_keys:
                    parser.error(f"duplicate aggregate run: {run_key}")
                seen_run_keys.add(run_key)
            all_a_runs.extend(a_slice)
            all_b_runs.extend(b_slice)
            aggregate_metadata.append(metadata)

        if args.release_pilot:
            try:
                validate_release_aggregate(all_a_runs, all_b_runs)
                validate_release_bundle_metadata(aggregate_metadata)
            except ValueError as exc:
                parser.error(str(exc))
            if not args.reviewed_input:
                parser.error("release aggregate requires --reviewed-input")

        reviewed_rows = (
            json.loads(Path(args.reviewed_input).read_text(encoding="utf-8"))
            if args.reviewed_input
            else None
        )
        present_scenario_ids = {run.scenario_id for run in [*all_a_runs, *all_b_runs]}
        aggregate_scenarios = [
            scenario
            for scenario in SCENARIOS
            if scenario.scenario_id in present_scenario_ids
        ]
        metrics = compute_full_metrics(
            all_a_runs,
            all_b_runs,
            aggregate_scenarios,
            human_review_rows=reviewed_rows,
            human_review_required=args.release_pilot,
        )
        report = generate_report(metrics, evidence_mode="sidecar_end_to_end")
        Path(args.output).write_text(report, encoding="utf-8")
        if args.review_output or args.review_key_output:
            if not args.review_output or not args.review_key_output:
                parser.error("both --review-output and --review-key-output are required")
            _write_review_files(
                all_a_runs,
                all_b_runs,
                review_output=args.review_output,
                review_key_output=args.review_key_output,
            )
        print(
            f"Aggregated paired trials: {len(all_a_runs)}; "
            f"model executions: {len(all_a_runs) + len(all_b_runs)}"
        )
        print(f"Report written to: {args.output}")
        for gate, passed in metrics.gates_passed.items():
            print(f"  [{'PASS' if passed else 'FAIL'}] {gate}")
        if args.review_output and not args.reviewed_input:
            sys.exit(0)
        sys.exit(0 if all(metrics.gates_passed.values()) else 1)

    scenarios = _parse_scenarios(parser, args.scenarios)
    if not 1 <= args.instances <= 10 or args.repeats <= 0:
        parser.error("--instances must be between 1 and 10; --repeats must be positive")

    config = ABEvalConfig(
        instances=args.instances,
        repeats=args.repeats,
        scenarios=scenarios,
    )
    if args.runs is not None and args.runs != config.total_runs:
        parser.error(
            f"--runs must equal {config.total_runs} for the selected "
            "instances, repeats, scenarios, and A/B groups"
        )
    if args.release_pilot:
        if args.mock or args.direct:
            parser.error("--release-pilot requires the sidecar_end_to_end runner")
        try:
            validate_release_pilot_config(config)
        except ValueError as exc:
            parser.error(str(exc))
        if not args.runs_output:
            parser.error("--release-pilot requires --runs-output")

    print("ProjectMemory V1 Agent A/B Effect Evaluation")
    print(f"Scenarios: {', '.join(s.scenario_id.value for s in scenarios)}")
    print(f"Paired trials: {config.total_runs // 2}; model executions: {config.total_runs}")

    if args.mock:
        evidence_mode = "structural_mock"
        runner = MockAgentRunner()
        a_runs, b_runs = run_ab_eval(runner, config)
    elif args.direct:
        evidence_mode = "direct_exploratory"
        api_key = os.environ.get(args.api_key_env)
        if not api_key:
            parser.error(
                f"environment variable {args.api_key_env} is required for --direct mode"
            )
        runner = DirectAPIRunner(
            api_key=api_key,
            base_url=args.api_base_url,
            model=args.model,
            max_tokens=args.max_tokens,
            timeout_seconds=args.timeout,
        )
        print(f"Direct API runner: {args.api_base_url} model={args.model}")
        a_runs, b_runs = run_ab_eval(runner, config)
    else:
        evidence_mode = "sidecar_end_to_end"
        _require_real_args(parser, args)
        runner = SidecarAgentRunner(
            sidecar_base_url=args.sidecar_base_url,
            workspace_id=args.workspace_id,
            project_id=args.project_id,
            conversation_id=args.conversation_id,
            model_provider=args.model_provider,
            model_name=args.model_name,
            max_steps=args.max_steps,
            max_tool_calls=args.max_tool_calls,
            timeout_ms=args.timeout_ms,
        )
        with Session(engine) as session:
            if args.release_pilot or args.prepare_fixtures:
                if len(scenarios) != 1:
                    parser.error(
                        "release/fixture evaluation requires exactly one --scenarios value; "
                        "use a dedicated project per scenario"
                    )
                for scenario in scenarios:
                    try:
                        validate_fixture_project_isolation(
                            session,
                            project_id=args.project_id,
                            scenario=scenario,
                            conversation_id=args.conversation_id,
                        )
                    except ValueError as exc:
                        parser.error(str(exc))
            if args.prepare_fixtures:
                for scenario in scenarios:
                    write_scenario_memories(
                        session,
                        scenario,
                        workspace_id=args.workspace_id,
                        project_id=args.project_id,
                        owner_user_id=args.owner_user_id,
                        member_user_id=args.member_user_id,
                    )
            a_runs, b_runs = run_ab_eval(
                runner,
                config,
                session=session,
                workspace_id=args.workspace_id,
                project_id=args.project_id,
                owner_user_id=args.owner_user_id,
                member_user_id=args.member_user_id,
                viewer_user_id=args.viewer_user_id,
                privacy_viewer_user_id=args.privacy_viewer_user_id,
            )

    metrics = compute_full_metrics(
        a_runs,
        b_runs,
        scenarios,
        memory_context_token_budget=config.memory_context_token_budget,
    )
    report = generate_report(metrics, evidence_mode=evidence_mode)
    with open(args.output, "w", encoding="utf-8") as report_file:
        report_file.write(report)

    if args.runs_output:
        run_bundle = serialize_run_bundle(
            a_runs,
            b_runs,
            metadata={
                "evidence_mode": evidence_mode,
                "model": args.model if args.direct else args.model_name,
                "instances": config.instances,
                "repeats": config.repeats,
                "scenarios": [scenario.scenario_id.value for scenario in scenarios],
                "workspace_id": args.workspace_id,
                "project_id": args.project_id,
                "conversation_id": args.conversation_id,
            },
        )
        Path(args.runs_output).write_text(
            json.dumps(run_bundle, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    if args.review_output or args.review_key_output:
        if not args.review_output or not args.review_key_output:
            parser.error("both --review-output and --review-key-output are required")
        _write_review_files(
            a_runs,
            b_runs,
            review_output=args.review_output,
            review_key_output=args.review_key_output,
        )

    print(f"Report written to: {args.output}")
    for gate, passed in metrics.gates_passed.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {gate}")
    if args.mock or args.release_pilot:
        sys.exit(0)
    sys.exit(0 if all(metrics.gates_passed.values()) else 1)
