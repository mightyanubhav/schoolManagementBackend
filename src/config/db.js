
import mongoose from "mongoose";

export async function connectDB(uri) {
  if (!uri) {
    throw new Error("MONGO_URI is missing");
  }

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri, {
    autoIndex: false,
    maxPoolSize: 10,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10000,
  });

  console.log("MongoDB connected successfully");
}
