import { verify } from "../utils/jwt.js";
import User from "../models/User.js";

export function auth(required = true) {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      if (!required) return next();
      return res.status(401).json({ error: "Missing token" });
    }
    let payload;
    try {
      payload = verify(token);
    } catch {
      if (!required) return next();
      return res.status(401).json({ error: "Invalid token" });
    }

    try {
      const account = await User.findById(payload.id).select("role active mustChangePassword tokenVersion");
      if (
        !account ||
        account.active === false ||
        account.role !== payload.role ||
        (account.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0) ||
        Boolean(account.mustChangePassword) !== Boolean(payload.mustChangePassword)
      ) {
        return res.status(401).json({ error: "Invalid token" });
      }
      req.user = payload;
      const requestPath = req.originalUrl.split("?")[0];
      const allowedDuringPasswordChange = ["/api/auth/me", "/api/auth/change-password"].includes(requestPath);
      if (req.user.mustChangePassword && !allowedDuringPasswordChange) {
        return res.status(403).json({ error: "Change your temporary password before continuing", code: "PASSWORD_CHANGE_REQUIRED" });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const role = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  next();
};