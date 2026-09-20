const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set');
  }
  // Fail fast (default is 30s) so a dead/unreachable MongoDB shows up as a clear error.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log(`MongoDB connected: ${mongoose.connection.name}`);
}

module.exports = connectDB;
