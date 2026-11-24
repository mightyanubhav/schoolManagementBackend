import { Router } from "express";
import { z } from "zod";
import Class from "../models/Class.js";
import Teacher from "../models/Teacher.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const r = Router();
r.use(auth());

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  grade: z.coerce.number().int().min(0).max(20),
  section: z.string().trim().max(20).optional(),
  room: z.string().trim().max(40).optional(),
});

r.get("/", async (req, res, next) => {
  try {
    if (!["admin", "teacher"].includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    const filter = {};
    if (req.user.role === "teacher") {
      const teacher = await Teacher.findOne({ user: req.user.id }).select("classes");
      filter._id = { $in: teacher?.classes || [] };
    }
    const list = await Class.find(filter).select("name grade section room");
    res.json(list);
  } catch (e) {
    next(e);
  }
});

r.post("/", role("admin"), validate(schema), async (req, res, next) => {
  try {
    const c = await Class.create(req.body);
    res.status(201).json(c);
  } catch (e) {
    next(e);
  }
});

r.put("/:id", role("admin"), validate(schema), async (req, res, next) => {
  try {
    const c = await Class.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!c) return res.status(404).json({ error: "Class not found" });
    res.json(c);
  } catch (e) {
    next(e);
  }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try {
    await Class.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default r;