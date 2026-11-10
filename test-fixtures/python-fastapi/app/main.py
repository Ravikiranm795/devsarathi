from fastapi import FastAPI

from app import services

app = FastAPI()


@app.get("/users/{user_id}")
def read_user(user_id: int):
    user = services.get_user(user_id)
    return {"label": services.format_name(user["name"])}
