import mongoose from "mongoose";

const studentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    admissionNo: { type: String, required: true, unique: true, trim: true, maxlength: 50 },
    class: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
    section: { type: String, trim: true, default: "A" },
    rollNo: { type: String, maxlength: 20 },
    fatherName: { type: String, maxlength: 100 },
    motherName: { type: String, maxlength: 100 },
    caste: { type: String, maxlength: 80 },
    aadhaarNumber: { type: String, trim: true, match: [/^$|^\d{12}$/, "Aadhaar number must contain exactly 12 digits"] },
    dob: Date,
    admissionDate: Date,
    gender: { type: String, enum: ["male", "female", "other"] },
    address: { type: String, maxlength: 500 },
    documents: [{
      name: { type: String, required: true },
      objectKey: { type: String, required: true },
      contentType: { type: String, required: true },
      size: { type: Number, required: true },
    }],
    guardian: {
      name: String,
      phone: String,
      email: String,
      relation: String,
    },
    parentUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

studentSchema.index({ class: 1, rollNo: 1 });

export default mongoose.model("Student", studentSchema);