import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { connectDB } from "./config/db.js";
import Announcement from "./models/Announcement.js";
import Attendance from "./models/Attendance.js";
import Class from "./models/Class.js";
import Exam from "./models/Exam.js";
import Fee from "./models/Fee.js";
import FeePayment from "./models/FeePayment.js";
import FeeStructure from "./models/FeeStructure.js";
import Salary from "./models/Salary.js";
import Student from "./models/Student.js";
import Subject from "./models/Subject.js";
import Teacher from "./models/Teacher.js";
import TeacherAttendance from "./models/TeacherAttendance.js";
import Timetable from "./models/Timetable.js";
import User from "./models/User.js";

const demoAccountEmails = [
  "admin@school.local",
  ...Array.from({ length: 3 }, (_, index) => `teacher${index + 1}@school.local`),
  ...Array.from({ length: 15 }, (_, index) => `student${index + 1}@school.local`),
];
const demoClassNames = ["Grade 5A", "Grade 5B", "Grade 6A"];
const demoSubjectCodes = ["MATH5", "ENG5", "SCI5", "MATH5A", "ENG5A", "SCI5A", "MATH5B", "ENG5B", "SCI5B"];

function assertTestPassword(password) {
  if (!password || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("TEST=true requires TEST_PASSWORD to be at least 12 characters and no more than 72 UTF-8 bytes");
  }
}

async function createAdmin(email, password, name = "School Administrator", phone) {
  return User.create({
    name,
    email,
    password,
    ...(phone && { phone }),
    role: "admin",
    mustChangePassword: true,
  });
}

function recentSchoolDays(count) {
  const days = [];
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  while (days.length < count) {
    if (day.getDay() !== 0 && day.getDay() !== 6) days.push(new Date(day));
    day.setDate(day.getDate() - 1);
  }
  return days;
}

