import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import mongoose from "mongoose";
import { z } from "zod";
import Teacher from "../models/Teacher.js";
import User from "../models/User.js";
import Subject from "../models/Subject.js";
import Class from "../models/Class.js";
import { auth, role } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createPrivateDownloadUrl, deletePrivateObject, uploadPrivateObject } from "../utils/cloudflareStorage.js";
import { parsePagination, setPaginationHeaders } from "../utils/pagination.js";
import { passwordSchema } from "../utils/passwordValidation.js";

const r = Router();
r.use(auth());

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record id");
const schema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, "Phone must contain 7 to 15 digits, with an optional leading +"),
  temporaryPassword: passwordSchema,
  subjects: z.array(objectId).min(1).max(100),
  classes: z.array(objectId).min(1).max(50),
  gender: z.enum(["male", "female"]),
  joinDate: z.coerce.date(),
  qualification: z.string().trim().max(200).optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, "Phone must contain 7 to 15 digits, with an optional leading +"),
  temporaryPassword: passwordSchema.optional(),
  subjects: z.array(objectId).min(1).max(100),
  classes: z.array(objectId).min(1).max(50),
  gender: z.enum(["male", "female"]),
  joinDate: z.coerce.date(),
  qualification: z.string().trim().max(200).optional(),
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
    const allowed = file.fieldname === "profileImage"
      ? allowedProfileTypes.has(file.mimetype)
      : file.fieldname === "documents" && allowedDocumentTypes.has(file.mimetype);
    callback(allowed ? null : new Error("Unsupported file type"), allowed);
  },
}).fields([
  { name: "profileImage", maxCount: 1 },
  { name: "documents", maxCount: 10 },
]);

function receiveTeacherFiles(req, res, next) {
  upload(req, res, (error) => {
    if (!error) return next();
    return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Each upload must be 5 MB or smaller" : error.message });
  });
}

function fileExtension(file) {
  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  return extensions[file.mimetype] || "bin";
}

function normalizeAssignments(req, res, next) {
  try {
    for (const [plural, singular] of [["subjects", "subject"], ["classes", "class"]]) {
      if (typeof req.body[plural] === "string") req.body[plural] = JSON.parse(req.body[plural]);
      if (!req.body[plural] && req.body[singular]) req.body[plural] = [req.body[singular]];
      if (!req.body[plural]) req.body[plural] = [];
      req.body[plural] = [...new Set(req.body[plural])];
    }
    next();
  } catch {
    res.status(400).json({ error: "Invalid class or subject selection" });
  }
}

async function validateAssignments({ subjects, classes, currentTeacherId }) {
  const [selectedClasses, selectedSubjects] = await Promise.all([
    Class.find({ _id: { $in: classes } }).select("_id"),
    Subject.find({ _id: { $in: subjects } }).select("_id class teacher"),
  ]);
  if (selectedClasses.length !== new Set(classes).size) {
    return "Select valid classes";
  }
  if (selectedSubjects.length !== new Set(subjects).size) {
    return "Select valid subjects";
  }
  const classIds = new Set(classes);
  if (selectedSubjects.some((subject) => subject.class && !classIds.has(String(subject.class)))) {
    return "Each subject must belong to one of the selected classes";
  }
  if (selectedSubjects.some((subject) => subject.teacher && String(subject.teacher) !== String(currentTeacherId || ""))) {
    return "One or more selected subjects are already assigned to another teacher";
  }
  return null;
}

r.get("/", role("admin"), async (req, res, next) => {
  try {
    const pagination = parsePagination(req, res);
    if (!pagination) return;
    const [list, total] = await Promise.all([
      Teacher.find().select("user employeeId subjects classes gender joinDate qualification documents")
        .populate("user", "name email phone avatar")
        .populate("subjects", "name code")
        .populate("classes", "name section")
        .sort({ employeeId: 1, _id: 1 }).skip(pagination.skip).limit(pagination.limit),
      Teacher.countDocuments(),
    ]);
    const response = await Promise.all(list.map(async (teacher) => {
      const item = teacher.toObject();
      item.profileImageUrl = item.user?.avatar
        ? await createPrivateDownloadUrl(item.user.avatar, { inline: true })
        : null;
      item.documents = teacher.documents.map((document) => ({
        _id: document._id,
        name: document.name,
        contentType: document.contentType,
        size: document.size,
      }));
      return item;
    }));
    setPaginationHeaders(res, { ...pagination, total });
    res.json(response);
  } catch (e) {
    next(e);
  }
});

