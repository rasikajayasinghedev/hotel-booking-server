import mongoose from "mongoose";

const MONGO_URI = `mongodb+srv://rasikajayasinghe87:q5J4kdRsM2CVveoU@hotel-booking.n5vwrxk.mongodb.net/myDatabase?retryWrites=true&w=majority`;
if (!MONGO_URI) throw new Error("MONGO_URI is not defined in env");

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function dbConnect() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }).then(mongoose => mongoose);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

export default dbConnect;
