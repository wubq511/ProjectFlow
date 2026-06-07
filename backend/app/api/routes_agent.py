from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.agent.llm_client import LLMError, LLMTimeoutError
from app.core.database import get_session
from app.schemas.agent_flow import AgentFlowRead, AgentFlowRequest
from app.services.agent_flow_service import run_agent_flow

router = APIRouter(tags=["agent"])


@router.post("/agent/clarify", response_model=AgentFlowRead)
def api_agent_clarify(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.generate_direction_card(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/plan", response_model=AgentFlowRead)
def api_agent_plan(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.generate_stage_plan(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/breakdown", response_model=AgentFlowRead)
def api_agent_breakdown(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.generate_task_breakdown(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/assign", response_model=AgentFlowRead)
def api_agent_assign(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.recommend_assignments(
            state,
            stage_id=data.stage_id,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/active-push", response_model=AgentFlowRead)
def api_agent_active_push(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.create_active_push(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/check-in-analysis", response_model=AgentFlowRead)
def api_agent_check_in_analysis(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.analyze_checkin(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/risk-analysis", response_model=AgentFlowRead)
def api_agent_risk_analysis(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.analyze_risks(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/replan", response_model=AgentFlowRead)
def api_agent_replan(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.replan(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/negotiate", response_model=AgentFlowRead)
def api_agent_negotiate(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.negotiate_assignment(
            state,
            user_instruction=instruction,
        ),
    )


@router.post("/agent/retrospective", response_model=AgentFlowRead)
def api_agent_retrospective(
    data: AgentFlowRequest,
    session: Session = Depends(get_session),
):
    return _run(
        data,
        session,
        lambda coordinator, state, instruction: coordinator.generate_retrospective(
            state,
            user_instruction=instruction,
        ),
    )


def _run(data: AgentFlowRequest, session: Session, method) -> AgentFlowRead:
    try:
        return run_agent_flow(
            session,
            data.workspace_id,
            method,
            project_id=data.project_id,
            user_instruction=data.user_instruction,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMTimeoutError as exc:
        raise HTTPException(status_code=504, detail=f"AI 模型响应超时，请稍后重试: {exc}")
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=f"AI 模型调用失败: {exc}")
