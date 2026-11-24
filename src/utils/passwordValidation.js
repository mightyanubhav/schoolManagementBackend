import { z } from "zod";

export const passwordSchema = z.string()
  .min(8)
  .max(128)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must not exceed 72 UTF-8 bytes");

export const loginPasswordSchema = z.string()
  .min(1)
  .max(128)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must not exceed 72 UTF-8 bytes");
