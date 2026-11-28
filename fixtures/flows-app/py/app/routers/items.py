from fastapi import APIRouter

from app.db import SessionLocal
from app.models import Item
from app.tasks import send_receipt

router = APIRouter(prefix="/items")

@router.get("/{item_id}")
async def read_item(item_id: int):
    session = SessionLocal()
    return session.query(Item).get(item_id)

@router.api_route("/bulk", methods=["POST", "PUT"])
async def bulk():
    session = SessionLocal()
    session.add(Item(name="x"))
    send_receipt.delay(1)
    return {}
