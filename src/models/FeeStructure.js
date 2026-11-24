import mongoose from "mongoose";

const feeStructureSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, unique: true },
    admissionFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    securityDeposit: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    schoolFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    registrationFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    examinationFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    computerEducationFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    tieBelt: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    idCard: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    schoolDiary: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    classPicnic: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    schoolTrip: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    lateFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    shoesSocks: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    books: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    dressFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    monthlyFee: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
  },
  { timestamps: true }
);

export default mongoose.model("FeeStructure", feeStructureSchema);
