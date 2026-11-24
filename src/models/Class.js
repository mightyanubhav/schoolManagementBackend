import mongoose from "mongoose";

const classSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    grade: { type: Number, required: true, min: 0, max: 20 },
    section: { type: String, default: "A", maxlength: 20 },
    room: { type: String, maxlength: 40 },
  },
  { timestamps: true }
);

classSchema.index({ name: 1, section: 1 }, { unique: true });

export default mongoose.model("Class", classSchema);