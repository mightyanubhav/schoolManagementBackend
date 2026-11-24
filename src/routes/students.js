import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import Class from "../models/Class.js";
import Student from "../models/Student.js";
import Teacher from "../models/Teacher.js";
import User from "../models/User.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createPrivateDownloadUrl, deletePrivateObject, uploadPrivateObject } from "../utils/cloudflareStorage.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";
import { passwordSchema } from "../utils/passwordValidation.js";

const r = Router();
r.use(auth());

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