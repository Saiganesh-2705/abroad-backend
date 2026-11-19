import mongoose from "mongoose";
const s = (max) => ({ type: String, trim: true, maxlength: max, default: "" });
const schema = new mongoose.Schema(
  {
    name: { ...s(120), required: true },
    phone: { ...s(20), required: true },
    email: s(120), course: s(40), country: s(40), message: s(1500),
    status: { type: String, enum: ["new", "contacted", "closed"], default: "new" },
  },
  { timestamps: true }
);
export default mongoose.model("Enquiry", schema);
