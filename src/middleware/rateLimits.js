import rateLimit from "express-rate-limit";

const jsonRateLimit = (max, windowMs) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests. Please try again later." }),
});

export const loginRateLimit = jsonRateLimit(10, 15 * 60 * 1000);
export const passwordChangeRateLimit = jsonRateLimit(5, 15 * 60 * 1000);
export const reportRateLimit = jsonRateLimit(10, 60 * 1000);
