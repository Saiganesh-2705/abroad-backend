import path from "node:path";
import dns from "node:dns";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Enquiry from "./models/Enquiry.js";
import { fileStore } from "./fileStore.js";
import { prepareUri, explain } from "./dbConfig.js";

// Always read backend/.env, whichever folder you start the server from.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });
dns.setDefaultResultOrder("ipv4first"); // avoids many IPv6 related Atlas timeouts

const { MONGODB_URI, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, CLIENT_URL = "" } = process.env;
const PORT = Number(process.env.PORT) || 5000;
for (const [k, v] of Object.entries({ JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD }))
  if (!v) console.warn(`[config] ${k} is missing in backend/.env`);

mongoose.set("bufferCommands", false); // fail fast instead of hanging when the DB is down
const dbReady = () => mongoose.connection.readyState === 1;

// Nothing below may ever crash the process.
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || e));
mongoose.connection.on("error", (e) => console.error("[db] error:", e.message));
mongoose.connection.on("disconnected", () => console.warn("[db] disconnected, will reconnect"));

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const allowed = CLIENT_URL.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, server-to-server
    const o = origin.replace(/\/$/, "");
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
    const vercelPreview = allowed.length > 0 && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(o) && allowed.some((a) => a.endsWith(".vercel.app"));
    cb(null, local || allowed.includes(o) || vercelPreview);
  },
}));
app.use(express.json({ limit: "50kb" }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { message: "Too many requests. Please try again later." } });
const auth = (req, res, next) => {
  try {
    if (!JWT_SECRET) throw new Error("no secret");
    jwt.verify((req.headers.authorization || "").replace(/^Bearer /, ""), JWT_SECRET);
    next();
  } catch { res.status(401).json({ message: "Not authorized" }); }
};

app.get("/", (_req, res) => res.json({ service: "Algebra Studies Abroad API", ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true, db: dbReady() ? "connected" : "disconnected", storage: dbReady() ? "mongodb" : "local-file (synced to MongoDB once it connects)", pending: dbReady() ? 0 : fileStore.list().length }));

// Public form: always succeeds for a valid enquiry. Saved to MongoDB when connected, otherwise safely queued on disk.
app.post("/api/enquiries", limiter, async (req, res, next) => {
  try {
    const clean = (v, n) => String(v ?? "").trim().slice(0, n);
    const name = clean(req.body.name, 120), phone = clean(req.body.phone, 20), email = clean(req.body.email, 120);
    if (!name || !phone) return res.status(400).json({ message: "Name and mobile number are required" });
    if (!/^[+\d][\d\s-]{6,18}$/.test(phone)) return res.status(400).json({ message: "Please enter a valid mobile number" });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email address" });
    const doc = { name, phone, email, course: clean(req.body.course, 40), country: clean(req.body.country, 40), message: clean(req.body.message, 1500) };
    if (dbReady()) {
      try { await Enquiry.create(doc); }
      catch (e) { console.error("[db] save failed, queued locally:", e.message); fileStore.add(doc); }
    } else fileStore.add(doc);
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

app.get("/api/enquiries", auth, async (_req, res, next) => {
  try {
    const queued = fileStore.list();
    const saved = dbReady() ? await Enquiry.find().sort({ createdAt: -1 }).limit(500).lean() : [];
    res.json([...queued, ...saved].sort((a, b) => (new Date(b.createdAt) - new Date(a.createdAt))));
  } catch (e) { next(e); }
});
app.patch("/api/enquiries/:id", auth, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!["new", "contacted", "closed"].includes(status)) return res.status(400).json({ message: "Invalid status" });
    const { id } = req.params;
    if (id.startsWith("local_")) { const row = fileStore.setStatus(id, status); return row ? res.json(row) : res.status(404).json({ message: "Enquiry not found" }); }
    if (!dbReady()) return res.status(503).json({ message: "Database is reconnecting. Please try again in a moment." });
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Enquiry.findByIdAndUpdate(id, { status }, { new: true });
    doc ? res.json(doc) : res.status(404).json({ message: "Enquiry not found" });
  } catch (e) { next(e); }
});

app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));
app.use((e, _req, res, _next) => { console.error("[error]", e.message); res.status(500).json({ message: "Something went wrong. Please try again." }); });

// Start the web server first, then keep trying the database, so the API never crashes on a slow or failed connection.
app.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`));

// Move enquiries queued while the DB was down into MongoDB.
async function flushPending() {
  const rows = fileStore.take();
  if (!rows.length) return;
  try {
    await Enquiry.insertMany(rows.map(({ _id, ...r }) => ({ ...r, createdAt: new Date(r.createdAt) })), { timestamps: false });
    console.log(`[db] synced ${rows.length} queued enquiries into MongoDB`);
  } catch (e) { fileStore.restore(rows); console.error("[db] could not sync queued enquiries yet:", e.message); }
}

const { uri, problem } = prepareUri(MONGODB_URI);
let delay = 5000, triedPublicDns = false, announced = false;
async function connect() {
  if (problem) {
    if (!announced) console.error(`[db] ${problem}\n[db] The website keeps working: enquiries are saved to backend/data and move into MongoDB once it connects.`);
    announced = true; return; // config problem: retrying cannot help, restart after fixing .env
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, family: 4, maxPoolSize: 10 });
    console.log("[db] connected to MongoDB");
    delay = 5000; await flushPending();
  } catch (e) {
    console.error("[db] connection failed:", e.message);
    const hint = explain(e.message); if (hint) console.error("[db] ->", hint);
    if (/querySrv|ENOTFOUND|ECONNREFUSED|ETIMEOUT/.test(e.message) && !triedPublicDns) {
      triedPublicDns = true; dns.setServers(["8.8.8.8", "1.1.1.1"]); console.error("[db] retrying with public DNS (8.8.8.8, 1.1.1.1)…");
      return setTimeout(connect, 500);
    }
    setTimeout(connect, delay); delay = Math.min(delay * 2, 60000);
  }
}
connect();
