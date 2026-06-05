from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes_health import router as health_router
from app.api.routes_users import router as users_router
from app.api.routes_workspaces import router as workspaces_router
from app.api.routes_invitations import router as invitations_router
from app.api.routes_member_profiles import router as profiles_router
from app.api.routes_projects import router as projects_router
from app.api.routes_resources import router as resources_router
from app.api.routes_stages import router as stages_router
from app.api.routes_tasks import router as tasks_router
from app.api.routes_assignments import router as assignments_router
from app.api.routes_checkins import router as checkins_router
from app.api.routes_risks import router as risks_router
from app.api.routes_action_cards import router as action_cards_router
from app.api.routes_replans import router as replans_router
from app.api.routes_agent import router as agent_router
from app.api.routes_agent_proposals import router as agent_proposals_router
from app.api.routes_workspace_state import router as workspace_state_router
from app.api.routes_timeline import router as timeline_router
from app.api.routes_demo import router as demo_router
from app.api.routes_seed import router as seed_router
from app.api.routes_export import router as export_router
from app.api.routes_llm import router as llm_router
from app.api.routes_uploads import router as uploads_router
from app.core.database import create_db_and_tables

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        create_db_and_tables()
    except Exception:
        logger.exception("Failed to initialize database")
        raise
    yield


app = FastAPI(title="ProjectFlow API", lifespan=lifespan)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)
app.include_router(health_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(workspaces_router, prefix="/api")
app.include_router(invitations_router, prefix="/api")
app.include_router(profiles_router, prefix="/api")
app.include_router(projects_router, prefix="/api")
app.include_router(resources_router, prefix="/api")
app.include_router(stages_router, prefix="/api")
app.include_router(tasks_router, prefix="/api")
app.include_router(assignments_router, prefix="/api")
app.include_router(checkins_router, prefix="/api")
app.include_router(risks_router, prefix="/api")
app.include_router(action_cards_router, prefix="/api")
app.include_router(replans_router, prefix="/api")
app.include_router(agent_router, prefix="/api")
app.include_router(agent_proposals_router, prefix="/api")
app.include_router(workspace_state_router, prefix="/api")
app.include_router(timeline_router, prefix="/api")
app.include_router(demo_router, prefix="/api")
app.include_router(seed_router, prefix="/api")
app.include_router(export_router, prefix="/api")
app.include_router(llm_router, prefix="/api")
app.include_router(uploads_router, prefix="/api")
