import { Router } from "express";
const router = Router();
router.get("/", (_req, res) => res.json([]));
router.get(`/:id`, async (req, res) => res.json({ id: req.params.id }));
router.route("/:id/items").post(addItem).delete(removeItem);
router.get(`/by/${"computed"}`, (_req, res) => res.end());
function addItem() {}
function removeItem() {}
export default router;
