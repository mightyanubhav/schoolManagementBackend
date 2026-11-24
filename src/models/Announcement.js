import mongoose from "mongoose";

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    audience: {
      type: String,
      enum: ["all", "students", "parents", "teachers", "staff"],
      default: "all",
    },
    class: { type: mongoose.Schema.Types.ObjectId, ref: "Class", default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

announcementSchema.index({ audience: 1, pinned: -1, createdAt: -1 });
announcementSchema.index({ class: 1, pinned: -1, createdAt: -1 });

export default mongoose.model("Announcement", announcementSchema);