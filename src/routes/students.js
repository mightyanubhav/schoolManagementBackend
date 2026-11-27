import { Router } from "express";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { readFile } from "node:fs/promises";
import FeePayment from "../models/FeePayment.js";
import FeeStructure from "../models/FeeStructure.js";
import multer from "multer";
import { z } from "zod";
import Class from "../models/Class.js";
import Student from "../models/Student.js";
import Teacher from "../models/Teacher.js";
import User from "../models/User.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createPrivateDownloadUrl, deletePrivateObject, downloadPrivateObject, uploadPrivateObject } from "../utils/cloudflareStorage.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";
import { passwordSchema } from "../utils/passwordValidation.js";

const r = Router();
r.use(auth());

const SCHOOL_NAME = "Baal Niketan School";
const SCHOOL_ADDRESS = "Jonki, Basua, Aurai, Muzaffarpur 843321";
const SCHOOL_PHONE = "9263349380";
const SCHOOL_LOGO_PATH = new URL("../../../client/src/assets/schoolLogo.png", import.meta.url);

const optionalText = (max) => z.string().trim().max(max).optional().or(z.literal(""));
const optionalDate = z.preprocess((value) => value === "" ? undefined : value, z.coerce.date().optional());
const studentFields = {
  class: z.string().regex(/^[a-f\d]{24}$/i, "Invalid class"),
  rollNo: optionalText(20),
  fatherName: optionalText(100),
  motherName: optionalText(100),
  caste: optionalText(80),
  aadhaarNumber: z.string().regex(/^\d{12}$/).optional().or(z.literal("")),
  dob: optionalDate,
  admissionDate: optionalDate,
  gender: z.enum(["male", "female", "other"]).optional(),
  address: optionalText(500),
};
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  temporaryPassword: passwordSchema,
  admissionNo: z.string().trim().min(1).max(50),
  ...studentFields,
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  admissionNo: z.string().trim().min(1).max(50),
  ...studentFields,
});
const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  class: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  section: z.string().trim().max(20).optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
  caste: z.string().trim().max(80).optional(),
});

const allowedProfileTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedDocumentTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 11, fields: 30 },
  fileFilter: (req, file, callback) => {
    if (file.fieldname === "profileImage") {
      callback(file.size > 300 * 1024 ? new Error("Student photograph must be 300 KB or smaller") : allowedProfileTypes.has(file.mimetype) ? null : new Error("Unsupported profile image type"), allowedProfileTypes.has(file.mimetype));
    } else {
      callback(file.fieldname === "documents" && allowedDocumentTypes.has(file.mimetype) ? null : new Error("Unsupported document type"), file.fieldname === "documents" && allowedDocumentTypes.has(file.mimetype));
    }
  },
}).fields([
  { name: "profileImage", maxCount: 1 },
  { name: "documents", maxCount: 10 },
]);

function receiveStudentFiles(req, res, next) {
  upload(req, res, (error) => {
    if (!error) return next();
    return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Uploads must be 5 MB or smaller" : error.message });
  });
}

function fileExtension(file) {
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  })[file.mimetype] || "bin";
}

