import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { connectDB } from "./config/db.js";
import { notFound, errorHandler } from "./middleware/error.js";
import authRouter from "./routes/auth.js";
import studentsRouter from "./routes/students.js";
import teachersRouter from "./routes/teachers.js";
import classesRouter from "./routes/classes.js";
import subjectsRouter from "./routes/subjects.js";
import attendanceRouter from "./routes/attendance.js";
import examsRouter from "./routes/exams.js";
import feesRouter from "./routes/fees.js";
import salariesRouter from "./routes/salaries.js";
import announcementsRouter from "./routes/announcements.js";
import timetableRouter from "./routes/timetable.js";
import reportsRouter from "./routes/reports.js";
import { bootstrap } from "./seed.js";

const app = express();
const isProd = process.env.NODE_ENV === "production" || process.env.DEPLOYMENT === "true";
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (isProd) {
  const missing = ["MONGO_URI", "JWT_SECRET", "CLIENT_ORIGIN"]
    .filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  if (!allowedOrigins.length) throw new Error("CLIENT_ORIGIN must contain at least one production origin");
  if (process.env.JWT_SECRET.length < 32 || /change_me|replace|example/i.test(process.env.JWT_SECRET)) {
    throw new Error("JWT_SECRET must be a unique secret of at least 32 characters in production");
  }
  if (allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== "https:" || parsed.origin !== origin;
    } catch {
      return true;
    }
  })) {
    throw new Error("CLIENT_ORIGIN must contain valid HTTPS origins in production");
  }
}

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
  exposedHeaders: ["X-Total-Count", "X-Page", "X-Page-Size", "X-Page-Count", "X-People-Count", "X-Total-Amount", "X-Total-Paid", "X-Total-Pending"],
}));
app.use(express.json({ limit: "2mb" }));
app.use(
  rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false })
);
if (!isProd) app.use(morgan("dev"));

if (isProd) app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.use("/api/auth", authRouter);
app.use("/api/students", studentsRouter);
app.use("/api/teachers", teachersRouter);
app.use("/api/classes", classesRouter);
app.use("/api/subjects", subjectsRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/exams", examsRouter);
app.use("/api/fees", feesRouter);
app.use("/api/salaries", salariesRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/timetable", timetableRouter);
app.use("/api/reports", reportsRouter);

app.use(notFound);
app.use(errorHandler);

const port = process.env.PORT || 4000;
connectDB(process.env.MONGO_URI)
  .then(bootstrap)
  .then(() => app.listen(port, () => console.log(`API listening on port ${port}`)))
  .catch((e) => {
    console.error("Startup failure", e);
    process.exit(1);
  });