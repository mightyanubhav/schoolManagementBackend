import mongoose from "mongoose";

const slotSchema = new mongoose.Schema({
  day: { type: String, enum: ["Mon","Tue","Wed","Thu","Fri","Sat"], required: true },
  start: String,
  end: String,
  subject: { type: mongoose.Schema.Types.ObjectId, ref: "Subject" },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher" },
  room: String,
});

const timetableSchema = new mongoose.Schema(
  {
    class: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true, unique: true },
    slots: [slotSchema],
    reviewDueDate: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model("Timetable", timetableSchema);
