import { Router } from "express";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import Student from "../models/Student.js";
import Attendance from "../models/Attendance.js";
import Fee from "../models/Fee.js";
import Exam from "../models/Exam.js";
import { auth, role } from "../middleware/auth.js";
import { reportRateLimit } from "../middleware/rateLimits.js";

const r = Router();
r.use(auth());

const SCHOOL_NAME = "Baal Niketan School";
const SCHOOL_ADDRESS = "Jonhi, Basua, Aurai";

r.get("/student/:id/pdf", role("admin"), reportRateLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid student id" });
    const s = await Student.findById(req.params.id).select("user class admissionNo")
      .populate("user", "name").populate("class", "name section");
    if (!s) return res.status(404).json({ error: "Not found" });
    const [exams, attendance] = await Promise.all([
      Exam.find({ class: s.class._id, status: "published" }).select("name subject marks")
        .populate("subject", "name").sort({ date: -1, _id: -1 }),
      Attendance.aggregate([
        { $match: { student: s._id } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
        } },
      ]),
    ]);
    const attendanceSummary = attendance[0] || { total: 0, present: 0 };

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="report-${s.admissionNo}.pdf"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
    doc.fontSize(18).fillColor("#12375f").text(SCHOOL_NAME, { align: "center" });
    doc.fontSize(10).fillColor("#64748b").text(SCHOOL_ADDRESS, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(15).fillColor("#0f172a").text("Student Report Card", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Name: ${s.user.name}`);
    doc.text(`Admission No: ${s.admissionNo}`);
    doc.text(`Class: ${s.class.name} · Section ${s.class.section || "A"}`);
    doc.moveDown();
    doc.text(`Attendance (present): ${attendanceSummary.present}/${attendanceSummary.total}`);
    doc.moveDown();
    doc.text("Marks:");
    exams.forEach((e) => {
      const m = e.marks.find((x) => String(x.student) === String(s._id));
      if (m) doc.text(`  ${e.subject?.name || "Subject"} – ${e.name}: ${m.marks}/${m.maxMarks}`);
    });
    doc.end();
  } catch (e) { next(e); }
});

r.get("/students.xlsx", role("admin"), reportRateLimit, async (req, res, next) => {
  try {
    const students = await Student.find().populate("user", "name email").populate("class", "name section");
    const wb = new ExcelJS.Workbook();
    wb.creator = SCHOOL_NAME;
    wb.subject = `${SCHOOL_NAME} student records`;
    const ws = wb.addWorksheet("Students");
    ws.columns = [
      { header: "Admission No", key: "admissionNo", width: 18 },
      { header: "Name", key: "name", width: 25 },
      { header: "Email", key: "email", width: 30 },
      { header: "Class", key: "class", width: 15 },
      { header: "Roll", key: "rollNo", width: 10 },
    ];
    students.forEach((s) =>
      ws.addRow({
        admissionNo: s.admissionNo,
        name: s.user?.name,
        email: s.user?.email,
        class: s.class ? `${s.class.name} · Section ${s.class.section || "A"}` : "—",
        rollNo: s.rollNo,
      })
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="students.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

r.get("/fees.xlsx", role("admin"), reportRateLimit, async (req, res, next) => {
  try {
    const fees = await Fee.find().populate({ path: "student", populate: { path: "user", select: "name" } });
    const wb = new ExcelJS.Workbook();
    wb.creator = SCHOOL_NAME;
    wb.subject = `${SCHOOL_NAME} fee records`;
    const ws = wb.addWorksheet("Fees");
    ws.columns = [
      { header: "Student", key: "name", width: 25 },
      { header: "Title", key: "title", width: 25 },
      { header: "Amount", key: "amount", width: 12 },
      { header: "Status", key: "status", width: 10 },
      { header: "Due", key: "dueDate", width: 15 },
    ];
    fees.forEach((f) =>
      ws.addRow({
        name: f.student?.user?.name,
        title: f.title,
        amount: f.amount,
        status: f.status,
        dueDate: f.dueDate?.toISOString().slice(0, 10),
      })
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="fees.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

export default r;