const express = require('express');
const {
  createPlan,
  listPlans,
  getPlan,
  deletePlan,
  extractPlanTopics,
  estimatePlanTopics,
} = require('../controllers/planController');
const requireAuth = require('../middlewares/authMiddleware');
const loadOwnedPlan = require('../middlewares/loadPlan');

const router = express.Router();

router.use(requireAuth);

router.post('/', createPlan);
router.get('/', listPlans);
router.get('/:id', loadOwnedPlan, getPlan);
router.delete('/:id', loadOwnedPlan, deletePlan);
router.post('/:id/extract', loadOwnedPlan, extractPlanTopics);
router.post('/:id/estimate', loadOwnedPlan, estimatePlanTopics);

module.exports = router;
