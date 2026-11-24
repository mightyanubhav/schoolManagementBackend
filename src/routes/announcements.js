import { Router } from "express";
import { z } from "zod";
import Announcement from "../models/Announcement.js";
import Student from "../models/Student.js";
import Class from "../models/Class.js";
import Teacher from "../models/Teacher.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";

const r = Router();
r.use(auth());

const schema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(5000),
  audience: z.enum(["all", "students", "parents", "teachers", "staff"]).optional(),
  class: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  pinned: z.boolean().optional(),
}).refine((value) => !value.class || value.audience === "students", {
  path: ["class"],
  message: "Class-specific announcements must target students",
});

r.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req, res, 20);
    if (!pagination) return;
    const audience = req.user.role === "student" ? "students"
      : req.user.role === "teacher" ? "teachers"
      : req.user.role === "parent" ? "parents" : "all";
    let filter;
    if (req.user.role === "admin") {
      filter = {};
    } else if (req.user.role === "student") {
      const student = await Student.findOne({ user: req.user.id }).select("class");
      filter = {
        audience: { $in: ["all", "students"] },
        ...(student
          ? { $or: [{ class: null }, { class: student.class }] }
          : { class: null }),
      };
    } else if (req.user.role === "teacher") {
      const teacher = await Teacher.findOne({ user: req.user.id }).select("classes");
      filter = {
        $or: [
          { audience: { $in: ["all", "teachers"] }, class: null },
          ...(teacher?.classes.length
            ? [{ audience: "students", class: { $in: teacher.classes } }]
            : []),
        ],
      };
    } else {
      filter = { audience: { $in: ["all", audience] }, class: null };
    }
    const [announcements, total] = await Promise.all([
      Announcement.find(filter)
        .select("title body audience class pinned postedBy createdAt")
        .populate("postedBy", "name")
        .populate("class", "name section")
        .sort({ pinned: -1, createdAt: -1, _id: -1 }).skip(pagination.skip).limit(pagination.limit),
      Announcement.countDocuments(filter),
    ]);
    setPaginationHeaders(res, { ...pagination, total });
    res.json(announcements);
  } catch (e) { next(e); }
});

r.post("/", role("admin", "teacher"), validate(schema), async (req, res, next) => {
  try {
    if (req.body.class) {
      if (req.user.role === "teacher") {
        const teacher = await Teacher.findOne({ user: req.user.id }).select("classes");
        if (!teacher?.classes.some((id) => String(id) === req.body.class)) {
          return res.status(403).json({ error: "You can only post class announcements for your assigned classes" });
        }
      }
      const schoolClass = await Class.findById(req.body.class).select("_id");
      if (!schoolClass) return res.status(400).json({ error: "Selected class was not found" });
    }
    res.status(201).json(await Announcement.create({ ...req.body, postedBy: req.user.id }));
  }
  catch (e) { next(e); }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try { await Announcement.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default r;