import { z } from "zod";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export function parsePagination(req, res, defaultLimit = 25) {
  const parsed = querySchema.safeParse({
    page: req.query.page,
    limit: req.query.limit ?? defaultLimit,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Page must be positive and limit must be between 1 and 100" });
    return null;
  }
  const { page, limit } = parsed.data;
  return { page, limit, skip: (page - 1) * limit };
}

export function setPaginationHeaders(res, { page, limit, total }) {
  res.set({
    "X-Total-Count": String(total),
    "X-Page": String(page),
    "X-Page-Size": String(limit),
    "X-Page-Count": String(Math.max(1, Math.ceil(total / limit))),
  });
}
