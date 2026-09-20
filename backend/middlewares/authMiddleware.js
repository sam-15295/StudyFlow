const jwt = require('jsonwebtoken');
const User = require('../model/userSchema');

async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const user = await User.findById(payload.sub).select('email');
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = { id: user._id.toString(), email: user.email };
  next();
}

module.exports = requireAuth;
