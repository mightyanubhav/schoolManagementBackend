import mongoose from "mongoose";

export async function connectDB(uri) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { autoIndex: true });
  const classes = mongoose.connection.collection("classes");

  // Replace the legacy class-name-only index and one-to-one teacher assignment.
  await classes.createIndex({ name: 1, section: 1 }, { unique: true });

  const indexes = await classes.indexes();
  const legacyNameIndex = indexes.find((index) =>
    index.name === "name_1" &&
    index.unique &&
    Object.keys(index.key).length === 1 &&
    index.key.name === 1
  );
  if (legacyNameIndex) await classes.dropIndex(legacyNameIndex.name);

  await classes.updateMany(
    { classTeacher: { $exists: true } },
    { $unset: { classTeacher: "" } }
  );
  console.log("MongoDB connected");
}