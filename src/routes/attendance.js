import { Router } from "express";
import { z } from "zod";
import Attendance from "../models/Attendance.js";
import TeacherAttendance from "../models/TeacherAttendance.js";
import Student from "../models/Student.js";
import Teacher from "../models/Teacher.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";
import { reportRateLimit } from "../middleware/rateLimits.js";

const r = Router();
r.use(auth());

async function getTeacher(req) {
  return Teacher.findOne({ user: req.user.id }).select("classes");
}

function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const bulkSchema = z.object({
  class: z.string().regex(/^[a-f\d]{24}$/i),
  date: z.coerce.date(),
  entries: z.array(
    z.object({
      student: z.string().regex(/^[a-f\d]{24}$/i),
      status: z.enum(["present", "absent", "late", "leave"]),
    }).strict()
  ).max(500),
});

r.get("/", role("admin", "teacher", "student"), async (req, res, next) => {
  try {
    const { class: cls, date, student } = req.query;
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const filter = {};
    if (cls && (typeof cls !== "string" || !/^[a-f\d]{24}$/i.test(cls))) return res.status(400).json({ error: "Invalid class id" });
    if (student && (typeof student !== "string" || !/^[a-f\d]{24}$/i.test(student))) return res.status(400).json({ error: "Invalid student id" });
    if (date && !isValidDateOnly(date)) return res.status(400).json({ error: "Invalid attendance date" });
    if (cls) filter.class = cls;
    if (student) filter.student = student;
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      filter.date = { $gte: d, $lt: next };
    }
    if (req.user.role === "student") {
      const studentRecord = await Student.findOne({ user: req.user.id }).select("_id");
      if (!studentRecord) {
        setPaginationHeaders(res, { ...pagination, total: 0 });
        return res.json([]);
      }
      filter.student = studentRecord._id;
    } else if (req.user.role === "teacher") {
      const teacher = await getTeacher(req);
      const classIds = teacher?.classes || [];
      if (cls && !classIds.some((id) => String(id) === String(cls))) {
        return res.status(403).json({ error: "You can only view attendance for your assigned classes" });
      }
      filter.class = cls || { $in: classIds };
    }
    const [records, total] = await Promise.all([
      Attendance.find(filter).select("student class date status")
        .populate({ path: "student", select: "rollNo admissionNo user", populate: { path: "user", select: "name" } })
        .populate("class", "name section")
        .sort({ date: -1, _id: -1 }).skip(pagination.skip).limit(pagination.limit),
      Attendance.countDocuments(filter),
    ]);
    setPaginationHeaders(res, { ...pagination, total });
    res.json(records);
  } catch (e) { next(e); }
});

r.get("/me", role("student"), async (req, res, next) => {
  try {
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const student = await Student.findOne({ user: req.user.id })
      .select("admissionNo rollNo class user")
      .populate("user", "name")
      .populate("class", "name section");
    if (!student) return res.status(404).json({ error: "Student record not found" });

    const filter = { student: student._id };
    if (req.query.from || req.query.to) {
      if ((req.query.from && !isValidDateOnly(req.query.from)) || (req.query.to && !isValidDateOnly(req.query.to))) {
        return res.status(400).json({ error: "Invalid attendance date" });
      }
      const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : null;
      const to = req.query.to ? new Date(`${req.query.to}T00:00:00`) : null;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
        return res.status(400).json({ error: "Invalid attendance date" });
      }
      if (from && to && from > to) {
        return res.status(400).json({ error: "Start date must not be after end date" });
      }
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) {
        const until = new Date(to);
        until.setDate(until.getDate() + 1);
        filter.date.$lt = until;
      }
    }
    const [records, summaryRows, total] = await Promise.all([
      Attendance.find(filter).select("date status class").sort({ date: -1, _id: -1 })
        .skip(pagination.skip).limit(pagination.limit),
      Attendance.aggregate([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Attendance.countDocuments(filter),
    ]);
    const statusCounts = { present: 0, absent: 0, late: 0, leave: 0 };
    for (const row of summaryRows) statusCounts[row._id] = row.count;
    setPaginationHeaders(res, { ...pagination, total });
    res.json({
      student,
      records,
      summary: {
        total,
        ...statusCounts,
        attendanceRate: total ? Math.round(((statusCounts.present + statusCounts.late) / total) * 1000) / 10 : 0,
      },
    });
  } catch (e) { next(e); }
});

