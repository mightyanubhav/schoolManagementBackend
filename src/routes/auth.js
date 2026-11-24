import { Router } from "express";
import { z } from "zod";
import User from "../models/User.js";
import Student from "../models/Student.js";
import { sign } from "../utils/jwt.js";
import { auth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { loginRateLimit, passwordChangeRateLimit } from "../middleware/rateLimits.js";
import Teacher from "../models/Teacher.js";
import { loginPasswordSchema, passwordSchema } from "../utils/passwordValidation.js";

const r = Router();

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254).optional(),
  email: z.string().trim().min(1).max(254).optional(),
  password: loginPasswordSchema,
}).refine(({ identifier, email }) => Boolean(identifier || email), {
  path: ["identifier"],
  message: "Email, mobile number, or ID is required",
});
const changePasswordSchema = z.object({
  currentPassword: loginPasswordSchema,
  newPassword: passwordSchema,
});

r.post("/login", loginRateLimit, validate(loginSchema), async (req, res, next) => {
  try {
    const identifier = (req.body.identifier || req.body.email).trim();
    const password = req.body.password;
    const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const idPattern = new RegExp(`^${escapedIdentifier}$`, "i");
    const phoneDigits = identifier.replace(/\D/g, "");
    const phoneValues = /^\+?[\d\s().-]{7,20}$/.test(identifier) && phoneDigits.length >= 7 && phoneDigits.length <= 15
      ? [...new Set([phoneDigits, `+${phoneDigits}`])]
      : [];
    const [matchingUsers, students, teachers] = await Promise.all([
      User.find({
        $or: [
          { email: identifier.toLowerCase() },
          ...(phoneValues.length ? [{ phone: { $in: phoneValues } }] : []),
        ],
      }).select("_id"),
      Student.find({ admissionNo: idPattern }).select("user").limit(2),
      Teacher.find({ employeeId: idPattern }).select("user").limit(2),
    ]);
    const userIds = new Set([
      ...matchingUsers.map((match) => String(match._id)),
      ...students.map((match) => match.user).filter(Boolean).map(String),
      ...teachers.map((match) => match.user).filter(Boolean).map(String),
    ]);
    const users = userIds.size
      ? await User.find({ _id: { $in: [...userIds] } }).select("+password")
      : [];
    const user = users.length === 1 ? users[0] : null;
    if (!user || !user.active) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = sign({
      id: user._id,
      role: user.role,
      name: user.name,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
      tokenVersion: user.tokenVersion ?? 0,
    });
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (e) {
    next(e);
  }
});

r.get("/me", auth(), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user);
  } catch (e) {
    next(e);
  }
});

r.post("/change-password", auth(), passwordChangeRateLimit, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("+password");
    if (!user || !(await user.comparePassword(req.body.currentPassword))) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    if (req.body.currentPassword === req.body.newPassword) {
      return res.status(400).json({ error: "Choose a new password different from your current one" });
    }
    user.password = req.body.newPassword;
    user.mustChangePassword = false;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    const token = sign({
      id: user._id,
      role: user.role,
      name: user.name,
      email: user.email,
      mustChangePassword: false,
      tokenVersion: user.tokenVersion,
    });
    res.json({ ok: true, token });
  } catch (e) {
    next(e);
  }
});

export default r;