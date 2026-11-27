import { Router } from "express";
import { z } from "zod";
import Timetable from "../models/Timetable.js";
import Student from "../models/Student.js";
import Teacher from "../models/Teacher.js";
import Class from "../models/Class.js";
import Subject from "../models/Subject.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const r = Router();
r.use(auth());

const optionalId = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().regex(/^[a-f\d]{24}$/i).optional()
);
const timetableSchema = z.object({
  slots: z.array(z.object({
    day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]),
    start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    subject: z.string().regex(/^[a-f\d]{24}$/i),
    teacher: optionalId,
    room: z.string().trim().max(40).optional(),
  }).refine((slot) => slot.start < slot.end, {
    path: ["end"],
    message: "End time must be after start time",
  })).max(100),
  reviewDueDate: z.coerce.date(),
});

r.get("/me", role("student"), async (req, res, next) => {
  try {
    const student = await Student.findOne({ user: req.user.id }).populate("class", "name section");
    if (!student || !student.class) return res.status(404).json({ error: "Student class not found" });
    const timetable = await Timetable.findOne({ class: student.class._id })
      .populate("class", "name section")
      .populate("slots.subject", "name code")
      .populate({ path: "slots.teacher", populate: { path: "user", select: "name" } });
    res.json(timetable || { class: student.class, slots: [] });
  } catch (e) { next(e); }
});

r.get("/reviews", role("admin"), async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const reminderWindow = new Date(today);
    reminderWindow.setDate(reminderWindow.getDate() + 30);
    const [classes, timetables] = await Promise.all([
      Class.find().select("name section").sort({ name: 1, section: 1 }),
      Timetable.find().select("class reviewDueDate").lean(),
    ]);
    const timetableByClass = new Map(timetables.map((item) => [String(item.class), item]));
    const reviews = classes.map((schoolClass) => {
      const timetable = timetableByClass.get(String(schoolClass._id));
      return { schoolClass, reviewDueDate: timetable?.reviewDueDate || null, missingSchedule: !timetable };
    }).filter((item) => item.missingSchedule || !item.reviewDueDate || new Date(item.reviewDueDate) <= reminderWindow);
    res.json(reviews);
  } catch (e) { next(e); }
});

r.get("/:classId", async (req, res, next) => {
  try {
    if (req.user.role === "student") {
      const student = await Student.findOne({ user: req.user.id }).select("class");
      if (!student || !student.class || String(student.class) !== req.params.classId) {
        return res.status(403).json({ error: "You can only view your enrolled class timetable" });
      }
    } else if (req.user.role === "teacher") {
      const teacher = await Teacher.findOne({ user: req.user.id }).select("classes");
      if (!teacher?.classes.some((id) => String(id) === req.params.classId)) {
        return res.status(403).json({ error: "You can only view timetables for your assigned classes" });
      }
    }
    let tt = await Timetable.findOne({ class: req.params.classId })
      .populate("slots.subject", "name code")
      .populate({ path: "slots.teacher", populate: { path: "user", select: "name" } });
    if (!tt) tt = { class: req.params.classId, slots: [] };
    res.json(tt);
  } catch (e) { next(e); }
});

r.put("/:classId", role("admin"), validate(timetableSchema), async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.classId)) return res.status(400).json({ error: "Invalid class id" });
    const schoolClass = await Class.findById(req.params.classId).select("_id");
    if (!schoolClass) return res.status(404).json({ error: "Class not found" });
    const subjects = await Subject.find({ _id: { $in: req.body.slots.map((slot) => slot.subject) } }).select("_id class teacher");
    if (subjects.length !== new Set(req.body.slots.map((slot) => slot.subject)).size) {
      return res.status(400).json({ error: "Select valid subjects" });
    }
    const subjectById = new Map(subjects.map((subject) => [String(subject._id), subject]));
    for (let i = 0; i < req.body.slots.length; i += 1) {
      const slot = req.body.slots[i];
      const subject = subjectById.get(slot.subject);
      if (subject.class && String(subject.class) !== req.params.classId) {
        return res.status(400).json({ error: "Each subject must belong to the selected class" });
      }
      if (subject.teacher && slot.teacher && String(subject.teacher) !== slot.teacher) {
        return res.status(400).json({ error: "Choose the teacher assigned to this subject" });
      }
      if (req.body.slots.slice(i + 1).some((other) => other.day === slot.day && slot.start < other.end && other.start < slot.end)) {
        return res.status(400).json({ error: `Timetable periods cannot overlap on ${slot.day}` });
      }
    }
    const tt = await Timetable.findOneAndUpdate(
      { class: req.params.classId },
      { $set: { slots: req.body.slots, reviewDueDate: req.body.reviewDueDate } },
      { new: true, upsert: true, runValidators: true }
    );
    res.json(tt);
  } catch (e) { next(e); }
});

export default r;
