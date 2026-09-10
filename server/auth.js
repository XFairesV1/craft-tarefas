const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET não configurado no ambiente');
}

const COOKIE_NAME = 'admin_token';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function issueSession(res) {
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: COOKIE_OPTS.httpOnly, sameSite: COOKIE_OPTS.sameSite, secure: COOKIE_OPTS.secure });
}

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
}

function isAuthenticated(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return false;
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch (e) {
    return false;
  }
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

module.exports = {
  hashPassword,
  verifyPassword,
  issueSession,
  clearSession,
  requireAdmin,
  isAuthenticated,
  loginLimiter,
};