r.post("/bulk", role("admin", "teacher"), validate(bulkSchema), async (req, res, next) => {
  try {
    const { class: cls, date, entries } = req.body;
    if (req.user.role === "teacher") {
      const teacher = await getTeacher(req);
      if (!teacher?.classes.some((id) => String(id) === String(cls))) {
        return res.status(403).json({ error: "You can only mark attendance for your assigned classes" });
      }
    }
    const studentIds = entries.map((entry) => entry.student);
    if (new Set(studentIds).size !== studentIds.length) {
      return res.status(400).json({ error: "Each student can only be recorded once" });
    }
    const roster = await Student.find({ class: cls, _id: { $in: studentIds } }).distinct("_id");
    if (roster.length !== studentIds.length) {
      return res.status(400).json({ error: "Attendance entries must belong to the selected class" });
    }
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    const ops = entries.map((e) => ({
      updateOne: {
        filter: { student: e.student, date: d },
        update: {
          $set: {
            class: cls,
            status: e.status,
            markedBy: req.user.id,
            date: d,
          },
        },
        upsert: true,
      },
    }));
    await Attendance.bulkWrite(ops);
    res.json({ ok: true, count: entries.length });
  } catch (e) { next(e); }
});

const teacherBulkSchema = z.object({
  date: z.coerce.date(),
  entries: z.array(
    z.object({
      teacher: z.string().regex(/^[a-f\d]{24}$/i),
      status: z.enum(["present", "absent", "late", "leave"]),
    }).strict()
  ).max(500),
});

r.get("/teachers", role("admin"), async (req, res, next) => {
  try {
    if (req.query.date && !isValidDateOnly(req.query.date)) return res.status(400).json({ error: "Invalid attendance date" });
    const d = new Date(req.query.date || new Date());
    d.setHours(0, 0, 0, 0);
    const next = new Date(d); next.setDate(d.getDate() + 1);
    const teachers = await Teacher.find().select("user employeeId").populate("user", "name email");
    const existing = await TeacherAttendance.find({
      date: { $gte: d, $lt: next },
    });
    const map = new Map(existing.map((a) => [String(a.teacher), a.status]));
    res.json(
      teachers.map((t) => ({
        _id: t._id,
        name: t.user?.name,
        email: t.user?.email,
        employeeId: t.employeeId,
        status: map.get(String(t._id)) || "present",
      }))
    );
  } catch (e) { next(e); }
});

r.post("/teachers/bulk", role("admin"), validate(teacherBulkSchema), async (req, res, next) => {
  try {
    const teacherIds = req.body.entries.map((entry) => entry.teacher);
    if (new Set(teacherIds).size !== teacherIds.length) return res.status(400).json({ error: "Each teacher can only be recorded once" });
    const validTeachers = await Teacher.find({ _id: { $in: teacherIds } }).distinct("_id");
    if (validTeachers.length !== teacherIds.length) return res.status(400).json({ error: "Attendance entries must reference existing teachers" });
    const d = new Date(req.body.date); d.setHours(0, 0, 0, 0);
    const ops = req.body.entries.map((e) => ({
      updateOne: {
        filter: { teacher: e.teacher, date: d },
        update: {
          $set: {
            status: e.status,
            markedBy: req.user.id,
            date: d,
          },
        },
        upsert: true,
      },
    }));
    await TeacherAttendance.bulkWrite(ops);
    res.json({ ok: true, count: req.body.entries.length });
  } catch (e) { next(e); }
});

