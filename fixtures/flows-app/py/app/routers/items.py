from fastapi import APIRouter

router = APIRouter(prefix="/items")

@router.get("/{item_id}")
async def read_item(item_id: int):
    return {}

@router.api_route("/bulk", methods=["POST", "PUT"])
async def bulk():
    return {}
