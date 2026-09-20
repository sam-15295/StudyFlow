const mongoose = require('mongoose');
const Plan = require('../model/planSchema');

// Loads /:id into req.plan, but only if it belongs to the logged-in user.
// Other users' plans get the same 404 as missing ones, so plan ids can't be probed.
async function loadOwnedPlan(req, res, next) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ error: 'Plan not found' });
  }
  const plan = await Plan.findOne({ _id: id, userId: req.user.id });
  if (!plan) {
    return res.status(404).json({ error: 'Plan not found' });
  }
  req.plan = plan;
  next();
}

module.exports = loadOwnedPlan;
