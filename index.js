
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const ORIGIN = process.env.ORIGIN || "http://localhost:5173";
const DB_FILE = process.env.DB_FILE || "hotel.db";

app.use(cors({ origin: ORIGIN || '*', credentials: true }));
app.use(express.json());

// ---- DB INIT ----
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  pricePerNight REAL NOT NULL,
  capacity INTEGER NOT NULL,
  image TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL,
  roomId INTEGER NOT NULL,
  checkIn TEXT NOT NULL,
  checkOut TEXT NOT NULL,
  fullName TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  specialRequests TEXT,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id),
  FOREIGN KEY (roomId) REFERENCES rooms(id)
);
`);

// Seed rooms if none
const roomCount = db.prepare("SELECT COUNT(*) as c FROM rooms").get().c;
if (roomCount === 0) {
  const seed = db.prepare(`INSERT INTO rooms (name, description, pricePerNight, capacity, image)
    VALUES (?, ?, ?, ?, ?)`);
  seed.run("Standard Room", "Cozy room with queen bed, city view, workstation.", 79, 2, "https://images.unsplash.com/photo-1560066984-138dadb4c035?q=80&w=1200&auto=format&fit=crop");
  seed.run("Deluxe Room", "Spacious room with king bed, balcony, partial sea view.", 129, 3, "https://images.unsplash.com/photo-1584132967334-10e028bd69f7?q=80&w=1200&auto=format&fit=crop");
  seed.run("Family Suite", "Two-bedroom suite with lounge, perfect for families.", 199, 5, "https://images.unsplash.com/photo-1600585154526-990dced4db0d?q=80&w=1200&auto=format&fit=crop");
  console.log("Seeded rooms table.");
}

// ---- Helpers ----
function issueToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
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
  // Each is ISO yyyy-mm-dd
  return !(aEnd <= bStart || bEnd <= aStart);
}

// ---- Routes ----

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Auth
app.post("/api/register", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = bcrypt.hashSync(password, 10);
  const createdAt = new Date().toISOString();
  const result = db.prepare("INSERT INTO users (name, email, passwordHash, createdAt) VALUES (?, ?, ?, ?)")
    .run(name, email, passwordHash, createdAt);
  const user = { id: result.lastInsertRowid, name, email };
  const token = issueToken(user);
  res.json({ user, token });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });
  const token = issueToken(user);
  res.json({ user: { id: user.id, name: user.name, email: user.email }, token });
});

// Rooms search
app.get("/api/rooms/search", (req, res) => {
  const { checkIn, checkOut, guests } = req.query;
  if (!checkIn || !checkOut) return res.status(400).json({ error: "checkIn & checkOut required" });
  const g = parseInt(guests || "1", 10);

  const rooms = db.prepare("SELECT * FROM rooms WHERE capacity >= ?").all(g);
  const bookings = db.prepare("SELECT * FROM bookings WHERE status = 'confirmed'").all();

  const available = rooms.filter(room => {
    const roomBookings = bookings.filter(b => b.roomId === room.id);
    const overlapping = roomBookings.some(b => datesOverlap(checkIn, checkOut, b.checkIn, b.checkOut));
    return !overlapping;
  });

  res.json({ rooms: available });
});

// Create booking (requires auth)
app.post("/api/bookings", auth, (req, res) => {
  const { roomId, checkIn, checkOut, fullName, email, phone, specialRequests } = req.body || {};
  if (!roomId || !checkIn || !checkOut || !fullName || !email || !phone) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Availability check
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const overlapping = db.prepare(`
    SELECT COUNT(*) as c FROM bookings
    WHERE roomId = ? AND status = 'confirmed'
      AND NOT (? <= checkIn OR checkOut <= ?)
  `).get(roomId, checkIn, checkOut).c > 0;
  if (overlapping) return res.status(409).json({ error: "Room no longer available for those dates" });

  const createdAt = new Date().toISOString();
  const status = "confirmed";
  const result = db.prepare(`
    INSERT INTO bookings (userId, roomId, checkIn, checkOut, fullName, email, phone, specialRequests, status, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, roomId, checkIn, checkOut, fullName, email, phone, specialRequests || "", status, createdAt);

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(result.lastInsertRowid);
  res.json({ booking, room });
});

// List bookings for dashboard
app.get("/api/bookings", auth, (req, res) => {
  const list = db.prepare(`
    SELECT b.*, r.name as roomName, r.pricePerNight
    FROM bookings
    JOIN rooms r ON r.id = b.roomId
    WHERE b.userId = ?
    ORDER BY b.checkIn DESC
  `).all(req.user.id);
  res.json({ bookings: list });
});

// Cancel booking (future only)
app.patch("/api/bookings/:id/cancel", auth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
  if (!booking || booking.userId !== req.user.id) return res.status(404).json({ error: "Booking not found" });
  if (booking.status !== "confirmed") return res.status(400).json({ error: "Cannot cancel this booking" });
  const nowISO = new Date().toISOString().slice(0,10);
  if (booking.checkIn <= nowISO) return res.status(400).json({ error: "Cannot cancel past or ongoing stays" });
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
