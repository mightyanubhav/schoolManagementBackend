export const notFound = (req, res) => res.status(404).json({ error: "Not found" });

export const errorHandler = (err, req, res, next) => {
  const isProduction = process.env.NODE_ENV === "production" || process.env.DEPLOYMENT === "true";
  if (err.name === "ZodError") {
    return res.status(400).json({ error: "Validation failed", details: err.issues || err.errors });
  }
  if (err.code === 11000) {
    return res.status(409).json({ error: "Duplicate key", key: Object.keys(err.keyPattern) });
  }
  if (err.name === "CastError") return res.status(400).json({ error: "Invalid value" });
  if (err.name === "ValidationError") {
    return res.status(400).json({
      error: "Validation failed",
      details: Object.values(err.errors).map(({ path, message }) => ({ path, message })),
    });
  }
  const status = err.status || 500;
  if (isProduction) console.error({ name: err.name, status, message: status >= 500 ? "Unhandled server error" : err.message });
  else console.error(err);
  res.status(status).json({ error: isProduction && status >= 500 ? "Server error" : err.message || "Server error" });
};