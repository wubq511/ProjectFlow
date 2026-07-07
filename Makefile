.PHONY: check test test-backend test-agent-bridge test-frontend build-frontend typecheck lint

# Unified verification entrypoint — run all checks
check: test typecheck lint
	@echo "✅ All checks passed"

# Run all test suites
test: test-backend test-agent-bridge test-frontend

test-backend:
	@echo "▶ Backend tests"
	cd backend && .venv/bin/python -m pytest app/tests/ -q

test-agent-bridge:
	@echo "▶ Agent-bridge tests"
	cd agent-bridge && npm run test

test-frontend:
	@echo "▶ Frontend tests"
	cd frontend && npm run test

build-frontend:
	@echo "▶ Frontend build"
	cd frontend && npm run build

typecheck:
	@echo "▶ Agent-bridge typecheck"
	cd agent-bridge && npm run typecheck

lint:
	@echo "▶ Frontend lint"
	cd frontend && npm run lint
