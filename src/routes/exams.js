import { Router } from "express";
import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import Exam from "../models/Exam.js";
import Class from "../models/Class.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import Teacher from "../models/Teacher.js";
import User from "../models/User.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";
import { downloadPrivateObject } from "../utils/cloudflareStorage.js";

const r = Router();
r.use(auth());

const SCHOOL_NAME = "Baal Niketan School";
const SCHOOL_ADDRESS = "Jonki, Basua, Aurai, Muzaffarpur 843321";
const SCHOOL_LOGO_PATH = new URL("../assets/schoolLogo.png", import.meta.url);

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
const studentResultQuerySchema = z.object({
  class: objectId.optional(),
  q: z.string().trim().max(100).optional(),
});
const admitCardScheduleSchema = z.object({
  date: z.preprocess((value) => value === "" || value == null ? null : value, z.coerce.date().nullable()),
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
  const classIds = [...new Set(exams.map((exam) => String(exam.class?._id || exam.class)))];
  const classCounts = classIds.length ? await Student.aggregate([
    { $match: { class: { $in: classIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: "$class", count: { $sum: 1 } } },
  ]) : [];
  const countByClass = new Map(classCounts.map((item) => [String(item._id), item.count]));
  return {
    exams: exams.map((exam) => {
      const item = exam.toObject();
      item.studentCount = item.students?.length || countByClass.get(String(item.class?._id || item.class)) || 0;
      return item;
    }),
    total,
  };
}

function respondWithExamPage(res, pagination, { exams, total }) {
  setPaginationHeaders(res, { ...pagination, total });
  res.json(exams);
}

function normalizeExamName(name) {
  return String(name || "").trim().replace(/\s+\d{4}$/, "").replace(/\s+/g, " ");
}

function examGroupKey(exam) {
  const classId = String(exam.class?._id || exam.class);
  const normalizedName = normalizeExamName(exam.name).toLowerCase();
  const year = exam.date ? new Date(exam.date).getFullYear() : null;
  return `${classId}:${normalizedName}:${year || "undated"}`;
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
    const rosterIds = exam.students?.length ? exam.students : await Student.find({ class: exam.class }).distinct("_id");
    const students = await Student.find({ _id: { $in: rosterIds } }).populate("user", "name").sort({ rollNo: 1, admissionNo: 1 });
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

function examGroupFilter(exam, status) {
  const normalizedName = normalizeExamName(exam.name);
  const escapedName = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const examNamePattern = new RegExp(`^${escapedName}(?:\\s+\\d{4})?$`, "i");
  const year = exam.date ? new Date(exam.date).getFullYear() : null;
  const dateFilter = year
    ? { date: { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) } }
    : { $or: [{ date: null }, { date: { $exists: false } }] };
  return { class: exam.class, name: examNamePattern, ...(status && { status }), $and: [dateFilter] };
}

function publishedExamGroupFilter(exam) {
  return examGroupFilter(exam, "published");
}

function isExamRosterMember(exam, studentId) {
  return !exam.students?.length || exam.students.some((id) => String(id?._id || id) === String(studentId));
}

r.get("/admit-cards", role("admin", "student"), async (req, res, next) => {
  try {
    let studentId = null;
    let classId = req.query.class;
    if (req.user.role === "student") {
      const student = await Student.findOne({ user: req.user.id }).select("_id class").lean();
      if (!student) return res.status(404).json({ error: "Student record not found" });
      studentId = String(student._id);
      classId = String(student.class);
    } else if (!mongoose.isValidObjectId(classId)) {
      return res.status(400).json({ error: "Select a valid class to view admit cards" });
    }

    const exams = await Exam.find({ class: classId })
      .populate("class", "name section")
      .populate("subject", "name code")
      .sort({ date: 1, _id: 1 })
      .lean();
    const groups = new Map();
    for (const exam of exams) {
      if (studentId && !isExamRosterMember(exam, studentId)) continue;
      const year = exam.date ? new Date(exam.date).getFullYear() : null;
      const key = examGroupKey(exam);
      const group = groups.get(key) || {
        _id: exam._id,
        name: normalizeExamName(exam.name),
        term: exam.term || "",
        year,
        class: exam.class,
        date: exam.date,
        subjects: [],
      };
      if (group.term && exam.term && group.term.trim().toLowerCase() !== exam.term.trim().toLowerCase()) {
        group.term = "";
      }
      group.subjects.push({
        examId: exam._id,
        name: exam.subject?.name || "Subject",
        code: exam.subject?.code || "",
        date: exam.date,
        status: exam.status || "draft",
      });
      if (!group.date || (exam.date && new Date(exam.date) < new Date(group.date))) group.date = exam.date;
      groups.set(key, group);
    }
    res.json([...groups.values()].map((group) => ({
      ...group,
      subjects: group.subjects.sort((a, b) => a.name.localeCompare(b.name) || new Date(a.date || 0) - new Date(b.date || 0)),
    })).sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)));
  } catch (e) { next(e); }
});

