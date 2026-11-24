import { Router } from "express";
import { z } from "zod";
import Subject from "../models/Subject.js";
import Teacher from "../models/Teacher.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const r = Router();
r.use(auth());

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(30),
  class: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[a-f\d]{24}$/i).optional()),
  teacher: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[a-f\d]{24}$/i).optional()),
});

r.get("/", async (req, res, next) => {
  try {
    if (!["admin", "teacher"].includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    const filter = {};
    if (req.user.role === "teacher") {
      const teacher = await Teacher.findOne({ user: req.user.id }).select("subjects");
      filter._id = { $in: teacher?.subjects || [] };
    }
    res.json(await Subject.find(filter).select("name code class teacher").populate("class", "name section").populate({
      path: "teacher",
      populate: { path: "user", select: "name" },
    }));
  } catch (e) { next(e); }
});

r.post("/", role("admin"), validate(schema), async (req, res, next) => {
  try { res.status(201).json(await Subject.create(req.body)); } catch (e) { next(e); }
});

r.put("/:id", role("admin"), validate(schema), async (req, res, next) => {
  try {
    const subject = await Subject.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!subject) return res.status(404).json({ error: "Subject not found" });
    res.json(subject);
  }
  catch (e) { next(e); }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try { await Subject.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default r;