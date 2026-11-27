import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import Fee from "../models/Fee.js";
import FeeStructure from "../models/FeeStructure.js";
import FeePayment from "../models/FeePayment.js";
import Student from "../models/Student.js";
import User from "../models/User.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";
import { reportRateLimit } from "../middleware/rateLimits.js";

const r = Router();
r.use(auth());

const feeItems = [
  ["admissionFee", "Admission Fee"],
  ["securityDeposit", "Security Deposit"],
  ["registrationFee", "Registration Fee"],
  ["examinationFee", "Examination Fee"],
  ["computerEducationFee", "Computer Education Fee"],
  ["tieBelt", "Tie + Belt"],
  ["idCard", "ID Card"],
  ["schoolDiary", "School Diary"],
  ["classPicnic", "Class Picnic"],
  ["schoolTrip", "School Trip"],
  ["lateFee", "Late Fee"],
  ["shoesSocks", "Shoes + Socks"],
  ["books", "Books"],
  ["dressFee", "Dress Fee"],
  ["previousDues", "Previous Dues"],
];

const structureSchema = z.object({
  admissionFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  securityDeposit: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  schoolFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  registrationFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  examinationFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  computerEducationFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  tieBelt: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  idCard: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  schoolDiary: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  classPicnic: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  schoolTrip: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  lateFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  shoesSocks: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  books: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  dressFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  previousDues: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
  monthlyFee: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
});

const paymentSchema = z.object({
  student: z.string().regex(/^[a-f\d]{24}$/i, "Invalid student"),
  type: z.enum(["one-time", "monthly"]),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  paidAmount: z.coerce.number().positive().max(1_000_000_000),
  remarks: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "monthly" && (value.month == null || value.year == null)) {
    ctx.addIssue({ code: "custom", path: ["month"], message: "Month and year are required for monthly payments" });
  }
});
const feeReportQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  q: z.string().trim().max(100).optional(),
});
const legacyFeeQuerySchema = z.object({
  student: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  status: z.enum(["pending", "paid", "partial"]).optional(),
});
const studentSearchSchema = z.object({ q: z.string().trim().max(100).optional() });

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const feeItemLabels = new Map(feeItems);

function sumItems(items) {
  return items.reduce((total, item) => total + (item.amount || 0), 0);
}

function recurringSchoolFee(structure) {
  return structure?.schoolFee || structure?.monthlyFee || 0;
}

function obligationItems(structure) {
  return feeItems
    .map(([key, name]) => ({ name, amount: structure[key] || 0 }))
    .filter((item) => item.amount > 0);
}

