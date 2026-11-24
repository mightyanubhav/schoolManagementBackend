import { Router } from "express";
import { z } from "zod";
import Exam from "../models/Exam.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import Teacher from "../models/Teacher.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";

const r = Router();
r.use(auth());

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record id");
const examSchema = z.object({
  name: z.string().trim().min(1).max(120),
  term: z.string().trim().max(80).optional(),
  class: objectId,
  subject: objectId,
  date: z.coerce.date().optional(),
  maxMarks: z.coerce.number().positive().max(10000),
  passMarks: z.coerce.number().nonnegative().max(10000),
}).refine((value) => value.passMarks <= value.maxMarks, {
  path: ["passMarks"],
  message: "Passing marks cannot exceed maximum marks",
});
const examQuerySchema = z.object({
  class: objectId.optional(),
  term: z.string().trim().max(80).optional(),
  status: z.enum(["draft", "published"]).optional(),
});

const marksSchema = z.object({
  marks: z.array(z.object({
    student: objectId,
    marks: z.coerce.number().nonnegative().max(10000),
    attendance: z.enum(["present", "absent"]).default("present"),
  })).max(500),
});

const examPopulation = [
  { path: "class", select: "name section" },
  { path: "subject", select: "name code class" },
  { path: "marks.student", populate: { path: "user", select: "name" } },
];

async function teacherCanAccessExam(userId, exam) {
  const teacher = await Teacher.findOne({ user: userId }).select("classes subjects");
  const subject = await Subject.findById(exam.subject).select("class");
  return Boolean(
    teacher &&
    subject &&
    teacher.classes.some((id) => String(id) === String(exam.class)) &&
    teacher.subjects.some((id) => String(id) === String(exam.subject)) &&
    (!subject.class || String(subject.class) === String(exam.class))
  );
}

async function findExamPage(filter, pagination) {
  const [exams, total] = await Promise.all([
    Exam.find(filter).populate(examPopulation).sort({ date: -1, createdAt: -1, _id: -1 })
      .skip(pagination.skip).limit(pagination.limit),
    Exam.countDocuments(filter),
  ]);
  return { exams, total };
}

function respondWithExamPage(res, pagination, { exams, total }) {
  setPaginationHeaders(res, { ...pagination, total });
  res.json(exams);
}

r.get("/results", role("admin"), async (req, res, next) => {
  try {
    const parsedQuery = examQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid exam filters" });
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const filter = { status: "published" };
    if (parsedQuery.data.class) filter.class = parsedQuery.data.class;
    if (parsedQuery.data.term) filter.term = parsedQuery.data.term;
    respondWithExamPage(res, pagination, await findExamPage(filter, pagination));
  } catch (e) { next(e); }
});

r.get("/:id/mark-sheet", role("admin", "teacher"), async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    if (req.user.role === "teacher" && !(await teacherCanAccessExam(req.user.id, exam))) {
      return res.status(403).json({ error: "You can only view mark sheets for your assigned classes and subjects" });
    }
    const students = await Student.find({ class: exam.class }).populate("user", "name").sort({ rollNo: 1, admissionNo: 1 });
    const existing = new Map(exam.marks.map((entry) => [String(entry.student), entry]));
    const maxMarks = exam.maxMarks || Math.max(...exam.marks.map((entry) => entry.maxMarks || 0)) || 100;
    res.json({
      exam: {
        ...exam.toObject(),
        maxMarks,
        passMarks: exam.passMarks ?? Math.ceil(maxMarks * 0.33),
        status: exam.status || "draft",
      },
      students: students.map((student) => {
        const mark = existing.get(String(student._id));
        return {
          _id: student._id,
          name: student.user?.name,
          admissionNo: student.admissionNo,
          rollNo: student.rollNo,
          marks: mark?.marks ?? "",
          attendance: mark?.attendance || "present",
          recorded: Boolean(mark),
        };
      }),
    });
  } catch (e) { next(e); }
});

