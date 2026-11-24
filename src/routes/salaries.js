import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import Salary from "../models/Salary.js";
import Teacher from "../models/Teacher.js";
import User from "../models/User.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";

const r = Router();
r.use(auth());

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record id");
const listQuerySchema = z.object({
  teacher: objectId.optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  status: z.enum(["paid", "partial", "due"]).optional(),
  q: z.string().trim().max(100).optional(),
});
const schema = z.object({
  teacher: z.string().regex(/^[a-f\d]{24}$/i, "Invalid teacher"),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  amount: z.coerce.number().positive().max(1_000_000_000),
  paidAmount: z.coerce.number().nonnegative().max(1_000_000_000).optional(),
  status: z.enum(["paid", "partial", "due"]),
  paidDate: z.coerce.date().optional(),
  remarks: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  const paidAmount = value.paidAmount || 0;
  if (value.status === "paid" && value.paidAmount !== value.amount) {
    ctx.addIssue({ code: "custom", path: ["paidAmount"], message: "Paid amount must equal salary amount" });
  }
  if (value.status === "partial" && (paidAmount <= 0 || paidAmount >= value.amount)) {
    ctx.addIssue({ code: "custom", path: ["paidAmount"], message: "Partial paid amount must be between zero and salary amount" });
  }
  if (value.status === "due" && paidAmount !== 0) {
    ctx.addIssue({ code: "custom", path: ["paidAmount"], message: "Due salary cannot have a paid amount" });
  }
  if ((value.paidAmount || 0) > value.amount) {
    ctx.addIssue({ code: "custom", path: ["paidAmount"], message: "Paid amount cannot exceed salary amount" });
  }
});

r.get("/", role("admin"), async (req, res, next) => {
  try {
    const parsedQuery = listQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "Invalid salary filters" });
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const query = parsedQuery.data;
    const filter = {};
    if (query.teacher) filter.teacher = new mongoose.Types.ObjectId(query.teacher);
    if (query.month) filter.month = query.month;
    if (query.year) filter.year = query.year;
    if (query.status) filter.status = query.status;
    if (query.q) {
      const q = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const users = await User.find({ name: { $regex: q, $options: "i" } }).select("_id");
      const teachers = await Teacher.find({
        $or: [{ employeeId: { $regex: q, $options: "i" } }, { user: { $in: users.map((user) => user._id) } }],
      }).select("_id");
      const matchingIds = teachers.map((teacher) => teacher._id);
      if (filter.teacher) {
        filter.teacher = matchingIds.some((id) => String(id) === String(filter.teacher)) ? filter.teacher : { $in: [] };
      } else {
        filter.teacher = { $in: matchingIds };
      }
    }
    const [salaries, summary] = await Promise.all([
      Salary.find(filter)
        .populate({ path: "teacher", populate: { path: "user", select: "name email" } })
        .sort({ year: -1, month: -1, createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
      Salary.aggregate([{ $match: filter }, { $group: {
        _id: null,
        total: { $sum: 1 },
        amount: { $sum: "$amount" },
        paidAmount: { $sum: "$paidAmount" },
      } }]),
    ]);
    const totals = summary[0] || { total: 0, amount: 0, paidAmount: 0 };
    const total = totals.total;
    setPaginationHeaders(res, { ...pagination, total });
    res.set({ "X-Total-Amount": String(totals.amount), "X-Total-Paid": String(totals.paidAmount) });
    res.json(salaries);
  } catch (e) { next(e); }
});

r.post("/", role("admin"), validate(schema), async (req, res, next) => {
  try {
    if (!(await Teacher.exists({ _id: req.body.teacher }))) return res.status(404).json({ error: "Teacher not found" });
    const existing = await Salary.findOne({
      teacher: req.body.teacher,
      month: req.body.month,
      year: req.body.year,
    });
    if (existing) return res.status(409).json({ error: "Salary already exists for this teacher and month" });
    const paidAmount = req.body.status === "due" ? 0 : req.body.paidAmount || 0;
    res.status(201).json(await Salary.create({ ...req.body, paidAmount }));
  } catch (e) { next(e); }
});

r.put("/:id", role("admin"), validate(schema), async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid salary id" });
    if (!(await Teacher.exists({ _id: req.body.teacher }))) return res.status(404).json({ error: "Teacher not found" });
    const duplicate = await Salary.findOne({
      teacher: req.body.teacher,
      month: req.body.month,
      year: req.body.year,
      _id: { $ne: req.params.id },
    }).select("_id");
    if (duplicate) return res.status(409).json({ error: "Salary already exists for this teacher and month" });
    const paidAmount = req.body.status === "due" ? 0 : req.body.paidAmount || 0;
    const salary = await Salary.findByIdAndUpdate(req.params.id, { ...req.body, paidAmount }, { new: true, runValidators: true });
    if (!salary) return res.status(404).json({ error: "Salary record not found" });
    res.json(salary);
  } catch (e) { next(e); }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid salary id" });
    await Salary.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