r.put("/:examId/admit-card-schedule", role("admin"), validate(admitCardScheduleSchema), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.examId)) return res.status(400).json({ error: "Invalid exam id" });
    const exam = await Exam.findById(req.params.examId);
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    exam.date = req.body.date;
    await exam.save();
    res.json({
      _id: exam._id,
      date: exam.date,
    });
  } catch (e) { next(e); }
});

r.get("/:examId/admit-cards/pdf", role("admin", "student"), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.examId)) return res.status(400).json({ error: "Invalid exam id" });
    const baseExam = await Exam.findById(req.params.examId);
    if (!baseExam) return res.status(404).json({ error: "Exam not found" });
    let selectedStudent = null;
    if (req.user.role === "student") {
      selectedStudent = await Student.findOne({ user: req.user.id })
        .populate("user", "name")
        .populate("class", "name section");
      if (!selectedStudent || String(selectedStudent.class?._id) !== String(baseExam.class)) {
        return res.status(403).json({ error: "You can only download your own admit card" });
      }
    } else {
      if (!req.query.studentId) return res.status(400).json({ error: "Select a student to issue an admit card" });
      if (!mongoose.isValidObjectId(req.query.studentId)) return res.status(400).json({ error: "Invalid student id" });
      selectedStudent = await Student.findById(req.query.studentId)
        .populate("user", "name")
        .populate("class", "name section");
      if (!selectedStudent || String(selectedStudent.class?._id) !== String(baseExam.class)) {
        return res.status(404).json({ error: "Student is not enrolled in this exam class" });
      }
    }

    const groupExams = await Exam.find(examGroupFilter(baseExam))
      .populate("class", "name section")
      .populate("subject", "name code")
      .sort({ date: 1, _id: 1 })
      .lean();
    if (!groupExams.length) return res.status(404).json({ error: "No exams found for this group" });
    if (selectedStudent && !groupExams.some((exam) => isExamRosterMember(exam, selectedStudent._id))) {
      return res.status(403).json({ error: "No exam in this group is assigned to this student" });
    }

    const students = [selectedStudent];

    const logo = await readFile(SCHOOL_LOGO_PATH);
    const terms = [...new Set(groupExams.map((exam) => exam.term?.trim()).filter(Boolean))];
    const title = normalizeExamName(baseExam.name);
    const subtitle = terms.length === 1 ? `${terms[0]} · ${title}` : title;
    const fileName = title.replace(/[^a-z\d_-]/gi, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="admit-cards-${fileName}.pdf"`);
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    doc.pipe(res);
    const x = 36;
    const width = 523;
    const drawCell = (left, top, cellWidth, height, text, options = {}) => {
      doc.save().lineWidth(0.6).strokeColor("#333333").rect(left, top, cellWidth, height).stroke().restore();
      doc.fillColor("#172033").font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.size || 9)
        .text(String(text ?? ""), left + 5, top + Math.max(4, (height - (options.size || 9)) / 2 - 1), {
          width: cellWidth - 10,
          height: height - 4,
          align: options.align || "left",
          lineBreak: false,
          ellipsis: true,
        });
    };

    for (const [studentIndex, currentStudent] of students.entries()) {
      if (studentIndex) doc.addPage();
      const studentExams = groupExams.filter((exam) => isExamRosterMember(exam, currentStudent._id));
      doc.image(logo, x, 24, { fit: [54, 54] });
      doc.fillColor("#17375e").font("Helvetica-Bold").fontSize(19).text(SCHOOL_NAME.toUpperCase(), x + 58, 28, { width: width - 58, align: "center", lineBreak: false });
      doc.fillColor("#8c1722").font("Helvetica-Bold").fontSize(9).text(SCHOOL_ADDRESS.toUpperCase(), x + 58, 54, { width: width - 58, align: "center", lineBreak: false });
      doc.fillColor("#475569").font("Helvetica").fontSize(10).text(subtitle, x + 58, 72, { width: width - 58, align: "center", lineBreak: false });
      doc.moveTo(x, 91).lineTo(x + width, 91).strokeColor("#aab5c3").lineWidth(0.8).stroke();
      doc.fillColor("#8c1722").font("Helvetica-Bold").fontSize(18).text("ADMIT CARD", x, 102, { width, align: "center" });

      const infoY = 137;
      const infoRows = [
        ["Student", currentStudent.user?.name || "—"],
        ["Admission No.", currentStudent.admissionNo || "—"],
        ["Class / Section", `${currentStudent.class?.name || "—"} / ${currentStudent.class?.section || "A"}`],
        ["Roll No.", currentStudent.rollNo || "—"],
        ["Father / Guardian", currentStudent.fatherName || currentStudent.guardian?.name || "—"],
      ];
      const infoColumns = [104, width - 104];
      infoRows.forEach(([label, value], index) => {
        const rowY = infoY + index * 24;
        drawCell(x, rowY, infoColumns[0], 24, label, { bold: true });
        drawCell(x + infoColumns[0], rowY, infoColumns[1], 24, value);
      });

      const tableY = infoY + infoRows.length * 24 + 20;
      const headerHeight = 24;
      const rowHeight = Math.min(28, 330 / Math.max(studentExams.length, 1));
      const columns = [275, 105, width - 380];
      let columnX = x;
      ["Subject", "Subject Code", "Exam Date"].forEach((label, index) => {
        drawCell(columnX, tableY, columns[index], headerHeight, label, { bold: true, align: "center" });
        columnX += columns[index];
      });
      studentExams.forEach((exam, index) => {
        const values = [
          exam.subject?.name || "Subject",
          exam.subject?.code || "—",
          exam.date ? new Date(exam.date).toLocaleDateString("en-IN") : "To be announced",
        ];
        let cellX = x;
        values.forEach((value, column) => {
          drawCell(cellX, tableY + headerHeight + index * rowHeight, columns[column], rowHeight, value, { align: column === 0 ? "left" : "center" });
          cellX += columns[column];
        });
      });

      const noteY = tableY + headerHeight + studentExams.length * rowHeight + 24;
      doc.fillColor("#475569").font("Helvetica").fontSize(9)
        .text("Bring this admit card on each exam day and follow all instructions issued by the school.", x, noteY, { width });
      const signatureY = Math.max(noteY + 68, 730);
      doc.moveTo(x + 18, signatureY).lineTo(x + 178, signatureY).strokeColor("#333333").lineWidth(0.7).stroke();
      doc.moveTo(x + width - 178, signatureY).lineTo(x + width - 18, signatureY).strokeColor("#333333").lineWidth(0.7).stroke();
      doc.fillColor("#172033").font("Helvetica").fontSize(9).text("Class Teacher", x + 18, signatureY + 6, { width: 160, align: "center" });
      doc.text("Principal", x + width - 178, signatureY + 6, { width: 160, align: "center" });
      doc.fillColor("#64748b").fontSize(7.5).text(`Generated ${new Date().toLocaleDateString("en-IN")} · ${currentStudent.admissionNo}`, x, 790, { width, align: "center" });
    }
    doc.end();
  } catch (e) { next(e); }
});

r.get("/results/consolidated", role("admin", "student"), async (req, res, next) => {
  try {
    let classId = req.query.class;
    let studentId = null;
    if (req.user.role === "student") {
      const student = await Student.findOne({ user: req.user.id }).select("_id class");
      if (!student) return res.status(404).json({ error: "Student record not found" });
      studentId = String(student._id);
      classId = String(student.class);
    }
    if (classId && !mongoose.isValidObjectId(classId)) return res.status(400).json({ error: "Invalid class id" });
    const exams = await Exam.find({ status: "published", ...(classId && { class: classId }) })
      .populate(examPopulation).sort({ date: -1, createdAt: -1, _id: -1 }).lean();
    const groups = new Map();
    for (const exam of exams) {
      const year = exam.date ? new Date(exam.date).getFullYear() : null;
      const key = examGroupKey(exam);
      const group = groups.get(key) || { _id: exam._id, name: normalizeExamName(exam.name), term: exam.term || "", year, class: exam.class, date: exam.date, subjects: [] };
      if (group.term && exam.term && group.term.trim().toLowerCase() !== exam.term.trim().toLowerCase()) {
        group.term = "";
      }
      const subject = {
        examId: exam._id,
        name: exam.subject?.name || "Subject",
        code: exam.subject?.code || "",
        date: exam.date,
        maxMarks: exam.maxMarks || 100,
        passMarks: exam.passMarks ?? Math.ceil((exam.maxMarks || 100) * 0.33),
      };
      if (studentId) {
        const mark = (exam.marks || []).find((entry) => String(entry.student?._id || entry.student) === studentId);
        if (!mark) continue;
        subject.marks = mark.marks;
        subject.attendance = mark.attendance || "present";
      }
      group.subjects.push(subject);
      if (!group.date || (exam.date && new Date(exam.date) < new Date(group.date))) group.date = exam.date;
      groups.set(key, group);
    }
    const result = [...groups.values()];
    const classIds = [...new Set(result.map((group) => String(group.class?._id || group.class)))];
    const rosterCounts = req.user.role === "admin" && classIds.length ? await Student.aggregate([
      { $match: { class: { $in: classIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
      { $group: { _id: "$class", count: { $sum: 1 } } },
    ]) : [];
    const countByClass = new Map(rosterCounts.map((item) => [String(item._id), item.count]));
    const results = result.map((group) => {
      group.subjects.sort((a, b) => a.name.localeCompare(b.name));
      if (studentId) {
        group.totalMarks = group.subjects.reduce((sum, subject) => sum + (subject.attendance === "absent" ? 0 : Number(subject.marks || 0)), 0);
        group.totalMaxMarks = group.subjects.reduce((sum, subject) => sum + subject.maxMarks, 0);
        group.percentage = group.totalMaxMarks ? group.totalMarks / group.totalMaxMarks * 100 : 0;
        group.result = group.subjects.every((subject) => subject.attendance !== "absent" && subject.marks >= subject.passMarks) ? "Pass" : "Needs improvement";
      } else group.studentCount = countByClass.get(String(group.class?._id || group.class)) || 0;
      return group;
    }).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    res.json(results);
  } catch (e) { next(e); }
});

r.get("/results/consolidated/students", role("admin"), async (req, res, next) => {
  try {
    const parsedQuery = studentResultQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid result filters" });
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const { class: classId, q } = parsedQuery.data;
    const filter = {};
    if (classId) filter.class = classId;
    if (q) {
      const safeQuery = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matchingUsers = await User.find({ name: { $regex: safeQuery, $options: "i" } }).select("_id");
      filter.$or = [
        { admissionNo: { $regex: safeQuery, $options: "i" } },
        { rollNo: { $regex: safeQuery, $options: "i" } },
        { user: { $in: matchingUsers.map((item) => item._id) } },
      ];
    }
    const students = await Student.find(filter).select("admissionNo rollNo class fatherName motherName dob gender caste")
      .populate("user", "name").populate("class", "name section")
      .sort({ class: 1, rollNo: 1, admissionNo: 1 });
    if (!students.length) {
      setPaginationHeaders(res, { ...pagination, total: 0 });
      return res.json([]);
    }
    const classIds = [...new Set(students.map((student) => String(student.class?._id)).filter(Boolean))];
    const exams = await Exam.find({ status: "published", class: { $in: classIds } })
      .populate("class", "name section").populate("subject", "name code").sort({ date: -1, _id: -1 }).lean();
    const groupsByClass = new Map();
    for (const exam of exams) {
      const year = exam.date ? new Date(exam.date).getFullYear() : null;
      const key = examGroupKey(exam);
      const group = groupsByClass.get(key) || { _id: exam._id, name: normalizeExamName(exam.name), term: exam.term || "", year, class: exam.class, date: exam.date, subjects: [] };
      if (group.term && exam.term && group.term.trim().toLowerCase() !== exam.term.trim().toLowerCase()) {
        group.term = "";
      }
      const subject = {
        examId: exam._id,
        name: exam.subject?.name || "Subject",
        maxMarks: exam.maxMarks || 100,
        passMarks: exam.passMarks ?? Math.ceil((exam.maxMarks || 100) * 0.33),
        marksByStudent: new Map(),
      };
      for (const mark of exam.marks || []) {
        subject.marksByStudent.set(String(mark.student), { marks: mark.marks, attendance: mark.attendance || "present" });
      }
      group.subjects.push(subject);
      if (!group.date || (exam.date && new Date(exam.date) < new Date(group.date))) group.date = exam.date;
      groupsByClass.set(key, group);
    }
    const result = students.map((student) => {
      const studentGroups = [...groupsByClass.values()].filter((group) => String(group.class?._id || group.class) === String(student.class?._id));
      const reportCards = studentGroups.map((group) => {
        const subjects = group.subjects.map((subject) => {
          const mark = subject.marksByStudent.get(String(student._id));
          return mark ? { examId: subject.examId, name: subject.name, maxMarks: subject.maxMarks, passMarks: subject.passMarks, marks: mark.marks, attendance: mark.attendance } : null;
        }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
        if (!subjects.length) return null;
        const totalMarks = subjects.reduce((sum, subject) => sum + (subject.attendance === "absent" ? 0 : Number(subject.marks || 0)), 0);
        const totalMaxMarks = subjects.reduce((sum, subject) => sum + subject.maxMarks, 0);
        const passed = subjects.every((subject) => subject.attendance !== "absent" && subject.marks >= subject.passMarks);
        return {
          _id: group._id,
          name: group.name,
          term: group.term,
          year: group.year,
          date: group.date,
          subjects,
          totalMarks,
          totalMaxMarks,
          percentage: totalMaxMarks ? totalMarks / totalMaxMarks * 100 : 0,
          result: passed ? "Pass" : "Needs improvement",
        };
      }).filter(Boolean).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      return {
        student: {
          _id: student._id,
          name: student.user?.name || "—",
          admissionNo: student.admissionNo,
          rollNo: student.rollNo,
          class: student.class,
        },
        reportCards,
      };
    }).filter((item) => item.reportCards.length > 0);
    const total = result.length;
    setPaginationHeaders(res, { ...pagination, total });
    res.json(result.slice(pagination.skip, pagination.skip + pagination.limit));
  } catch (e) { next(e); }
});

r.get("/results/consolidated/:examId/pdf", role("admin", "student"), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.examId)) return res.status(400).json({ error: "Invalid exam id" });
    const baseExam = await Exam.findById(req.params.examId);
    if (!baseExam || baseExam.status !== "published") return res.status(404).json({ error: "Published exam not found" });
    let student = null;
    if (req.user.role === "student") {
      student = await Student.findOne({ user: req.user.id }).populate("user", "name phone avatar").populate("class", "name section");
      if (!student || String(student.class?._id) !== String(baseExam.class)) return res.status(403).json({ error: "You can only download your own report card" });
    } else if (req.query.studentId) {
      if (!mongoose.isValidObjectId(req.query.studentId)) return res.status(400).json({ error: "Invalid student id" });
      student = await Student.findById(req.query.studentId).populate("user", "name phone avatar").populate("class", "name section");
      if (!student || String(student.class?._id) !== String(baseExam.class)) return res.status(404).json({ error: "Student is not enrolled in this exam class" });
    }
    const groupExams = await Exam.find(publishedExamGroupFilter(baseExam)).populate(examPopulation).sort({ date: 1, _id: 1 }).lean();
    if (!groupExams.length) return res.status(404).json({ error: "No published subjects found for this exam" });
    const reportExams = student
      ? groupExams.filter((exam) => exam.marks?.some((mark) => String(mark.student?._id || mark.student) === String(student._id)))
      : groupExams;
    const rosterIds = [...new Set(groupExams.flatMap((exam) => exam.students || []).map(String))];
    const students = student ? [student] : await Student.find(rosterIds.length ? { _id: { $in: rosterIds } } : { class: baseExam.class })
      .populate("user", "name phone avatar").populate("class", "name section").sort({ rollNo: 1, admissionNo: 1 });
    if (!students.length) return res.status(404).json({ error: "No students are enrolled in this class" });
    if (student && !reportExams.length) {
      return res.status(404).json({ error: "No published marks are available for this student and exam" });
    }
    const logo = await readFile(SCHOOL_LOGO_PATH);
    const fileName = String(baseExam.name).replace(/[^a-z\d_-]/gi, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${student ? "report-card" : "class-report-cards"}-${fileName}.pdf"`);
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    doc.pipe(res);
    const x = 36;
    const width = 523;
    const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-IN") : "—";
    const money = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
    const title = baseExam.term ? `${baseExam.term} · ${baseExam.name}` : baseExam.name;

    for (const [studentIndex, currentStudent] of students.entries()) {
      if (studentIndex) doc.addPage();
      doc.image(logo, x, 22, { fit: [68, 68] });
      doc.fillColor("#17375e").font("Helvetica-Bold").fontSize(21).text(SCHOOL_NAME.toUpperCase(), 108, 29, { width: 450, align: "center", lineBreak: false });
      doc.fillColor("#8c1722").font("Helvetica-Bold").fontSize(9.5).text(SCHOOL_ADDRESS.toUpperCase(), 108, 56, { width: 450, align: "center", lineBreak: false });
      doc.fillColor("#475569").font("Helvetica").fontSize(10).text(`${title} · ${baseExam.date ? new Date(baseExam.date).getFullYear() : new Date().getFullYear()}`, 108, 75, { width: 450, align: "center", lineBreak: false });
      doc.moveTo(x, 101).lineTo(x + width, 101).strokeColor("#aab5c3").lineWidth(0.8).stroke();

      const infoY = 112;
      const leftInfoWidth = 430;
      const photoX = x + leftInfoWidth;
      const infoRows = [
        [`Student's Name: ${currentStudent.user?.name || "—"}`, 19],
        [`Father's Name: ${currentStudent.fatherName || currentStudent.guardian?.name || "—"}`, 19],
        [`Mother's Name: ${currentStudent.motherName || "—"}`, 19],
        [`Class: ${currentStudent.class?.name || "—"} · Section ${currentStudent.class?.section || "A"}     Roll No.: ${currentStudent.rollNo || "—"}`, 19],
        [`Admission No.: ${currentStudent.admissionNo || "—"}     DOB: ${formatDate(currentStudent.dob)}`, 19],
        [`Aadhaar: ${currentStudent.aadhaarNumber ? `XXXX XXXX ${currentStudent.aadhaarNumber.slice(-4)}` : "—"}     Gender: ${currentStudent.gender || "—"}     Caste: ${currentStudent.caste || "—"}`, 19],
      ];
      const infoCell = (top, text, height) => {
        doc.save().lineWidth(0.6).strokeColor("#333333").rect(x, top, leftInfoWidth, height).stroke().restore();
        doc.fillColor("#172033").font("Helvetica").fontSize(8.5).text(text, x + 6, top + 5, { width: leftInfoWidth - 12, lineBreak: false, ellipsis: true });
      };
      let infoTop = infoY;
      for (const [text, height] of infoRows) { infoCell(infoTop, text, height); infoTop += height; }
      const photoHeight = infoRows.reduce((sum, [, height]) => sum + height, 0);
      doc.save().lineWidth(0.6).strokeColor("#333333").rect(photoX, infoY, width - leftInfoWidth, photoHeight).stroke().restore();
      let photoIncluded = false;
      if (currentStudent.user?.avatar) {
        try {
          const photo = await downloadPrivateObject(currentStudent.user.avatar);
          if (["image/png", "image/jpeg"].includes(photo.contentType)) {
            doc.image(photo.buffer, photoX + 4, infoY + 4, { fit: [width - leftInfoWidth - 8, photoHeight - 8], align: "center", valign: "center" });
            photoIncluded = true;
          }
        } catch { /* Continue with the photo placeholder when storage is unavailable. */ }
      }
      if (!photoIncluded) doc.fillColor("#64748b").font("Helvetica").fontSize(8).text("Student Photo", photoX + 4, infoY + 51, { width: width - leftInfoWidth - 8, align: "center" });

      const reportY = infoY + photoHeight + 11;
      doc.fillColor("#8c1722").font("Helvetica-Bold").fontSize(18).text("REPORT CARD", x, reportY, { width, align: "center" });
      const tableY = reportY + 29;
      const headerHeight = 22;
      const rowHeight = Math.min(18, 360 / reportExams.length);
      const columns = [42, 235, 77, 83, 86];
      const drawCell = (left, top, cellWidth, height, text, options = {}) => {
        doc.save().lineWidth(0.6).strokeColor("#333333").rect(left, top, cellWidth, height).stroke().restore();
        doc.fillColor(options.color || "#172033").font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.size || 8.5)
          .text(String(text ?? ""), left + 3, top + Math.max(3, (height - (options.size || 8.5)) / 2 - 1), { width: cellWidth - 6, height: height - 3, align: options.align || "center", lineBreak: false, ellipsis: true });
      };
      let colX = x;
      ["Sl. No.", "SUBJECTS", "FULL MARKS", "PASS MARKS", "MARKS"].forEach((label, index) => { drawCell(colX, tableY, columns[index], headerHeight, label, { bold: true, size: 7.7 }); colX += columns[index]; });
      let totalMarks = 0;
      let totalMax = 0;
      let allPassed = true;
      reportExams.forEach((exam, index) => {
        const mark = (exam.marks || []).find((entry) => String(entry.student?._id || entry.student) === String(currentStudent._id));
        const maxMarks = exam.maxMarks || 100;
        const passMarks = exam.passMarks ?? Math.ceil(maxMarks * 0.33);
        const score = mark?.attendance === "absent" ? 0 : Number(mark?.marks || 0);
        totalMarks += score;
        totalMax += maxMarks;
        if (!mark || mark.attendance === "absent" || score < passMarks) allPassed = false;
        const values = [`${String(index + 1).padStart(2, "0")}.`, exam.subject?.name || "Subject", maxMarks, passMarks, mark?.attendance === "absent" ? "Absent" : mark ? score : "—"];
        let cellX = x;
        values.forEach((value, column) => { drawCell(cellX, tableY + headerHeight + index * rowHeight, columns[column], rowHeight, value, { bold: column === 4, size: 8 }); cellX += columns[column]; });
      });
      const summaryY = tableY + headerHeight + reportExams.length * rowHeight;
      const percentage = totalMax ? totalMarks / totalMax * 100 : 0;
      const summaryLabelWidth = 163;
      const summaryValueWidth = width - 274 - summaryLabelWidth;
      [["Total Marks", `${money(totalMarks)} / ${money(totalMax)}`], ["Percentage", `${percentage.toFixed(1)}%`], ["Result", allPassed ? "Pass" : "Needs improvement"]].forEach(([label, value], index) => {
        const top = summaryY + index * 21;
        drawCell(x, top, 274, 21, "");
        drawCell(x + 274, top, summaryLabelWidth, 21, label, { bold: true, size: 9 });
        drawCell(x + 274 + summaryLabelWidth, top, summaryValueWidth, 21, value, { bold: true, size: 9, color: label === "Result" && !allPassed ? "#9f1239" : "#172033" });
      });
      const signatureY = summaryY + 63 + 25;
      doc.moveTo(x + 18, signatureY).lineTo(x + 178, signatureY).strokeColor("#333333").lineWidth(0.7).stroke();
      doc.moveTo(x + width - 178, signatureY).lineTo(x + width - 18, signatureY).strokeColor("#333333").lineWidth(0.7).stroke();
      doc.fillColor("#172033").font("Helvetica").fontSize(9).text("Teacher's Signature", x + 18, signatureY + 6, { width: 160, align: "center" });
      doc.text("Principal's Signature", x + width - 178, signatureY + 6, { width: 160, align: "center" });
      doc.fillColor("#64748b").fontSize(7.5).text(`Generated ${formatDate(new Date())} · ${currentStudent.admissionNo}`, x, 790, { width, align: "center" });
    }
    doc.end();
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
    const [schoolClass, subject, students] = await Promise.all([
      Class.findById(req.body.class).select("_id"),
      Subject.findById(req.body.subject).select("_id class"),
      Student.find({ class: req.body.class }).select("_id"),
    ]);
    if (!schoolClass) return res.status(404).json({ error: "Class not found" });
    if (!subject || String(subject.class || "") !== req.body.class) {
      return res.status(400).json({ error: "Choose a subject created for this class" });
    }
    if (!students.length) return res.status(400).json({ error: "This class has no enrolled students yet" });
    const exam = await Exam.create({ ...req.body, students: students.map((student) => student._id), status: "draft" });
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
    const students = exam.students?.length
      ? exam.students.map((student) => ({ _id: student }))
      : await Student.find({ class: exam.class }).select("_id");
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
    const studentIds = exam.students?.length ? exam.students : await Student.find({ class: exam.class }).distinct("_id");
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
