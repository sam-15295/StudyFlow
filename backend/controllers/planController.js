const mongoose = require('mongoose');
const Plan = require('../model/planSchema');
const Topic = require('../model/topicSchema');
const ScheduleDay = require('../model/scheduleDaySchema');
const { extractTopics } = require('../service/agents/extractorAgent');
const { estimateTopics } = require('../service/agents/estimatorAgent');
const { scheduleTopics, startOfUtcDay } = require('../service/agents/scheduler');
const { explainReplan, fallbackExplanation } = require('../service/agents/replanExplainer');
const { decideReplan, replanRemaining, syncDayCompletion } = require('../service/replan');
const { LlmError } = require('../service/llm');

const MAX_SYLLABUS_CHARS = 20000;
const PREVIEW_CHARS = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// examDate is a plain calendar date ("YYYY-MM-DD"), stored as UTC midnight.
function parseExamDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

async function createPlan(req, res) {
  const { syllabusRaw, examDate, dailyHours } = req.body || {};

  if (typeof syllabusRaw !== 'string' || !syllabusRaw.trim()) {
    return res.status(400).json({ error: 'syllabusRaw is required' });
  }
  if (syllabusRaw.length > MAX_SYLLABUS_CHARS) {
    return res.status(400).json({ error: `syllabusRaw must be at most ${MAX_SYLLABUS_CHARS} characters` });
  }
  const exam = parseExamDate(examDate);
  if (!exam) {
    return res.status(400).json({ error: 'examDate must be a valid date in YYYY-MM-DD format' });
  }
  if (exam <= todayUtc()) {
    return res.status(400).json({ error: 'examDate must be in the future' });
  }
  if (typeof dailyHours !== 'number' || !Number.isFinite(dailyHours) || dailyHours < 0.25 || dailyHours > 24) {
    return res.status(400).json({ error: 'dailyHours must be a number between 0.25 and 24' });
  }

  const plan = await Plan.create({
    userId: req.user.id,
    examDate: exam,
    dailyHours,
    syllabusRaw: syllabusRaw.trim(),
  });
  return res.status(201).json({ plan });
}

async function listPlans(req, res) {
  const plans = await Plan.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
  const summaries = plans.map(({ syllabusRaw, ...rest }) => ({
    ...rest,
    syllabusPreview: syllabusRaw.slice(0, PREVIEW_CHARS),
  }));
  return res.json({ plans: summaries });
}

async function getPlan(req, res) {
  const [topics, scheduleDays] = await Promise.all([
    Topic.find({ planId: req.plan._id }).sort({ _id: 1 }).lean(),
    ScheduleDay.find({ planId: req.plan._id }).sort({ date: 1 }).lean(),
  ]);
  return res.json({
    plan: { ...req.plan.toObject(), topics, scheduleDays, unscheduledTopicIds: findUnscheduled(topics, scheduleDays) },
  });
}

// Topics still to do whose planned hours don't add up to their estimate (i.e. they didn't fit before the exam).
// Only meaningful once a schedule exists.
function findUnscheduled(topics, scheduleDays) {
  if (scheduleDays.length === 0) return [];
  const planned = new Map();
  for (const day of scheduleDays) {
    for (const slot of day.slots || []) {
      const key = slot.topicId.toString();
      planned.set(key, (planned.get(key) || 0) + slot.hours);
    }
  }
  return topics
    .filter((t) => t.status !== 'done' && t.estHours != null)
    .filter((t) => (planned.get(t._id.toString()) || 0) < t.estHours - 1e-6)
    .map((t) => t._id);
}

async function deletePlan(req, res) {
  await Promise.all([
    Topic.deleteMany({ planId: req.plan._id }),
    ScheduleDay.deleteMany({ planId: req.plan._id }),
  ]);
  await req.plan.deleteOne();
  return res.json({ message: 'Plan deleted' });
}

// Runs the Topic Extractor Agent. Re-running replaces the plan's topics (and its now-stale schedule).
async function extractPlanTopics(req, res) {
  const names = await extractTopics(req.plan.syllabusRaw);
  if (names.length === 0) {
    return res.status(422).json({
      error: 'No study topics could be found in the syllabus. Try pasting more detailed text.',
    });
  }

  // Only touch existing data once the LLM call has succeeded, so a failure never loses topics.
  await Promise.all([
    Topic.deleteMany({ planId: req.plan._id }),
    ScheduleDay.deleteMany({ planId: req.plan._id }),
  ]);
  const topics = await Topic.insertMany(names.map((name) => ({ planId: req.plan._id, name })));
  if (req.plan.status !== 'draft') {
    req.plan.status = 'draft';
    await req.plan.save();
  }
  return res.json({ topics });
}