async function seedDemo() {
  const testPassword = process.env.TEST_PASSWORD;
  assertTestPassword(testPassword);

  const admin = await createAdmin("admin@school.local", testPassword, "Demo Admin", "+15550100000");

  const classSpecs = [
    { name: "Grade 5A", grade: 5, section: "A", room: "101" },
    { name: "Grade 5B", grade: 5, section: "B", room: "102" },
    { name: "Grade 6A", grade: 6, section: "A", room: "201" },
  ];
  const classes = await Promise.all(classSpecs.map(({ name, ...details }) =>
    Class.findOneAndUpdate(
      { name },
      { $set: { ...details, name } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    )
  ));
  const [grade5a, grade5b, grade6a] = classes;

  const teacherSpecs = [
    {
      name: "Alice Smith",
      email: "teacher1@school.local",
      phone: "+15550101001",
      employeeId: "T1000",
      gender: "female",
      qualification: "M.Ed",
      classes: [grade5a._id, grade5b._id],
    },
  ];
  const teachers = [];
  for (const [index, spec] of teacherSpecs.entries()) {
    const user = await User.create({
      name: spec.name,
      email: spec.email,
      phone: spec.phone,
      password: testPassword,
      role: "teacher",
    });
    const teacher = await Teacher.create({
      user: user._id,
      employeeId: spec.employeeId,
      gender: spec.gender,
      qualification: spec.qualification,
      joinDate: new Date(new Date().getFullYear() - index - 2, 7, 1),
      salary: 45000 + index * 5000,
      classes: spec.classes,
    });
    teachers.push(teacher);
  }

  const subjectSpecs = [
    { name: "Mathematics", code: "MATH5A", class: grade5a, teacher: teachers[0] },
    { name: "English", code: "ENG5A", class: grade5a, teacher: teachers[0] },
    { name: "Science", code: "SCI5A", class: grade5a, teacher: teachers[0] },
    { name: "Mathematics", code: "MATH5B", class: grade5b, teacher: teachers[0] },
    { name: "English", code: "ENG5B", class: grade5b, teacher: teachers[0] },
    { name: "Science", code: "SCI5B", class: grade5b, teacher: teachers[0] },
  ];
  const subjects = await Subject.create(subjectSpecs.map(({ name, code, class: schoolClass, teacher }) => ({
    name,
    code,
    class: schoolClass._id,
    teacher: teacher._id,
  })));

  const subjectByCode = new Map(subjects.map((subject) => [subject.code, subject]));
  teachers[0].subjects = subjects.map((subject) => subject._id);
  await teachers[0].save();

  const rosterByClass = new Map(classes.map((schoolClass) => [String(schoolClass._id), []]));
  const students = [];
  for (let index = 0; index < 1; index += 1) {
    const schoolClass = grade5a;
    const studentNumber = index + 1;
    const user = await User.create({
      name: "Aarav Sharma",
      email: `student${studentNumber}@school.local`,
      phone: `+15550102${String(studentNumber).padStart(3, "0")}`,
      password: testPassword,
      role: "student",
    });
    const student = await Student.create({
      user: user._id,
      admissionNo: `A${2024000 + index}`,
      class: schoolClass._id,
      section: schoolClass.section,
      rollNo: String((index % 5) + 1),
      fatherName: `Parent ${studentNumber}`,
      motherName: `Guardian ${studentNumber}`,
      dob: new Date(2014, index % 12, (index % 27) + 1),
      admissionDate: new Date(new Date().getFullYear() - 1, 3, 1),
      gender: index % 2 ? "male" : "female",
      address: `Demo residence ${studentNumber}, School District`,
      guardian: {
        name: `Parent ${studentNumber}`,
        phone: `+15550103${String(studentNumber).padStart(3, "0")}`,
        relation: "Parent",
      },
    });
    students.push(student);
    rosterByClass.get(String(schoolClass._id)).push(student);
  }

  const attendanceDates = recentSchoolDays(5);
  await Attendance.create(students.flatMap((student, studentIndex) =>
    attendanceDates.map((date, dateIndex) => ({
      student: student._id,
      class: student.class,
      date,
      status: (studentIndex + dateIndex) % 13 === 0
        ? "absent"
        : (studentIndex + dateIndex) % 9 === 0 ? "late" : "present",
      markedBy: admin._id,
    }))
  ));
  await TeacherAttendance.create(teachers.flatMap((teacher, teacherIndex) =>
    attendanceDates.map((date, dateIndex) => ({
      teacher: teacher._id,
      date,
      status: (teacherIndex + dateIndex) % 11 === 0 ? "leave" : "present",
      markedBy: admin._id,
    }))
  ));

  const timetableData = [
    { class: grade5a, codes: ["MATH5A", "ENG5A", "SCI5A"] },
    { class: grade5b, codes: ["MATH5B", "ENG5B", "SCI5B"] },
  ];
  await Timetable.create(timetableData.map(({ class: schoolClass, codes }) => ({
    class: schoolClass._id,
    slots: ["Mon", "Tue", "Wed", "Thu", "Fri"].flatMap((day) =>
      codes.map((code, index) => ({
        day,
        start: `${String(9 + index * 2).padStart(2, "0")}:00`,
        end: `${String(10 + index * 2).padStart(2, "0")}:00`,
        subject: subjectByCode.get(code)._id,
        teacher: subjectByCode.get(code).teacher,
        room: schoolClass.room,
      }))
    ),
  })));

  const currentDate = new Date();
  const currentMonth = currentDate.getMonth() + 1;
  const currentYear = currentDate.getFullYear();
  const structures = students.map((student, index) => ({
    student: student._id,
    admissionFee: 5000,
    schoolFee: 10000,
    examinationFee: 1000,
    books: 1500,
    monthlyFee: 3000 + (index % 3) * 250,
  }));
  await FeeStructure.create(structures);
  await FeePayment.create(students.flatMap((student, index) => {
    const oneTimeTotal = 17500;
    const oneTimePaid = index % 4 === 0 ? oneTimeTotal : 5000;
    const monthlyFee = structures[index].monthlyFee;
    const monthlyPaid = index % 3 === 0 ? monthlyFee : Math.floor(monthlyFee / 2);
    return [
      {
        student: student._id,
        type: "one-time",
        totalFee: oneTimeTotal,
        paidAmount: oneTimePaid,
        dueAmount: oneTimeTotal - oneTimePaid,
        items: [
          { name: "Admission Fee", amount: 5000 },
          { name: "School Fee", amount: 10000 },
          { name: "Examination Fee", amount: 1000 },
          { name: "Books", amount: 1500 },
        ],
        receiptNo: `DEMO-${student.admissionNo}-ONETIME`,
        receivedBy: admin._id,
        paidAt: new Date(currentYear, currentMonth - 1, Math.max(1, currentDate.getDate() - 10)),
      },
      {
        student: student._id,
        type: "monthly",
        month: currentMonth,
        year: currentYear,
        totalFee: monthlyFee,
        paidAmount: monthlyPaid,
        dueAmount: monthlyFee - monthlyPaid,
        items: [{ name: `Monthly Fee - ${currentMonth}/${currentYear}`, amount: monthlyFee }],
        receiptNo: `DEMO-${student.admissionNo}-MONTHLY`,
        receivedBy: admin._id,
        paidAt: new Date(currentYear, currentMonth - 1, Math.max(1, currentDate.getDate() - 3)),
      },
    ];
  }));

  await Fee.create(students.map((student, index) => ({
    student: student._id,
    title: "Demo tuition Baalance",
    amount: 500,
    dueDate: new Date(currentYear, currentMonth - 1, currentDate.getDate() + 14),
    status: index % 3 === 0 ? "paid" : "pending",
    ...(index % 3 === 0 && { paidDate: new Date() }),
    method: index % 3 === 0 ? "upi" : undefined,
  })));

  await Salary.create(teachers.map((teacher, index) => ({
    teacher: teacher._id,
    month: currentMonth,
    year: currentYear,
    amount: teacher.salary,
    paidAmount: index === 0 ? teacher.salary : index === 1 ? Math.floor(teacher.salary / 2) : 0,
    status: index === 0 ? "paid" : index === 1 ? "partial" : "due",
    ...(index === 0 && { paidDate: new Date() }),
    remarks: "Demo payroll record",
  })));

  const examDate = new Date(currentYear, currentMonth - 1, Math.max(1, currentDate.getDate() - 7));
  const classStudents = rosterByClass.get(String(grade5a._id));
  await Exam.create({
    name: "Term Assessment",
    term: "Term 1",
    class: grade5a._id,
    subject: subjectByCode.get("MATH5A")._id,
    date: examDate,
    maxMarks: 100,
    passMarks: 35,
    status: "published",
    publishedAt: new Date(),
    marks: classStudents.map((student) => ({
      student: student._id,
      marks: 82,
      maxMarks: 100,
      attendance: "present",
    })),
  });

  await Announcement.create([
    {
      title: "Welcome to the new term",
      body: "Check your class timetable and review the latest school updates.",
      audience: "all",
      postedBy: admin._id,
      pinned: true,
    },
    {
      title: "Grade 5A class update",
      body: "Your class timetable and Term 1 assessment results are now available.",
      audience: "students",
      class: grade5a._id,
      postedBy: admin._id,
    },
    {
      title: "Grade 6A class update",
      body: "Please review your class timetable and upcoming learning activities.",
      audience: "students",
      class: grade6a._id,
      postedBy: admin._id,
    },
  ]);

  console.log("Seeded demo data for admin, teacher, and student accounts.");
}

async function removePreviousDemoSeed() {
  const users = await User.find({ email: { $in: demoAccountEmails } }).select("_id");
  const userIds = users.map((user) => user._id);
  const [students, teachers, legacyClasses] = await Promise.all([
    Student.find({ user: { $in: userIds } }).select("_id class"),
    Teacher.find({ user: { $in: userIds } }).select("_id classes"),
    Class.find({ name: { $in: demoClassNames } }).select("_id"),
  ]);
  const studentIds = students.map((student) => student._id);
  const teacherIds = teachers.map((teacher) => teacher._id);
  const classIds = [...new Set([
    ...legacyClasses.map((schoolClass) => String(schoolClass._id)),
    ...students.map((student) => String(student.class)),
    ...teachers.flatMap((teacher) => teacher.classes.map(String)),
  ])];
  const subjectIds = await Subject.find({
    $or: [
      { code: { $in: demoSubjectCodes } },
      { teacher: { $in: teacherIds } },
    ],
  }).distinct("_id");

  await Promise.all([
    Attendance.deleteMany({ student: { $in: studentIds } }),
    TeacherAttendance.deleteMany({ teacher: { $in: teacherIds } }),
    Fee.deleteMany({ student: { $in: studentIds } }),
    FeeStructure.deleteMany({ student: { $in: studentIds } }),
    FeePayment.deleteMany({ student: { $in: studentIds } }),
    Salary.deleteMany({ teacher: { $in: teacherIds } }),
    Timetable.deleteMany({ class: { $in: classIds } }),
    Exam.deleteMany({ $or: [{ class: { $in: classIds } }, { subject: { $in: subjectIds } }] }),
    Announcement.deleteMany({ postedBy: { $in: userIds } }),
    Subject.deleteMany({ _id: { $in: subjectIds } }),
  ]);
  await Promise.all([
    Student.deleteMany({ _id: { $in: studentIds } }),
    Teacher.deleteMany({ _id: { $in: teacherIds } }),
    User.deleteMany({ _id: { $in: userIds } }),
  ]);
}

export async function bootstrap() {
  const isProduction = process.env.NODE_ENV === "production" || process.env.DEPLOYMENT === "true";
  if (isProduction && process.env.TEST === "true") {
    throw new Error("TEST=true is not allowed in production");
  }

  const userCount = await User.estimatedDocumentCount();
  if (userCount > 0) return;
  if (process.env.TEST === "true") {
    assertTestPassword(process.env.TEST_PASSWORD);
    await seedDemo();
    return;
  }

  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("An empty database requires a valid INITIAL_ADMIN_EMAIL");
  }
  if (!password || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("INITIAL_ADMIN_PASSWORD must be between 12 characters and 72 UTF-8 bytes");
  }
  await createAdmin(email, password, process.env.INITIAL_ADMIN_NAME?.trim() || "School Administrator");
  console.log("Created the initial administrator account. Change its password after first login.");
}

async function runDemoSeedReset() {
  const isProduction = process.env.NODE_ENV === "production" || process.env.DEPLOYMENT === "true";
  if (isProduction || process.env.TEST !== "true") {
    throw new Error("Seed reset requires TEST=true and is disabled in production");
  }
  const resetEntireDatabase = process.env.RESET_ENTIRE_DATABASE === "true";
  if (!resetEntireDatabase && process.env.RESET_DEMO_SEED !== "true") {
    throw new Error("Set RESET_DEMO_SEED=true or RESET_ENTIRE_DATABASE=true to explicitly reset seed data");
  }
  if (!process.env.MONGO_URI?.trim()) throw new Error("MONGO_URI is required to reset demo seed data");
  assertTestPassword(process.env.TEST_PASSWORD);

  await connectDB(process.env.MONGO_URI);
  if (resetEntireDatabase) {
    if (["admin", "local", "config"].includes(mongoose.connection.name)) {
      throw new Error("Refusing to drop a MongoDB system database");
    }
    await mongoose.connection.dropDatabase();
  } else {
    await removePreviousDemoSeed();
  }
  await seedDemo();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemoSeedReset()
    .catch((error) => {
      console.error("Seed reset failed:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
}