r.get("/", role("admin", "teacher"), async (req, res, next) => {
  try {
    const parsedQuery = listQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid student filters" });
    const { q, class: cls, section, gender, caste } = parsedQuery.data;
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const filter = {};
    if (cls) filter.class = cls;
    if (section) filter.section = section;
    if (gender) filter.gender = gender;
    if (caste) filter.caste = caste;
    if (req.user.role === "teacher") {
      const teacher = await Teacher.findOne({ user: req.user.id }).select("classes");
      const classIds = teacher?.classes || [];
      if (cls && !classIds.some((id) => String(id) === String(cls))) {
        return res.status(403).json({ error: "You can only view students in your assigned classes" });
      }
      filter.class = cls || { $in: classIds };
    }
    if (q) {
      const search = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matchingUsers = await User.find({ name: { $regex: search, $options: "i" } }).select("_id");
      filter.$or = [
        { admissionNo: { $regex: search, $options: "i" } },
        { rollNo: { $regex: search, $options: "i" } },
        { user: { $in: matchingUsers.map((match) => match._id) } },
      ];
    }
    const fields = req.user.role === "teacher"
      ? "user class admissionNo rollNo section fatherName motherName gender"
      : "user class admissionNo rollNo section fatherName motherName gender caste dob aadhaarNumber address admissionDate documents";
    let [list, total] = await Promise.all([
      Student.find(filter).select(fields).populate("user", "name avatar").populate("class", "name section")
        .sort({ admissionNo: 1, _id: 1 }).skip(pagination.skip).limit(pagination.limit),
      Student.countDocuments(filter),
    ]);
    list = await Promise.all(list.map(async (student) => {
      const item = student.toObject();
      item.profileImageUrl = item.user?.avatar
        ? await createPrivateDownloadUrl(item.user.avatar, { inline: true })
        : null;
      item.documents = (student.documents || []).map((document) => ({
        _id: document._id,
        name: document.name,
        contentType: document.contentType,
        size: document.size,
      }));
      return item;
    }));
    setPaginationHeaders(res, { ...pagination, total });
    res.json(list);
  } catch (e) {
    next(e);
  }
});

