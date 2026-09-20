const mongoose = require('mongoose');

const scheduleDaySchema = new mongoose.Schema({
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true, index: true },
  date: { type: Date, required: true },
  topicIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Topic' }],
  // Hours planned for each topic on this day (a long topic is split over several days).
  slots: [
    {
      _id: false,
      topicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true },
      hours: { type: Number, required: true, min: 0 },
    },
  ],
  completed: { type: Boolean, default: false },
});

module.exports = mongoose.model('ScheduleDay', scheduleDaySchema);
