from fastapi import FastAPI
from app.routers import items
from .routers.users import router as users_router

app = FastAPI()
app.include_router(items.router, prefix="/api/v1")
app.include_router(users_router)

@app.get("/")
def root():
    return {}
