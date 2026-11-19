// Tiny JSON-file store used ONLY while MongoDB is unreachable, so an enquiry is never lost and the website never shows an error.
// When MongoDB connects, anything waiting here is moved into MongoDB automatically (see flushPending in server.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const file = path.join(dir, "pending-enquiries.json");

const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } };
const write = (rows) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(rows, null, 2)); };

export const fileStore = {
  list: () => read().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  add(doc) {
    const now = new Date().toISOString();
    const row = { _id: `local_${crypto.randomUUID()}`, status: "new", ...doc, createdAt: now, updatedAt: now };
    write([row, ...read()]); return row;
  },
  setStatus(id, status) {
    const rows = read(); const row = rows.find((r) => r._id === id);
    if (!row) return null; row.status = status; row.updatedAt = new Date().toISOString(); write(rows); return row;
  },
  take() { const rows = read(); if (rows.length) write([]); return rows; },
  restore(rows) { if (rows.length) write([...rows, ...read()]); },
};
