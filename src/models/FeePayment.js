import mongoose from "mongoose";

const feePaymentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    type: { type: String, enum: ["one-time", "monthly"], required: true },
    month: { type: Number, min: 1, max: 12 },
    year: { type: Number, min: 2000, max: 2100 },
    totalFee: { type: Number, required: true, min: 0, max: 1_000_000_000 },
    paidAmount: { type: Number, required: true, min: 0, max: 1_000_000_000 },
    dueAmount: { type: Number, required: true, min: 0, max: 1_000_000_000 },
    items: [{ name: String, amount: Number }],
    receiptNo: { type: String, required: true, unique: true },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    paidAt: { type: Date, required: true, default: Date.now },
    remarks: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

feePaymentSchema.index({ student: 1, type: 1, year: 1, month: 1 });
feePaymentSchema.index({ student: 1, paidAt: -1 });

export default mongoose.model("FeePayment", feePaymentSchema);