// Runs the Difficulty Estimator Agent over the plan's topics (one batched LLM call).
async function estimatePlanTopics(req, res) {
  const topics = await Topic.find({ planId: req.plan._id }).sort({ _id: 1 });
  if (topics.length === 0) {
    return res.status(400).json({ error: 'This plan has no topics yet. Extract topics first.' });
  }

  const estimates = await estimateTopics(topics.map((t) => t.name)); // same order as `topics`
  await Topic.bulkWrite(
    topics.map((topic, i) => ({
      updateOne: {
        filter: { _id: topic._id },
        update: { $set: { difficulty: estimates[i].difficulty, estHours: estimates[i].estHours } },
      },
    }))
  );

  // New estimates make any existing schedule stale, so drop it and go back to draft.
  await ScheduleDay.deleteMany({ planId: req.plan._id });
  if (req.plan.status !== 'draft') {
    req.plan.status = 'draft';
    await req.plan.save();
  }

  const updated = await Topic.find({ planId: req.plan._id }).sort({ _id: 1 });
  return res.json({ topics: updated });
}

// Runs the deterministic scheduler (no LLM) over the plan's not-yet-done topics and saves the days.
async function generatePlanSchedule(req, res) {
  const topics = await Topic.find({ planId: req.plan._id }).sort({ _id: 1 });
  if (topics.length === 0) {
    return res.status(400).json({ error: 'This plan has no topics yet. Extract topics first.' });
  }
  const todo = topics.filter((t) => t.status !== 'done');
  if (todo.length === 0) {
    return res.status(400).json({ error: 'All topics are already done. Nothing to schedule.' });
  }
  if (todo.some((t) => t.difficulty == null || t.estHours == null)) {
    return res.status(400).json({ error: 'Some topics have no estimate yet. Estimate difficulty first.' });
  }

  let result;
  try {
    result = scheduleTopics(
      todo.map((t) => ({ id: t._id, difficulty: t.difficulty, estHours: t.estHours })),
      req.plan.examDate,
      req.plan.dailyHours
    );
  } catch (err) {
    if (err instanceof RangeError) {
      return res.status(400).json({ error: 'The exam date is today or has passed, so there are no days left to schedule.' });
    }
    throw err;
  }

  await ScheduleDay.deleteMany({ planId: req.plan._id });
  const scheduleDays = await ScheduleDay.insertMany(
    result.days.map((d) => ({ planId: req.plan._id, date: d.date, topicIds: d.topicIds, slots: d.slots }))
  );
  req.plan.status = 'active';
  await req.plan.save();

  return res.json({
    scheduleDays,
    warning: result.warning,
    unscheduledTopicIds: result.unscheduled.map((u) => u.topicId),
  });
}

const TOPIC_STATUSES = ['pending', 'done', 'missed'];

// Marks a topic pending/done/missed and, when the change warrants it, replans the remaining days.
async function updateTopicStatus(req, res) {
  const status = req.body && req.body.status;
  if (!TOPIC_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${TOPIC_STATUSES.join(', ')}` });
  }
  const { topicId } = req.params;
  if (!mongoose.isValidObjectId(topicId)) {
    return res.status(404).json({ error: 'Topic not found' });
  }
  const topic = await Topic.findOne({ _id: topicId, planId: req.plan._id });
  if (!topic) {
    return res.status(404).json({ error: 'Topic not found' });
  }

  const oldStatus = topic.status;
  const days = await ScheduleDay.find({ planId: req.plan._id });
  const slotDates = days.filter((d) => d.slots.some((s) => s.topicId.equals(topic._id))).map((d) => d.date);
  const decision = decideReplan({
    oldStatus,
    newStatus: status,
    slotDates,
    hasSchedule: days.length > 0,
    today: startOfUtcDay(new Date()),
  });

  topic.status = status;
  await topic.save();

  let replan = null;
  let explanation = null;
  let explanationSource = null;
  if (decision) {
    replan = await replanRemaining(req.plan);
    const change = {
      topic: topic.name,
      trigger: decision.trigger,
      daysOffset: decision.daysOffset,
      daysLeft: replan.daysLeft,
      rescheduledTopics: replan.rescheduledTopics,
      moves: replan.moves,
      unscheduledTopics: replan.unscheduledTopicIds.length,
    };
    try {
      explanation = await explainReplan(change);
      explanationSource = 'ai';
    } catch (err) {
      // The explanation is a nicety: never fail a status update because the free LLM is busy.
      if (!(err instanceof LlmError)) throw err;
      explanation = fallbackExplanation(change);
      explanationSource = 'fallback';
    }
  } else {
    await syncDayCompletion(req.plan._id);
  }

  // Plan-level status: completed once nothing is left to do, active again if something is reopened.
  const remaining = await Topic.countDocuments({ planId: req.plan._id, status: { $ne: 'done' } });
  const planStatus = remaining === 0 ? 'completed' : req.plan.status === 'completed' ? 'active' : req.plan.status;
  if (planStatus !== req.plan.status) {
    req.plan.status = planStatus;
    await req.plan.save();
  }

  return res.json({
    topic,
    replanned: Boolean(decision),
    explanation,
    explanationSource,
    warning: replan ? replan.warning : null,
    planStatus,
  });
}

module.exports = {
  createPlan,
  listPlans,
  getPlan,
  deletePlan,
  extractPlanTopics,
  estimatePlanTopics,
  generatePlanSchedule,
  updateTopicStatus,
};
