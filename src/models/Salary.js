import mongoose from "mongoose";

const salarySchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    amount: { type: Number, required: true, min: 0, max: 1_000_000_000 },
    paidAmount: { type: Number, required: true, min: 0, max: 1_000_000_000, default: 0 },
    status: {
      type: String,
      enum: ["paid", "partial", "due"],
      required: true,
      default: "due",
    },
    paidDate: Date,
    remarks: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

salarySchema.index({ teacher: 1, month: 1, year: 1 }, { unique: true });
salarySchema.index({ year: -1, month: -1, createdAt: -1 });

export default mongoose.model("Salary", salarySchema);
