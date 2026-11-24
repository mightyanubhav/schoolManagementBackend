import mongoose from "mongoose";

const teacherSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    employeeId: { type: String, required: true, unique: true },
    subjects: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
    classes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Class" }],
    gender: { type: String, enum: ["male", "female"] },
    documents: [{
      name: { type: String, required: true },
      objectKey: { type: String, required: true },
      contentType: { type: String, required: true },
      size: { type: Number, required: true },
    }],
    qualification: String,
    joinDate: Date,
    salary: Number,
  },
  { timestamps: true }
);

export default mongoose.model("Teacher", teacherSchema);