r.get("/", async (req, res, next) => {
  try {
    const parsedQuery = examQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid exam filters" });
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const filter = {};
    if (parsedQuery.data.class) filter.class = parsedQuery.data.class;
    if (parsedQuery.data.term) filter.term = parsedQuery.data.term;

    if (req.user.role === "student") {
      const student = await Student.findOne({ user: req.user.id }).select("_id class");
      if (!student) return respondWithExamPage(res, pagination, { exams: [], total: 0 });
      filter.status = "published";
      filter.class = student.class;
      const result = await findExamPage(filter, pagination);
      result.exams = result.exams.map((exam) => {
        const item = exam.toObject();
        item.marks = item.marks.filter((mark) => String(mark.student?._id) === String(student._id));
        return item;
      });
      return respondWithExamPage(res, pagination, result);
    }

    if (req.user.role === "parent") {
      const students = await Student.find({ parentUser: req.user.id }).select("_id class");
      if (!students.length) return respondWithExamPage(res, pagination, { exams: [], total: 0 });
      filter.status = "published";
      filter.class = { $in: students.map((student) => student.class) };
      const studentIds = new Set(students.map((student) => String(student._id)));
      const result = await findExamPage(filter, pagination);
      result.exams = result.exams.map((exam) => {
        const item = exam.toObject();
        item.marks = item.marks.filter((mark) => studentIds.has(String(mark.student?._id)));
        return item;
      });
      return respondWithExamPage(res, pagination, result);
    }

    if (req.user.role === "teacher") {
      const teacher = await Teacher.findOne({ user: req.user.id }).select("classes subjects");
      const classIds = teacher?.classes || [];
      const subjectIds = teacher?.subjects || [];
      if (parsedQuery.data.class && !classIds.some((id) => String(id) === String(parsedQuery.data.class))) {
        return res.status(403).json({ error: "You can only view exams for your assigned classes" });
      }
      filter.class = parsedQuery.data.class || { $in: classIds };
      const subjectClasses = parsedQuery.data.class ? [parsedQuery.data.class] : classIds;
      const allowedSubjects = await Subject.find({
        _id: { $in: subjectIds },
        $or: [{ class: null }, { class: { $in: subjectClasses } }],
      }).distinct("_id");
      filter.subject = { $in: allowedSubjects };
    }

    if (parsedQuery.data.status) filter.status = parsedQuery.data.status;
    respondWithExamPage(res, pagination, await findExamPage(filter, pagination));
  } catch (e) { next(e); }
});

r.post("/", role("admin", "teacher"), validate(examSchema), async (req, res, next) => {
  try {
    if (req.user.role === "teacher" && !(await teacherCanAccessExam(req.user.id, req.body))) {
      return res.status(403).json({ error: "You can only create exams for your assigned classes and subjects" });
    }
    const exam = await Exam.create({ ...req.body, status: "draft" });
    res.status(201).json(await Exam.findById(exam._id).populate(examPopulation));
  } catch (e) { next(e); }
});

r.put("/:id/marks", role("admin", "teacher"), validate(marksSchema), async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    if (req.user.role === "teacher" && !(await teacherCanAccessExam(req.user.id, exam))) {
      return res.status(403).json({ error: "You can only record marks for your assigned classes and subjects" });
    }
    if (exam.status === "published") return res.status(409).json({ error: "Unpublish the result before changing marks" });
    const students = await Student.find({ class: exam.class }).select("_id");
    const roster = new Set(students.map((student) => String(student._id)));
    const ids = req.body.marks.map((entry) => entry.student);
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "Each student can only be recorded once" });
    if (ids.some((id) => !roster.has(id))) return res.status(400).json({ error: "Marks include a student outside this exam class" });
    const maxMarks = exam.maxMarks || 100;
    if (req.body.marks.some((entry) => entry.marks > maxMarks)) {
      return res.status(400).json({ error: `Marks cannot exceed ${maxMarks}` });
    }

    exam.maxMarks = maxMarks;
    exam.passMarks = exam.passMarks ?? Math.ceil(maxMarks * 0.33);
    exam.status = "draft";
    exam.marks = req.body.marks.map((entry) => ({
      ...entry,
      marks: entry.attendance === "absent" ? 0 : entry.marks,
      maxMarks,
    }));
    await exam.save();
    res.json(await Exam.findById(exam._id).populate(examPopulation));
  } catch (e) { next(e); }
});

r.put("/:id/publish", role("admin"), async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    const studentIds = await Student.find({ class: exam.class }).distinct("_id");
    const recordedIds = new Set(exam.marks.map((mark) => String(mark.student)));
    if (!studentIds.length || studentIds.some((id) => !recordedIds.has(String(id)))) {
      return res.status(400).json({ error: "Record marks or attendance for every student before declaring results" });
    }
    exam.status = "published";
    exam.publishedAt = new Date();
    await exam.save();
    res.json(await Exam.findById(exam._id).populate(examPopulation));
  } catch (e) { next(e); }
});

r.put("/:id/unpublish", role("admin"), async (req, res, next) => {
  try {
    const exam = await Exam.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "draft" }, $unset: { publishedAt: 1 } },
      { new: true }
    );
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    res.json(await Exam.findById(exam._id).populate(examPopulation));
  } catch (e) { next(e); }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    if (exam.status === "published") return res.status(409).json({ error: "Unpublish the result before deleting the exam" });
    await exam.deleteOne();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
