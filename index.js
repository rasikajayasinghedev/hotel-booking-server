import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import dbConnect from "./lib/db";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const ORIGIN = process.env.ORIGIN || "http://localhost:5173";

app.use(cors({ origin: ORIGIN || '*', credentials: true }));
app.use(express.json());

await dbConnect();
console.log("✅ MongoDB connected");

// ---- MongoDB Connect ----
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ---- Schemas ----
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  passwordHash: String,
  createdAt: String
});

const roomSchema = new mongoose.Schema({
  name: String,
  description: String,
  pricePerNight: Number,
  capacity: Number,
  image: String
});

const bookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: "Room" },
  checkIn: String,
  checkOut: String,
  fullName: String,
  email: String,
  phone: String,
  specialRequests: String,
  status: String,
  createdAt: String
});

const User = mongoose.model("User", userSchema);
const Room = mongoose.model("Room", roomSchema);
const Booking = mongoose.model("Booking", bookingSchema);

// ---- Seed rooms if none ----
(async () => {
  const count = await Room.countDocuments();
  if (count === 0) {
    await Room.insertMany([
      {
        name: "Standard Room",
        description: "Cozy room with queen bed, city view, workstation.",
        pricePerNight: 79,
        capacity: 2,
        image: "https://images.unsplash.com/photo-1560066984-138dadb4c035?q=80&w=1200&auto=format&fit=crop"
      },
      {
        name: "Deluxe Room",
        description: "Spacious room with king bed, balcony, partial sea view.",
        pricePerNight: 129,
        capacity: 3,
        image: "https://images.unsplash.com/photo-1584132967334-10e028bd69f7?q=80&w=1200&auto=format&fit=crop"
      },
      {
        name: "Family Suite",
        description: "Two-bedroom suite with lounge, perfect for families.",
        pricePerNight: 199,
        capacity: 5,
        image: "https://images.unsplash.com/photo-1600585154526-990dced4db0d?q=80&w=1200&auto=format&fit=crop"
      }
    ]);
    console.log("✅ Seeded rooms collection.");
  }
})();

// ---- Helpers ----
function issueToken(user) {
  return jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return !(aEnd <= bStart || bEnd <= aStart);
}

// ---- Routes ----

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Auth
app.post("/api/register", async (req, res) => {
  try {
    await dbConnect(); // ensure connection

    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ error: "Missing fields" });

    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();
    const user = await User.create({ name, email, passwordHash, createdAt });

    const token = issueToken(user);
    res.json({ user: { id: user._id, name, email }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid email or password" });

    const token = issueToken(user);
    res.json({ user: { id: user._id, name: user.name, email: user.email }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rooms search
app.get("/api/rooms/search", async (req, res) => {
  const { checkIn, checkOut, guests } = req.query;
  if (!checkIn || !checkOut) return res.status(400).json({ error: "checkIn & checkOut required" });

  const g = parseInt(guests || "1", 10);
  const rooms = await Room.find({ capacity: { $gte: g } });
  const bookings = await Booking.find({ status: "confirmed" });

  const available = rooms.filter(room => {
    const roomBookings = bookings.filter(b => b.roomId.toString() === room._id.toString());
    const overlapping = roomBookings.some(b => datesOverlap(checkIn, checkOut, b.checkIn, b.checkOut));
    return !overlapping;
  });

  res.json({ rooms: available });
});

// Create booking
app.post("/api/bookings", auth, async (req, res) => {
  try {
    const { roomId, checkIn, checkOut, fullName, email, phone, specialRequests } = req.body || {};
    if (!roomId || !checkIn || !checkOut || !fullName || !email || !phone) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const overlapping = await Booking.findOne({
      roomId,
      status: "confirmed",
      $nor: [
        { checkIn: { $gte: checkOut } },
        { checkOut: { $lte: checkIn } }
      ]
    });
    if (overlapping) return res.status(409).json({ error: "Room no longer available for those dates" });

    const createdAt = new Date().toISOString();
    const booking = await Booking.create({
      userId: req.user.id,
      roomId,
      checkIn,
      checkOut,
      fullName,
      email,
      phone,
      specialRequests: specialRequests || "",
      status: "confirmed",
      createdAt
    });

    res.json({ booking, room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List bookings for dashboard
app.get("/api/bookings", auth, async (req, res) => {
  const list = await Booking.find({ userId: req.user.id })
    .populate("roomId", "name pricePerNight")
    .sort({ checkIn: -1 });

  res.json({ bookings: list.map(b => ({
    ...b.toObject(),
    roomName: b.roomId?.name,
    pricePerNight: b.roomId?.pricePerNight
  })) });
});

// Cancel booking
app.patch("/api/bookings/:id/cancel", auth, async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking || booking.userId.toString() !== req.user.id) {
    return res.status(404).json({ error: "Booking not found" });
  }
  if (booking.status !== "confirmed") return res.status(400).json({ error: "Cannot cancel this booking" });

  const nowISO = new Date().toISOString().slice(0, 10);
  if (booking.checkIn <= nowISO) return res.status(400).json({ error: "Cannot cancel past or ongoing stays" });

  booking.status = "cancelled";
  await booking.save();
  res.json({ ok: true });
});

// ---- Start Server ----
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
