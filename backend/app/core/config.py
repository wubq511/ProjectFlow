from pydantic import PositiveFloat, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = "sqlite:///./data/projectflow.sqlite"
    llm_provider: str = "mock"
    llm_api_key: SecretStr | None = None
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    llm_timeout_seconds: PositiveFloat = 30.0
    llm_agent_timeout_seconds: PositiveFloat = 120.0
    demo_admin_token: SecretStr | None = None
    internal_service_token: SecretStr | None = None
    sidecar_base_url: str = "http://localhost:4000"

    # ── T41 Per-Tool Feature Flags ──────────────────────────────────
    # Disable a flag to immediately stop the corresponding tool endpoint
    # from being served (returns 404).  Default: all enabled.
    feature_read_tools: bool = True
    feature_stage_plan_proposal: bool = True
    feature_checkins_and_risks_analysis: bool = True
    feature_replan_proposal: bool = True
    feature_assignment_recommendation: bool = True
    feature_direction_card_proposal: bool = True
    feature_task_breakdown_proposal: bool = True
    feature_create_risk: bool = True
    feature_create_checkin: bool = True

    # ── T42 ProjectMemory Vector Retrieval ───────────────────────────
    memory_vector_enabled: bool = False  # 是否优先使用向量检索
    memory_vector_model: str = "shibing624/text2vec-base-chinese"  # 默认中文模型
    memory_vector_model_dir: str = ""  # 空=自动 data/memory-models/

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    def enabled_agent_tools(self) -> set[str]:
        """Return the set of tool endpoint names that are enabled."""
        tools: set[str] = set()
        if self.feature_read_tools:
            tools.update({"workspace-state", "conversation", "pending-proposals", "timeline-slice"})
        if self.feature_stage_plan_proposal:
            tools.add("stage-plan-proposal")
        if self.feature_checkins_and_risks_analysis:
            tools.add("checkins-and-risks-analysis")
        if self.feature_replan_proposal:
            tools.add("replan-proposal")
        if self.feature_assignment_recommendation:
            tools.add("assignment-recommendation")
        if self.feature_direction_card_proposal:
            tools.add("direction-card-proposal")
        if self.feature_task_breakdown_proposal:
            tools.add("task-breakdown-proposal")
        if self.feature_create_risk:
            tools.add("create-risk")
        if self.feature_create_checkin:
            tools.add("create-checkin")
        return tools


settings = Settings()
