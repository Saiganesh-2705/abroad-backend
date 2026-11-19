import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Enquiry from "./models/Enquiry.js";

// Always read backend/.env, whichever folder you start the server from.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });

const { MONGODB_URI, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, CLIENT_URL = "" } = process.env;
const PORT = Number(process.env.PORT) || 5000;
for (const [k, v] of Object.entries({ MONGODB_URI, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD }))
  if (!v) console.warn(`[config] ${k} is missing in backend/.env`);

mongoose.set("bufferCommands", false); // fail fast instead of hanging when the DB is down
const dbReady = () => mongoose.connection.readyState === 1;

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const allowed = CLIENT_URL.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, server-to-server
    const o = origin.replace(/\/$/, "");
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
    cb(null, local || allowed.includes(o));
  },
}));
app.use(express.json({ limit: "50kb" }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { message: "Too many requests. Please try again later." } });
const needDb = (_req, res, next) => (dbReady() ? next() : res.status(503).json({ message: "Service is starting up. Please try again in a moment or call us." }));
const auth = (req, res, next) => {
  try {
    if (!JWT_SECRET) throw new Error("no secret");
    jwt.verify((req.headers.authorization || "").replace(/^Bearer /, ""), JWT_SECRET);
    next();
  } catch { res.status(401).json({ message: "Not authorized" }); }
};

app.get("/", (_req, res) => res.json({ service: "Algebra Studies Abroad API", ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true, db: dbReady() ? "connected" : "disconnected" }));

app.post("/api/enquiries", limiter, needDb, async (req, res, next) => {
  try {
    const clean = (v, n) => String(v ?? "").trim().slice(0, n);
    const name = clean(req.body.name, 120), phone = clean(req.body.phone, 20), email = clean(req.body.email, 120);
    if (!name || !phone) return res.status(400).json({ message: "Name and mobile number are required" });
    if (!/^[+\d][\d\s-]{6,18}$/.test(phone)) return res.status(400).json({ message: "Please enter a valid mobile number" });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email address" });
    await Enquiry.create({ name, phone, email, course: clean(req.body.course, 40), country: clean(req.body.country, 40), message: clean(req.body.message, 1500) });
    res.status(201).json({ message: "Thanks! We will call you within one working day." });
  } catch (e) { next(e); }
});

app.post("/api/admin/login", limiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!JWT_SECRET || !ADMIN_EMAIL || !ADMIN_PASSWORD) return res.status(500).json({ message: "Admin login is not configured on the server" });
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD)
    return res.json({ token: jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "7d" }) });
  res.status(401).json({ message: "Wrong email or password" });
});

app.get("/api/enquiries", auth, needDb, async (_req, res, next) => {
  try { res.json(await Enquiry.find().sort({ createdAt: -1 }).limit(500)); } catch (e) { next(e); }
});
app.patch("/api/enquiries/:id", auth, needDb, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!["new", "contacted", "closed"].includes(status)) return res.status(400).json({ message: "Invalid status" });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Enquiry.findByIdAndUpdate(req.params.id, { status }, { new: true });
    doc ? res.json(doc) : res.status(404).json({ message: "Enquiry not found" });
  } catch (e) { next(e); }
});

app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));
app.use((e, _req, res, _next) => { console.error("[error]", e.message); res.status(500).json({ message: "Something went wrong. Please try again." }); });

// Start the web server first, then keep trying the database, so the API never crashes on a slow or failed connection.
app.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`));

async function connect() {
  if (!MONGODB_URI) return console.error("[db] MONGODB_URI is missing in backend/.env");
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    console.log("[db] connected");
  } catch (e) {
    console.error("[db] connection failed:", e.message);
    if (/querySrv|ENOTFOUND|ECONNREFUSED/.test(e.message)) console.error("[db] DNS/network issue: try another network or DNS (8.8.8.8), or use Atlas's non-SRV 'mongodb://' connection string.");
    else if (/whitelist|IP|not authorized|Authentication/i.test(e.message)) console.error("[db] In Atlas: Network Access -> allow your IP (or 0.0.0.0/0 for testing), and check the database user and password.");
    setTimeout(connect, 10000);
  }
}
connect();
