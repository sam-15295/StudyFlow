const Plan = require('../model/planSchema');
const Topic = require('../model/topicSchema');
const ScheduleDay = require('../model/scheduleDaySchema');
const { extractTopics } = require('../service/agents/extractorAgent');
const { estimateTopics } = require('../service/agents/estimatorAgent');

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
  return res.json({ plan: { ...req.plan.toObject(), topics, scheduleDays } });
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

module.exports = { createPlan, listPlans, getPlan, deletePlan, extractPlanTopics, estimatePlanTopics };