r.get("/me", role("student"), async (req, res, next) => {
  try {
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const student = await Student.findOne({ user: req.user.id })
      .select("admissionNo rollNo section class user admissionDate")
      .populate("user", "name")
      .populate("class", "name section");
    if (!student) return res.status(404).json({ error: "Student record not found" });

    const [structure, paymentTotals, payments, paymentCount, legacyFees] = await Promise.all([
      FeeStructure.findOne({ student: student._id }).lean(),
      FeePayment.aggregate([
        { $match: { student: student._id } },
        { $group: {
          _id: { type: "$type", month: "$month", year: "$year" },
          paidAmount: { $sum: "$paidAmount" },
        } },
      ]),
      FeePayment.find({ student: student._id }).sort({ paidAt: -1, _id: -1 })
        .skip(pagination.skip).limit(pagination.limit).lean(),
      FeePayment.countDocuments({ student: student._id }),
      Fee.find({ student: student._id }).sort({ dueDate: 1, createdAt: -1 }).lean(),
    ]);
    const oneTimePaid = paymentTotals.find((item) => item._id.type === "one-time")?.paidAmount || 0;
    const monthlyPayments = paymentTotals.filter((item) => item._id.type === "monthly");
    const monthlyPaymentsByPeriod = new Map(monthlyPayments.map((item) => [
      `${item._id.year}-${item._id.month}`,
      item.paidAmount,
    ]));

    const now = new Date();
    const academicYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const admissionDate = student.admissionDate || new Date(academicYear, 3, 1);
    const oneTimeItems = structure ? obligationItems(structure) : [];
    const oneTimeTotal = sumItems(oneTimeItems);
    const monthlyFee = recurringSchoolFee(structure);
    const monthlyDues = Array.from({ length: 12 }, (_, index) => {
      const month = (index + 3) % 12 + 1;
      const year = month < 4 ? academicYear + 1 : academicYear;
      if (year < admissionDate.getFullYear() ||
          (year === admissionDate.getFullYear() && month < admissionDate.getMonth() + 1)) return null;
      const paidAmount = monthlyPaymentsByPeriod.get(`${year}-${month}`) || 0;
      const dueAmount = Math.max(0, monthlyFee - paidAmount);
      const isFuturePeriod = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
      const isPastPeriod = year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1);
      return {
        month,
        year,
        totalFee: monthlyFee,
        paidAmount,
        dueAmount,
        state: dueAmount === 0 ? "paid" : isFuturePeriod ? "upcoming" : isPastPeriod ? "overdue" : "due",
      };
    }).filter((item) => item?.totalFee > 0);

    setPaginationHeaders(res, { ...pagination, total: paymentCount });
    res.json({
      student,
      academicYear,
      structure: structure ? {
        items: oneTimeItems,
        oneTimeTotal,
        oneTimePaid,
        oneTimeDue: Math.max(0, oneTimeTotal - oneTimePaid),
        schoolFee: monthlyFee,
        monthlyFee,
      } : null,
      monthlyDues,
      totals: {
        total: oneTimeTotal + monthlyFee * monthlyDues.length,
        paid: oneTimePaid + monthlyDues.reduce((total, item) => total + item.paidAmount, 0),
        due: Math.max(0, oneTimeTotal - oneTimePaid) + monthlyDues.reduce((total, item) => total + item.dueAmount, 0),
      },
      payments,
      paymentSummary: {
        oneTimePaid,
        monthlyPaid: monthlyPayments.reduce((total, item) => total + item.paidAmount, 0),
        monthlyPeriodCount: monthlyPayments.length,
      },
      legacyFees: legacyFees.map((fee) => ({
        ...fee,
        paidAmount: fee.status === "paid" ? fee.amount : null,
        label: feeItemLabels.get(fee.title) || fee.title,
      })),
    });
  } catch (e) { next(e); }
});

r.get("/students", role("admin"), async (req, res, next) => {
  try {
    const parsedQuery = studentSearchSchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid student search" });
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const filter = {};
    if (parsedQuery.data.q) {
      const q = parsedQuery.data.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matchingUsers = await User.find({ name: { $regex: q, $options: "i" } }).select("_id");
      filter.$or = [
        { admissionNo: { $regex: q, $options: "i" } },
        { rollNo: { $regex: q, $options: "i" } },
        { user: { $in: matchingUsers.map((match) => match._id) } },
      ];
    }
    const [students, total] = await Promise.all([
      Student.find(filter)
        .select("admissionNo rollNo section class user")
        .populate("user", "name")
        .populate("class", "name section")
        .sort({ admissionNo: 1, _id: 1 }).skip(pagination.skip).limit(pagination.limit),
      Student.countDocuments(filter),
    ]);
    setPaginationHeaders(res, { ...pagination, total });
    res.json(students);
  } catch (e) { next(e); }
});

r.get("/management/:studentId", role("admin"), async (req, res, next) => {
  try {
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    if (!/^[a-f\d]{24}$/i.test(req.params.studentId)) return res.status(400).json({ error: "Invalid student id" });
    const student = await Student.findById(req.params.studentId).select("admissionNo rollNo section class user")
      .populate("user", "name").populate("class", "name section");
    if (!student) return res.status(404).json({ error: "Student not found" });
    const [structure, paymentTotals, payments, paymentCount] = await Promise.all([
      FeeStructure.findOne({ student: student._id }).lean(),
      FeePayment.aggregate([
        { $match: { student: student._id } },
        { $group: {
          _id: { type: "$type", month: "$month", year: "$year" },
          paidAmount: { $sum: "$paidAmount" },
        } },
      ]),
      FeePayment.find({ student: student._id }).sort({ paidAt: -1, _id: -1 })
        .skip(pagination.skip).limit(pagination.limit).lean(),
      FeePayment.countDocuments({ student: student._id }),
    ]);
    const items = structure ? obligationItems(structure) : [];
    const monthlyPayments = paymentTotals.filter((item) => item._id.type === "monthly");
    setPaginationHeaders(res, { ...pagination, total: paymentCount });
    res.json({
      student,
      structure,
      items,
      oneTimeTotal: sumItems(items),
      payments,
      paymentSummary: {
        oneTimePaid: paymentTotals.find((item) => item._id.type === "one-time")?.paidAmount || 0,
        monthlyPaid: monthlyPayments.reduce((total, item) => total + item.paidAmount, 0),
        monthlyPeriodCount: monthlyPayments.length,
        monthlyByPeriod: monthlyPayments.map((item) => ({
          month: item._id.month,
          year: item._id.year,
          paidAmount: item.paidAmount,
        })),
      },
    });
  } catch (e) { next(e); }
});