r.get("/report", role("admin", "teacher"), reportRateLimit, async (req, res, next) => {
  try {
    const type = req.query.type || "students";
    if (!["students", "teachers"].includes(type)) {
      return res.status(400).json({ error: "Report type must be students or teachers" });
    }
    if (type === "teachers" && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only administrators can view teacher attendance reports" });
    }
    const validStatuses = ["present", "absent", "late", "leave"];
    if (req.query.status && !validStatuses.includes(req.query.status)) {
      return res.status(400).json({ error: "Invalid attendance status" });
    }
    if (req.query.class && (typeof req.query.class !== "string" || !/^[a-f\d]{24}$/i.test(req.query.class))) {
      return res.status(400).json({ error: "Invalid class id" });
    }
    if (req.query.q != null && (typeof req.query.q !== "string" || req.query.q.length > 100)) {
      return res.status(400).json({ error: "Search must be 100 characters or fewer" });
    }
    if ((req.query.from && !isValidDateOnly(req.query.from)) || (req.query.to && !isValidDateOnly(req.query.to))) {
      return res.status(400).json({ error: "Invalid attendance report date" });
    }
    const recordPagination = parsePagination(req, res);
    if (!recordPagination) return;
    const peoplePagination = parsePagination({
      query: {
        page: req.query.peoplePage,
        limit: req.query.peopleLimit ?? 25,
      },
    }, res);
    if (!peoplePagination) return;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (type === "students" && req.query.class) filter.class = req.query.class;
    if (type === "students" && req.user.role === "teacher") {
      const teacher = await getTeacher(req);
      const classIds = teacher?.classes || [];
      if (req.query.class && !classIds.some((id) => String(id) === String(req.query.class))) {
        return res.status(403).json({ error: "You can only report on your assigned classes" });
      }
      filter.class = req.query.class || { $in: classIds };
    }
    if (req.query.from || req.query.to) {
      const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : null;
      const to = req.query.to ? new Date(`${req.query.to}T00:00:00`) : null;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
        return res.status(400).json({ error: "Invalid attendance report date" });
      }
      if (from && to && from > to) {
        return res.status(400).json({ error: "Start date must not be after end date" });
      }
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) {
        const until = new Date(to);
        until.setDate(until.getDate() + 1);
        filter.date.$lt = until;
      }
    }

    let records;
    if (type === "teachers") {
      const attendance = await TeacherAttendance.find(filter)
        .populate({ path: "teacher", populate: { path: "user", select: "name email" } })
        .sort({ date: -1 });
      records = attendance.map((item) => ({
        _id: item._id,
        personId: item.teacher?._id,
        name: item.teacher?.user?.name || "Unknown teacher",
        identifier: item.teacher?.employeeId || "",
        className: "—",
        email: item.teacher?.user?.email || "",
        status: item.status,
        date: item.date,
      }));
    } else {
      const attendance = await Attendance.find(filter)
        .populate({ path: "student", populate: { path: "user", select: "name" } })
        .populate("class", "name section")
        .sort({ date: -1 });
      records = attendance.map((item) => ({
        _id: item._id,
        personId: item.student?._id,
        name: item.student?.user?.name || "Unknown student",
        identifier: item.student?.rollNo || item.student?.admissionNo || "",
        admissionNo: item.student?.admissionNo || "",
        className: item.class ? `${item.class.name} · Section ${item.class.section || "A"}` : "—",
        status: item.status,
        date: item.date,
      }));
    }

    const query = String(req.query.q || "").trim().toLowerCase();
    if (query) {
      records = records.filter((record) =>
        [record.name, record.identifier, record.admissionNo, record.className, record.email]
          .some((value) => value?.toLowerCase().includes(query))
      );
    }

    const statusCounts = { present: 0, absent: 0, late: 0, leave: 0 };
    const peopleMap = new Map();
    for (const record of records) {
      statusCounts[record.status] += 1;
      const id = String(record.personId || record._id);
      const person = peopleMap.get(id) || {
        personId: id,
        name: record.name,
        identifier: record.identifier,
        className: record.className,
        daysRecorded: 0,
        ...Object.fromEntries(validStatuses.map((status) => [status, 0])),
      };
      person.daysRecorded += 1;
      person[record.status] += 1;
      peopleMap.set(id, person);
    }
    const people = [...peopleMap.values()].map((person) => ({
      ...person,
      attendanceRate: person.daysRecorded
        ? Math.round(((person.present + person.late) / person.daysRecorded) * 1000) / 10
        : 0,
    })).sort((a, b) => a.name.localeCompare(b.name));

    setPaginationHeaders(res, { ...recordPagination, total: records.length });
    res.set({ "X-People-Count": String(people.length) });
    res.json({
      type,
      summary: { totalRecords: records.length, ...statusCounts, peopleCount: people.length },
      people: people.slice(peoplePagination.skip, peoplePagination.skip + peoplePagination.limit),
      records: records.slice(recordPagination.skip, recordPagination.skip + recordPagination.limit),
    });
  } catch (e) { next(e); }
});

r.get("/class-today/:classId", role("admin", "teacher"), async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.classId)) return res.status(400).json({ error: "Invalid class id" });
    if (req.user.role === "teacher") {
      const teacher = await getTeacher(req);
      if (!teacher?.classes.some((id) => String(id) === req.params.classId)) {
        return res.status(403).json({ error: "You can only view attendance for your assigned classes" });
      }
    }
    if (req.query.date && !isValidDateOnly(req.query.date)) return res.status(400).json({ error: "Invalid attendance date" });
    const d = new Date(req.query.date || new Date()); d.setHours(0, 0, 0, 0);
    const next = new Date(d); next.setDate(d.getDate() + 1);
    const students = await Student.find({ class: req.params.classId }).select("rollNo user").populate("user", "name");
    const existing = await Attendance.find({
      class: req.params.classId,
      date: { $gte: d, $lt: next },
    }).select("student status");
    const map = new Map(existing.map((a) => [String(a.student), a.status]));
    res.json(
      students.map((s) => ({
        _id: s._id,
        name: s.user?.name,
        rollNo: s.rollNo,
        status: map.get(String(s._id)) || "present",
      }))
    );
  } catch (e) { next(e); }
});

export default r;