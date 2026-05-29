from fastapi import APIRouter

from app.schemas.llm import LLMDiagnosticRequest, LLMDiagnosticResponse
from app.services.llm_service import run_diagnostic

router = APIRouter(tags=["llm"])


@router.post("/llm/diagnostic", response_model=LLMDiagnosticResponse)
def llm_diagnostic(req: LLMDiagnosticRequest | None = None) -> LLMDiagnosticResponse:
    """Verify LLM provider connectivity with a safe dry-run.

    Never exposes API key values in the response.
    """
    return run_diagnostic(req)
