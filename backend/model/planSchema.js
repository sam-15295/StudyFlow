const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  examDate: { type: Date, required: true },
  dailyHours: { type: Number, required: true, min: 0.25, max: 24 },
  syllabusRaw: { type: String, required: true },
  status: { type: String, enum: ['draft', 'active', 'completed'], default: 'draft' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Plan', planSchema);
