const express = require('express');
const { signup, login, logout, me } = require('../controllers/userController');
const requireAuth = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/signup', signup);
router.post('/login', login);
router.post('/logout', logout);
router.get('/me', requireAuth, me);

module.exports = router;
