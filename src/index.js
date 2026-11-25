
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

const isProd =
  process.env.NODE_ENV === "production" ||
  process.env.DEPLOYMENT === "true";

const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Production configuration validation
if (isProd) {
  const requiredEnv = [
    "MONGO_URI",
    "JWT_SECRET",
    "CLIENT_ORIGIN",
  ];

  const missing = requiredEnv.filter(
    (key) => !process.env[key]?.trim()
  );

  if (missing.length) {
    throw new Error(
      `Missing production environment variables: ${missing.join(", ")}`
    );
  }

  if (process.env.JWT_SECRET.length < 32) {
    throw new Error(
      "JWT_SECRET must be at least 32 characters long"
    );
  }

  if (/change_me|replace|example/i.test(process.env.JWT_SECRET)) {
    throw new Error(
      "Please configure a real production JWT_SECRET for production"
    );
  }

  for (const origin of allowedOrigins) {
    try {
      const parsed = new URL(origin);

      if (
        parsed.protocol !== "https:" ||
        parsed.origin !== origin
      ) {
        throw new Error();
      }
    } catch {
      throw new Error(
        `Invalid CLIENT_ORIGIN: ${origin}. Use an exact HTTPS origin without a trailing slash.`
      );
    }
  }

  if (allowedOrigins.length === 0) {
    throw new Error(
      "CLIENT_ORIGIN must contain at least one allowed HTTPS origin"
    );
  }
}

// Security & performance middleware
app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
);

app.use(compression());

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without an Origin header (server-to-server, health checks)
      if (!origin) {
        return callback(null, true);
      }

      // Development mode
      if (!isProd) {
        return callback(null, true);
      }

      // Production: exact allowlist
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    exposedHeaders: [
      "X-Total-Count",
      "X-Page",
      "X-Page-Size",
      "X-Page-Count",
      "X-People-Count",
      "X-Total-Amount",
      "X-Total-Paid",
      "X-Total-Pending",
    ],
  })
);

app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Development logging only
if (!isProd) {
  app.use(morgan("dev"));
}

// Health endpoint
app.get("/health", (_, res) => {
  res.status(200).json({
    ok: true,
    status: "healthy",
    timestamp: Date.now(),
  });
});

// API routes
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

// Error handling
app.use(notFound);
app.use(errorHandler);

// Cloud Run injects PORT automatically
const port = process.env.PORT || 4000;

// Startup
async function startServer() {
  try {
    await connectDB(process.env.MONGO_URI);

    // IMPORTANT:
    // Review seed.js before enabling production bootstrap.
    // This function must be safe to run repeatedly.
    await bootstrap();

    app.listen(port, "0.0.0.0", () => {
      console.log(`API running on port ${port}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