r.get("/:id/admission.pdf", role("admin"), async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid student id" });
    const [student, structure, payments, logo] = await Promise.all([
      Student.findById(req.params.id)
        .populate("user", "name email phone avatar")
        .populate("class", "name section room"),
      FeeStructure.findOne({ student: req.params.id }).lean(),
      FeePayment.find({ student: req.params.id, type: "one-time" }).sort({ paidAt: 1, _id: 1 }).lean(),
      readFile(SCHOOL_LOGO_PATH),
    ]);
    if (!student) return res.status(404).json({ error: "Student not found" });
    const studentPhoto = student.user?.avatar ? await downloadPrivateObject(student.user.avatar) : null;

    const feeHeads = [
      ["admissionFee", "Admission Fee", false], ["securityDeposit", "Security Deposit", false],
      ["schoolFee", "School Fee (Monthly)", true], ["registrationFee", "Registration Fee", false],
      ["previousDues", "Previous Dues", false], ["examinationFee", "Examination Fee", false],
      ["computerEducationFee", "Computer Education Fee", false], ["tieBelt", "Tie + Belt", false],
      ["idCard", "ID Card", false], ["schoolDiary", "School Diary", false],
      ["classPicnic", "Class Picnic", false], ["schoolTrip", "School Trip", false],
      ["lateFee", "Late Fee", false], ["shoesSocks", "Shoes + Socks", false],
      ["books", "Books", false], ["dressFee", "Dress Fee", false],
    ].map(([key, label, monthly]) => ({ label, amount: Number(structure?.[key] || (key === "schoolFee" ? structure?.monthlyFee : 0) || 0), monthly }));
    const oneTimeTotal = feeHeads.filter((item) => !item.monthly).reduce((total, item) => total + item.amount, 0);
    const oneTimePaid = payments.reduce((total, payment) => total + payment.paidAmount, 0);
    const due = Math.max(0, oneTimeTotal - oneTimePaid);
    const formatMoney = (amount) => `Rs. ${Number(amount || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
    const formatDate = (date) => date ? new Date(date).toLocaleDateString("en-IN") : "—";
    const now = new Date();
    const sessionStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const session = `${sessionStart}-${sessionStart + 1}`;
    const lastPayment = payments.at(-1);

    res.setHeader("Content-Type", "application/pdf");
    const fileId = String(student.admissionNo).replace(/[^a-z\d_-]/gi, "_");
    res.setHeader("Content-Disposition", `attachment; filename="admission-${fileId}.pdf"`);
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    doc.pipe(res);
    const x = 36;
    const width = 523;
    const maroon = "#8c1722";
    const ink = "#172033";
    const cell = (left, top, cellWidth, height, label, value, options = {}) => {
      doc.save().lineWidth(0.7).strokeColor("#202020").rect(left, top, cellWidth, height).stroke().restore();
      const text = value ? `${label}${value ? ` ${value}` : ""}` : label;
      doc.fillColor(ink).font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.size || 9.5)
        .text(text, left + 6, top + 6, { width: cellWidth - 12, height: height - 8, lineBreak: false, ellipsis: true, align: options.align || "left" });
    };

    doc.image(logo, x, 24, { fit: [91, 91] });
    doc.fillColor(maroon).font("Times-Bold").fontSize(27).text(SCHOOL_NAME, 132, 37, { width: 342, align: "center", lineBreak: false });
    doc.fillColor(ink).font("Times-Roman").fontSize(11).text(SCHOOL_ADDRESS, 132, 72, { width: 342, align: "center", lineBreak: false });
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(9.5).text(`Date: ${formatDate(new Date())}`, 470, 36, { width: 88, align: "right" });
    doc.roundedRect(181, 99, 235, 31, 7).lineWidth(1.6).strokeColor("#171717").stroke();
    doc.roundedRect(185, 103, 227, 23, 5).lineWidth(0.6).strokeColor("#171717").stroke();
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(13).text(`SESSION - ${session}`, 188, 108, { width: 221, align: "center" });

    const y = 144;
    const leftWidth = 425;
    const rowHeight = 24;
    const valueFor = (value) => value || "________________________";
    cell(x, y, leftWidth, rowHeight, "Student's Name :", valueFor(student.user?.name));
    cell(x, y + rowHeight, leftWidth, rowHeight, "Father's Name :", valueFor(student.fatherName || student.guardian?.name));
    cell(x, y + rowHeight * 2, leftWidth, rowHeight, "Mother's Name :", valueFor(student.motherName));
    cell(x, y + rowHeight * 3, 214, rowHeight, "Class: ", valueFor(student.class?.name));
    cell(x + 214, y + rowHeight * 3, leftWidth - 214, rowHeight, "Roll No.: ", valueFor(student.rollNo));
    cell(x, y + rowHeight * 4, 196, rowHeight, "Aadhaar No.: ", valueFor(student.aadhaarNumber));
    cell(x + 196, y + rowHeight * 4, 116, rowHeight, "Ad. Date: ", formatDate(student.admissionDate));
    cell(x + 312, y + rowHeight * 4, leftWidth - 312, rowHeight, "D.O.B.: ", formatDate(student.dob));
    cell(x, y + rowHeight * 5, 214, rowHeight, "Mobile: ", valueFor(student.user?.phone || student.guardian?.phone));
    cell(x + 214, y + rowHeight * 5, leftWidth - 214, rowHeight, "Registration No.: ", student.admissionNo);
    cell(x, y + rowHeight * 6, width, 27, "Address: ", valueFor(student.address));
    doc.save().lineWidth(0.7).strokeColor("#202020").rect(x + leftWidth, y, width - leftWidth, rowHeight * 6).stroke().restore();
    if (studentPhoto && ["image/png", "image/jpeg"].includes(studentPhoto.contentType)) {
      doc.image(studentPhoto.buffer, x + leftWidth + 5, y + 5, { fit: [width - leftWidth - 10, rowHeight * 6 - 10], align: "center", valign: "center" });
    } else {
      doc.fillColor("#64748b").font("Helvetica").fontSize(9).text(studentPhoto ? "Photo format not supported" : "Student Photo", x + leftWidth + 5, y + 67, { width: width - leftWidth - 10, align: "center" });
    }

    const sectionY = 326;
    doc.roundedRect(161, sectionY, 257, 37, 8).lineWidth(1.8).strokeColor("#171717").stroke();
    doc.roundedRect(166, sectionY + 4, 247, 29, 6).lineWidth(0.6).strokeColor("#171717").stroke();
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(15).text("Fee Structure", 169, sectionY + 13, { width: 241, align: "center" });
    doc.save().dash(4, { space: 3 }).roundedRect(430, sectionY + 4, 129, 29, 6).lineWidth(1).strokeColor("#333333").stroke().restore();
    doc.fillColor(maroon).font("Helvetica-Bold").fontSize(9).text("Pay Phone:", 437, sectionY + 14);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(9).text(SCHOOL_PHONE, 491, sectionY + 14);

    const tableY = 374;
    const headerHeight = 23;
    const feeRowHeight = 17.7;
    const serialWidth = 47;
    const amountWidth = 111;
    const particularsWidth = width - serialWidth - amountWidth;
    const drawTableCell = (left, top, cellWidth, height, text, options = {}) => {
      doc.save().lineWidth(0.65).strokeColor("#333333").rect(left, top, cellWidth, height).stroke().restore();
      doc.fillColor(options.color || ink).font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.size || 9.2)
        .text(text, left + 4, top + 4, { width: cellWidth - 8, height: height - 5, align: options.align || "left", lineBreak: false, ellipsis: true });
    };
    drawTableCell(x, tableY, serialWidth, headerHeight, "Sl. No.", { bold: true, align: "center" });
    drawTableCell(x + serialWidth, tableY, particularsWidth, headerHeight, "PARTICULARS", { bold: true, align: "center" });
    drawTableCell(x + serialWidth + particularsWidth, tableY, amountWidth, headerHeight, "AMOUNT", { bold: true, align: "center" });
    feeHeads.forEach((item, index) => {
      const rowY = tableY + headerHeight + index * feeRowHeight;
      drawTableCell(x, rowY, serialWidth, feeRowHeight, `${index + 1}.`, { align: "center", size: 9 });
      drawTableCell(x + serialWidth, rowY, particularsWidth, feeRowHeight, item.monthly ? `${item.label} — payable monthly` : item.label, { size: 9 });
      drawTableCell(x + serialWidth + particularsWidth, rowY, amountWidth, feeRowHeight, item.amount > 0 ? formatMoney(item.amount) : "", { align: "right", size: 9 });
    });
    const summaryY = tableY + headerHeight + feeHeads.length * feeRowHeight;
    const summaryLabelWidth = particularsWidth + serialWidth - 111;
    const summaryRows = [["One-time Total", oneTimeTotal], ["Paid", oneTimePaid], ["Dues", due]];
    summaryRows.forEach(([label, amount], index) => {
      const top = summaryY + index * 19;
      drawTableCell(x, top, summaryLabelWidth, 19, "", { size: 9 });
      const color = label === "Paid" ? maroon : ink;
      drawTableCell(x + summaryLabelWidth, top, 111, 19, label, { bold: true, align: "center", size: 9, color });
      drawTableCell(x + summaryLabelWidth + 111, top, amountWidth, 19, formatMoney(amount), { bold: true, align: "right", size: 9, color });
    });
    if (lastPayment) {
      doc.fillColor("#475569").font("Helvetica").fontSize(8).text(`Last one-time payment: ${formatDate(lastPayment.paidAt)} · Receipt ${lastPayment.receiptNo} · ${formatMoney(lastPayment.paidAmount)}`, x, summaryY + 61, { width, align: "left", lineBreak: false, ellipsis: true });
    } else {
      doc.fillColor("#475569").font("Helvetica").fontSize(8).text("No one-time payment has been recorded.", x, summaryY + 61, { width });
    }
    doc.moveTo(385, 762).lineTo(551, 762).strokeColor("#333333").lineWidth(0.8).stroke();
    doc.fillColor(ink).font("Helvetica").fontSize(10).text("Principal's Signature", 385, 769, { width: 166, align: "center" });
    doc.end();
  } catch (e) { next(e); }
});

r.post("/", role("admin"), receiveStudentFiles, validate(createSchema), async (req, res, next) => {
  let user;
  let student;
  const uploadedKeys = [];
  try {
    const { name, temporaryPassword, admissionNo, ...rest } = req.body;
    const normalizedStudentId = admissionNo.trim();
    const schoolClass = await Class.findById(rest.class).select("section");
    if (!schoolClass) return res.status(404).json({ error: "Class not found" });
    const email = `${normalizedStudentId.replace(/[^a-z0-9]/gi, "").toLowerCase()}@school.local`;
    user = await User.create({
      name,
      email,
      password: temporaryPassword,
      role: "student",
      mustChangePassword: true,
    });
    student = await Student.create({
      user: user._id,
      admissionNo: normalizedStudentId,
      ...rest,
      section: schoolClass.section || "A",
    });

    const profileImage = req.files?.profileImage?.[0];
    if (profileImage) {
      if (profileImage.size > 300 * 1024) {
        await Student.findByIdAndDelete(student._id);
        await User.findByIdAndDelete(user._id);
        return res.status(400).json({ error: "Student photograph must be 300 KB or smaller" });
      }
      const key = `students/${student._id}/profile/${crypto.randomUUID()}.${fileExtension(profileImage)}`;
      await uploadPrivateObject({ key, file: profileImage });
      uploadedKeys.push(key);
      user.avatar = key;
      await user.save();
    }

    for (const file of req.files?.documents || []) {
      const key = `students/${student._id}/documents/${crypto.randomUUID()}.${fileExtension(file)}`;
      await uploadPrivateObject({ key, file });
      uploadedKeys.push(key);
      student.documents.push({ name: file.originalname, objectKey: key, contentType: file.mimetype, size: file.size });
    }
    if (student.documents.length) await student.save();

    const result = await Student.findById(student._id).populate("user", "name email phone avatar").populate("class", "name section");
    res.status(201).json(result);
  } catch (e) {
    await Promise.allSettled(uploadedKeys.map((key) => deletePrivateObject(key)));
    if (student) await Student.findByIdAndDelete(student._id);
    if (user) await User.findByIdAndDelete(user._id);
    next(e);
  }
});

r.get("/:id/documents/:documentId/download", async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id).populate("user", "_id");
    if (!student) return res.status(404).json({ error: "Student not found" });
    const isOwner = String(student.user._id) === req.user.id;
    if (!["admin", "student"].includes(req.user.role) || (req.user.role === "student" && !isOwner)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const document = student.documents.id(req.params.documentId);
    if (!document) return res.status(404).json({ error: "Document not found" });
    res.json({ url: await createPrivateDownloadUrl(document.objectKey) });
  } catch (e) { next(e); }
});

r.put("/:id", role("admin"), validate(updateSchema), async (req, res, next) => {
  try {
    const normalizedStudentId = req.body.admissionNo.trim();
    const email = `${normalizedStudentId.replace(/[^a-z0-9]/gi, "").toLowerCase()}@school.local`;
    const current = await Student.findById(req.params.id).select("user");
    if (!current) return res.status(404).json({ error: "Student not found" });
    const schoolClass = await Class.findById(req.body.class).select("section");
    if (!schoolClass) return res.status(404).json({ error: "Class not found" });
    const duplicateEmail = await User.findOne({ email, _id: { $ne: current.user } }).select("_id");
    if (duplicateEmail) return res.status(409).json({ error: "Student ID is already in use" });
    const s = await Student.findByIdAndUpdate(req.params.id, {
      ...req.body,
      section: schoolClass.section || "A",
    }, { new: true, runValidators: true });
    await User.findByIdAndUpdate(s.user, { name: req.body.name, email });
    res.json(s);
  } catch (e) {
    next(e);
  }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try {
    const s = await Student.findByIdAndDelete(req.params.id);
    if (s) {
      const user = await User.findById(s.user);
      await Promise.allSettled([
        ...s.documents.map((document) => deletePrivateObject(document.objectKey)),
        ...(user?.avatar ? [deletePrivateObject(user.avatar)] : []),
      ]);
      await User.findByIdAndDelete(s.user);
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default r;
