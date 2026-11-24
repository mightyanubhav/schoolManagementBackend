import mongoose from "mongoose";

const markSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
  marks: { type: Number, required: true },
  maxMarks: { type: Number, default: 100 },
  attendance: { type: String, enum: ["present", "absent"], default: "present" },
});

const examSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    term: String,
    class: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: "Subject", required: true },
    date: Date,
    maxMarks: { type: Number, required: true, min: 0, default: 100 },
    passMarks: { type: Number, required: true, min: 0, default: 33 },
    marks: [markSchema],
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    publishedAt: Date,
  },
  { timestamps: true }
);

export default mongoose.model("Exam", examSchema);