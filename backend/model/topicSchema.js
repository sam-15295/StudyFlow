const mongoose = require('mongoose');

const topicSchema = new mongoose.Schema({
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true, index: true },
  name: { type: String, required: true, trim: true },
  difficulty: { type: Number, min: 1, max: 5, default: null },
  estHours: { type: Number, min: 0, default: null },
  status: { type: String, enum: ['pending', 'done', 'missed'], default: 'pending' },
});

module.exports = mongoose.model('Topic', topicSchema);
