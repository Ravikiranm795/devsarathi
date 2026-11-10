# Test fixtures

Small repos with deliberately planted properties. Tests copy a fixture into a temp directory and `git init` it,
so nothing here is ever modified in place.

| Fixture | Stack | Planted |
|---------|-------|---------|
| `angular-app` | Angular + NgRx | `.env` with the documented AWS *example* key (never a real credential); `getUser` called from two modules; a template that uses `app-user-card`; one spec |
| `java-spring` | Spring Boot | hard-coded `AKIA...EXAMPLE` key in source; `getUser` called from two modules; constructor injection; `Class.forName` (dynamic reference); one JUnit test |
| `python-fastapi` | FastAPI | `get_user` called from two modules; `importlib.import_module` (dynamic reference); one pytest test |

The `selftest` fixture (Stage 10) lives beside these and adds the change-without-updating-callers and
missing-test scenarios.
