import mongoose from "mongoose";

const feeSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 0, max: 1_000_000_000 },
    dueDate: Date,
    paidDate: Date,
    status: { type: String, enum: ["pending", "paid", "partial"], default: "pending" },
    method: { type: String, enum: ["cash", "card", "bank", "upi"] },
    remarks: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

export default mongoose.model("Fee", feeSchema);