r.put("/structure/:studentId", role("admin"), validate(structureSchema), async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.studentId);
    if (!student) return res.status(404).json({ error: "Student not found" });
    const payments = await FeePayment.find({ student: req.params.studentId }).select("type month year paidAmount");
    const monthlyPaidByPeriod = new Map();
    for (const payment of payments.filter((item) => item.type === "monthly")) {
      const key = `${payment.year}-${payment.month}`;
      monthlyPaidByPeriod.set(key, (monthlyPaidByPeriod.get(key) || 0) + payment.paidAmount);
    }
    const monthlyFee = req.body.schoolFee;
    if ([...monthlyPaidByPeriod.values()].some((paid) => monthlyFee < paid)) {
      return res.status(400).json({ error: "Monthly fee cannot be less than the amount already paid for a month" });
    }
    const structure = await FeeStructure.findOneAndUpdate(
      { student: req.params.studentId },
      { $set: { ...req.body, monthlyFee, student: req.params.studentId } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json(structure);
  } catch (e) { next(e); }
});

r.post("/payments", role("admin"), validate(paymentSchema), async (req, res, next) => {
  try {
    const { student: studentId, type, month, year, paidAmount, remarks } = req.body;
    const [student, structure] = await Promise.all([
      Student.findById(studentId),
      FeeStructure.findOne({ student: studentId }),
    ]);
    if (!student) return res.status(404).json({ error: "Student not found" });
    if (!structure) return res.status(400).json({ error: "Save a fee structure for this student first" });

    const items = type === "one-time"
      ? obligationItems(structure)
      : [{ name: `School Fee - ${monthNames[month - 1]} ${year}`, amount: recurringSchoolFee(structure) }];
    const totalFee = type === "one-time" ? sumItems(items) : recurringSchoolFee(structure);
    if (!totalFee) return res.status(400).json({ error: "The fee amount must be greater than zero" });

    const paymentFilter = { student: studentId, type };
    if (type === "monthly") Object.assign(paymentFilter, { month, year });
    const existingPayments = await FeePayment.find(paymentFilter).select("paidAmount");
    const totalPaid = existingPayments.reduce((total, payment) => total + payment.paidAmount, 0);
    const dueAmount = Math.max(0, totalFee - totalPaid);
    if (paidAmount > dueAmount) {
      return res.status(400).json({ error: `Payment exceeds the remaining Baalance of ₹${dueAmount}` });
    }

    const payment = await FeePayment.create({
      student: studentId,
      type,
      ...(type === "monthly" && { month, year }),
      totalFee,
      paidAmount,
      dueAmount: dueAmount - paidAmount,
      items,
      receiptNo: `F-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      receivedBy: req.user.id,
      remarks,
    });
    res.status(201).json(payment);
  } catch (e) { next(e); }
});

r.get("/report", role("admin"), reportRateLimit, async (req, res, next) => {
  try {
    const parsedQuery = feeReportQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid fee report filters" });
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const { year, month: selectedMonth, q } = parsedQuery.data;
    const academicYear = year || new Date().getFullYear();
    const monthNumbers = selectedMonth
      ? [selectedMonth]
      : [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
    const students = await Student.find()
      .select("admissionNo rollNo class user")
      .populate("user", "name")
      .populate("class", "name section")
      .lean();
    const structures = await FeeStructure.find().lean();
    const structureMap = new Map(structures.map((item) => [String(item.student), item]));
    const studentIds = students.map((student) => student._id);
    const payments = await FeePayment.find({ student: { $in: studentIds } }).lean();
    const paymentStats = new Map();
    for (const payment of payments) {
      const key = `${payment.student}:${payment.type}:${payment.month || ""}:${payment.year || ""}`;
      const stats = paymentStats.get(key) || { paidAmount: 0, date: null };
      stats.paidAmount += payment.paidAmount;
      if (!stats.date || new Date(payment.paidAt) > new Date(stats.date)) stats.date = payment.paidAt;
      paymentStats.set(key, stats);
    }
    const rows = [];

    for (const student of students) {
      const structure = structureMap.get(String(student._id));
      if (!structure) continue;
      const oneTime = paymentStats.get(`${student._id}:one-time::`);
      const oneTimeTotal = sumItems(obligationItems(structure));
      if (oneTimeTotal > 0) {
        const totalPaid = oneTime?.paidAmount || 0;
        rows.push({
          student,
          type: "one-time",
          month: null,
          year: null,
          totalFee: oneTimeTotal,
          paidAmount: totalPaid,
          dueAmount: Math.max(0, oneTimeTotal - totalPaid),
          date: oneTime?.date || null,
        });
      }

      const monthlyFee = recurringSchoolFee(structure);
      if (!monthlyFee) continue;
      for (const month of monthNumbers) {
        const year = month < 4 ? academicYear + 1 : academicYear;
        const monthly = paymentStats.get(`${student._id}:monthly:${month}:${year}`);
        const totalPaid = monthly?.paidAmount || 0;
        rows.push({
          student,
          type: "monthly",
          month,
          year,
          totalFee: monthlyFee,
          paidAmount: totalPaid,
          dueAmount: Math.max(0, monthlyFee - totalPaid),
          date: monthly?.date || null,
        });
      }
    }

    const query = (q || "").toLowerCase();
    const filteredRows = query ? rows.filter((row) =>
      [row.student.user?.name, row.student.admissionNo, row.student.rollNo, row.student.class?.name]
        .some((value) => value?.toLowerCase().includes(query))
    ) : rows;
    setPaginationHeaders(res, { ...pagination, total: filteredRows.length });
    res.json({
      rows: filteredRows.slice(pagination.skip, pagination.skip + pagination.limit),
      totals: filteredRows.reduce((totals, row) => ({
        totalFee: totals.totalFee + row.totalFee,
        paidAmount: totals.paidAmount + row.paidAmount,
        dueAmount: totals.dueAmount + row.dueAmount,
      }), { totalFee: 0, paidAmount: 0, dueAmount: 0 }),
      months: monthNames,
    });
  } catch (e) { next(e); }
});

const schema = z.object({
  student: z.string().regex(/^[a-f\d]{24}$/i, "Invalid student"),
  title: z.string().trim().min(1).max(120),
  amount: z.coerce.number().nonnegative().max(1_000_000_000),
  dueDate: z.coerce.date().optional(),
  paidDate: z.coerce.date().optional(),
  status: z.enum(["pending", "paid", "partial"]).optional(),
  method: z.enum(["cash", "card", "bank", "upi"]).optional(),
  remarks: z.string().trim().max(500).optional(),
});

r.get("/", role("admin", "student", "parent"), async (req, res, next) => {
  try {
    const parsedQuery = legacyFeeQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid fee filters" });
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const { student, status } = parsedQuery.data;
    const filter = {};
    if (student) {
      filter.student = new mongoose.Types.ObjectId(student);
    }
    if (status) filter.status = status;
    if (req.user.role === "student") {
      const studentRecord = await Student.findOne({ user: req.user.id }).select("_id");
      if (!studentRecord) return res.json([]);
      filter.student = studentRecord._id;
    } else if (req.user.role === "parent") {
      const children = await Student.find({ parentUser: req.user.id }).select("_id");
      filter.student = { $in: children.map((child) => child._id) };
    }
    const [fees, summary] = await Promise.all([
      Fee.find(filter).populate({
        path: "student",
        populate: { path: "user", select: "name" },
      }).sort({ createdAt: -1, _id: -1 }).skip(pagination.skip).limit(pagination.limit),
      Fee.aggregate([{ $match: filter }, { $group: {
        _id: null,
        total: { $sum: 1 },
        amount: { $sum: "$amount" },
        pending: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 0, "$amount"] } },
      } }]),
    ]);
    const totals = summary[0] || { total: 0, amount: 0, pending: 0 };
    const total = totals.total;
    setPaginationHeaders(res, { ...pagination, total });
    res.set({ "X-Total-Amount": String(totals.amount), "X-Total-Pending": String(totals.pending) });
    res.json(fees);
  } catch (e) { next(e); }
});

r.post("/", role("admin"), validate(schema), async (req, res, next) => {
  try { res.status(201).json(await Fee.create(req.body)); } catch (e) { next(e); }
});

r.put("/:id", role("admin"), validate(schema), async (req, res, next) => {
  try {
    const fee = await Fee.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!fee) return res.status(404).json({ error: "Fee record not found" });
    res.json(fee);
  }
  catch (e) { next(e); }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try { await Fee.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default r;