r.post("/", role("admin"), receiveTeacherFiles, normalizeAssignments, validate(schema), async (req, res, next) => {
  let user;
  let teacher;
  const uploadedKeys = [];
  try {
    const { name, email, phone, temporaryPassword, subjects, classes, gender, joinDate, qualification } = req.body;
    const assignmentError = await validateAssignments({ subjects, classes });
    if (assignmentError) return res.status(400).json({ error: assignmentError });

    const profileImage = req.files?.profileImage?.[0];
    const documents = req.files?.documents || [];
    const teacherId = new mongoose.Types.ObjectId();
    user = await User.create({
      name,
      email,
      password: temporaryPassword,
      role: "teacher",
      phone,
      mustChangePassword: true,
    });
    teacher = await Teacher.create({
      _id: teacherId,
      user: user._id,
      employeeId: `T-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      subjects,
      classes,
      gender,
      joinDate,
      qualification,
    });

    if (profileImage) {
      const key = `teachers/${teacher._id}/profile/${crypto.randomUUID()}.${fileExtension(profileImage)}`;
      await uploadPrivateObject({ key, file: profileImage });
      uploadedKeys.push(key);
      user.avatar = key;
      await user.save();
    }

    for (const file of documents) {
      const key = `teachers/${teacher._id}/documents/${crypto.randomUUID()}.${fileExtension(file)}`;
      await uploadPrivateObject({ key, file });
      uploadedKeys.push(key);
      teacher.documents.push({ name: file.originalname, objectKey: key, contentType: file.mimetype, size: file.size });
    }
    if (documents.length) await teacher.save();

    await Subject.updateMany({ _id: { $in: subjects } }, { $set: { teacher: teacher._id } });

    const response = await Teacher.findById(teacher._id)
      .populate("user", "name email phone")
      .populate("subjects", "name code")
      .populate("classes", "name section");
    const result = response.toObject();
    result.profileImageUrl = user.avatar
      ? await createPrivateDownloadUrl(user.avatar, { inline: true })
      : null;
    result.documents = teacher.documents.map((document) => ({
      _id: document._id,
      name: document.name,
      contentType: document.contentType,
      size: document.size,
    }));
    res.status(201).json(result);
  } catch (e) {
    await Promise.allSettled(uploadedKeys.map((key) => deletePrivateObject(key)));
    if (teacher) {
      await Subject.updateMany({ teacher: teacher._id }, { $unset: { teacher: 1 } });
      await Teacher.findByIdAndDelete(teacher._id);
    }
    if (user) await User.findByIdAndDelete(user._id);
    next(e);
  }
});

r.get("/:id/documents/:documentId/download", async (req, res, next) => {
  try {
    const teacher = await Teacher.findById(req.params.id).populate("user", "_id");
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
    const isOwner = String(teacher.user._id) === req.user.id;
    if (req.user.role !== "admin" && !isOwner) return res.status(403).json({ error: "Forbidden" });
    const document = teacher.documents.id(req.params.documentId);
    if (!document) return res.status(404).json({ error: "Document not found" });
    res.json({ url: await createPrivateDownloadUrl(document.objectKey) });
  } catch (e) {
    next(e);
  }
});

r.put("/:id", role("admin"), receiveTeacherFiles, normalizeAssignments, validate(updateSchema), async (req, res, next) => {
  try {
    const teacher = await Teacher.findById(req.params.id);
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
    const assignmentError = await validateAssignments({
      subjects: req.body.subjects,
      classes: req.body.classes,
      currentTeacherId: teacher._id,
    });
    if (assignmentError) return res.status(400).json({ error: assignmentError });

    const duplicateEmail = await User.findOne({ email: req.body.email, _id: { $ne: teacher.user } }).select("_id");
    if (duplicateEmail) return res.status(409).json({ error: "Email address is already in use" });

    const user = await User.findById(teacher.user);
    if (!user) return res.status(404).json({ error: "Teacher account not found" });
    const previousAvatar = user.avatar;
    let replacedAvatar = false;
    const uploadedKeys = [];
    try {
      const profileImage = req.files?.profileImage?.[0];
      if (profileImage) {
        const key = `teachers/${teacher._id}/profile/${crypto.randomUUID()}.${fileExtension(profileImage)}`;
        await uploadPrivateObject({ key, file: profileImage });
        uploadedKeys.push(key);
        user.avatar = key;
        replacedAvatar = true;
      }

      for (const file of req.files?.documents || []) {
        const key = `teachers/${teacher._id}/documents/${crypto.randomUUID()}.${fileExtension(file)}`;
        await uploadPrivateObject({ key, file });
        uploadedKeys.push(key);
        teacher.documents.push({ name: file.originalname, objectKey: key, contentType: file.mimetype, size: file.size });
      }

      user.name = req.body.name;
      user.email = req.body.email;
      user.phone = req.body.phone;
      if (req.body.temporaryPassword) {
        user.password = req.body.temporaryPassword;
        user.mustChangePassword = true;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
      }
      await user.save();

      teacher.subjects = req.body.subjects;
      teacher.classes = req.body.classes;
      teacher.gender = req.body.gender;
      teacher.joinDate = req.body.joinDate;
      teacher.qualification = req.body.qualification;
      await teacher.save();

      await Subject.updateMany({ teacher: teacher._id, _id: { $nin: req.body.subjects } }, { $unset: { teacher: 1 } });
      await Subject.updateMany({ _id: { $in: req.body.subjects } }, { $set: { teacher: teacher._id } });
      if (replacedAvatar && previousAvatar) await Promise.allSettled([deletePrivateObject(previousAvatar)]);

      const response = await Teacher.findById(teacher._id)
        .populate("user", "name email phone")
        .populate("subjects", "name code")
        .populate("classes", "name section");
      const result = response.toObject();
      result.profileImageUrl = user.avatar ? await createPrivateDownloadUrl(user.avatar, { inline: true }) : null;
      result.documents = teacher.documents.map((document) => ({
        _id: document._id,
        name: document.name,
        contentType: document.contentType,
        size: document.size,
      }));
      res.json(result);
    } catch (e) {
      await Promise.allSettled(uploadedKeys.map((key) => deletePrivateObject(key)));
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

r.delete("/:id", role("admin"), async (req, res, next) => {
  try {
    const t = await Teacher.findByIdAndDelete(req.params.id);
    if (t) {
      const user = await User.findById(t.user);
      await Subject.updateMany({ teacher: t._id }, { $unset: { teacher: 1 } });
      await Promise.allSettled([
        ...t.documents.map((document) => deletePrivateObject(document.objectKey)),
        ...(user?.avatar ? [deletePrivateObject(user.avatar)] : []),
      ]);
      await User.findByIdAndDelete(t.user);
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default r;