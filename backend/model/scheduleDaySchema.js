const mongoose = require('mongoose');

const scheduleDaySchema = new mongoose.Schema({
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true, index: true },
  date: { type: Date, required: true },
  topicIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Topic' }],
  completed: { type: Boolean, default: false },
});

module.exports = mongoose.model('ScheduleDay', scheduleDaySchema);
