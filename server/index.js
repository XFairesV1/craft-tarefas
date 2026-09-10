const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const prisma = require('./db');
const { startOfWeekSaoPaulo } = require('./week');
const {
  hashPassword,
  verifyPassword,
  issueSession,
  clearSession,
  requireAdmin,
  isAuthenticated,
  loginLimiter,
} = require('./auth');

const PORT = process.env.PORT || 3000;
const XP_PER_LEVEL = 500;

const SEED_TASKS = [
  { name: 'Arrumar a cama', desc: 'Cama arrumada e quarto em ordem', points: 60, frequencyPerWeek: 7 },
  { name: 'Tirar o lixo', desc: 'Colocar o lixo para fora e trocar o saco', points: 60, frequencyPerWeek: 7 },
  { name: 'Lavar a louça', desc: 'Deixar a pia vazia e tudo limpo', points: 200, frequencyPerWeek: 7 },
  { name: 'Organizar o quarto', desc: 'Guardar roupas e brinquedos no lugar', points: 120, frequencyPerWeek: 6 },
  { name: 'Varrer a casa', desc: 'Varrer todos os cômodos', points: 120, frequencyPerWeek: 4 },
  { name: 'Limpar o banheiro', desc: 'Pia, vaso e box brilhando', points: 600, frequencyPerWeek: 2 },
];

const ACHIEVEMENTS = [
  { id: 'first', icon: '📸', name: 'Primeira Prova!', cond: (c) => c.done >= 1 },
  { id: 'five', icon: '⛏️', name: 'Picareta de Pedra! (5 tarefas)', cond: (c) => c.done >= 5 },
  { id: 'ten', icon: '💎', name: 'Era do Diamante! (10 tarefas)', cond: (c) => c.done >= 10 },
  { id: 'rich', icon: '👑', name: 'Mil Esmeraldas!', cond: (c) => c.earned >= 1000 },
  { id: 'twenty', icon: '🏆', name: 'Lenda da Faxina! (20 tarefas)', cond: (c) => c.done >= 20 },
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('invalid_mimetype'));
    cb(null, true);
  },
});

async function getConfig() {
  let config = await prisma.config.findFirst();
  if (!config) {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
    if (!initialPassword) {
      throw new Error('ADMIN_INITIAL_PASSWORD não configurado para o seed inicial do admin');
    }
    config = await prisma.config.create({ data: { passwordHash: hashPassword(initialPassword) } });
  }
  return config;
}

async function ensureSeedTasks() {
  const count = await prisma.task.count();
  if (count === 0) {
    await prisma.task.createMany({ data: SEED_TASKS });
  }
}

function computeStats(config, submissions) {
  const counted = submissions.filter((s) => s.status !== 'rejected');
  const earned = counted.reduce((a, s) => a + s.points, 0);
  const balance = earned - config.redeemedPoints;
  const done = counted.length;
  const level = Math.floor(earned / XP_PER_LEVEL);
  const xpIn = earned % XP_PER_LEVEL;
  return { earned, balance, done, level, xpIn };
}

function projectionReais(tasks, pointsPerReal) {
  const weekly = tasks.reduce((sum, t) => sum + (t.points / pointsPerReal) * t.frequencyPerWeek, 0);
  return Math.round(weekly * (30 / 7) * 100) / 100;
}

async function checkAchievements(config, stats) {
  const unlocked = [];
  const have = new Set(config.achievements);
  for (const a of ACHIEVEMENTS) {
    if (!have.has(a.id) && a.cond(stats)) {
      have.add(a.id);
      unlocked.push({ id: a.id, icon: a.icon, name: a.name });
    }
  }
  if (unlocked.length) {
    await prisma.config.update({ where: { id: config.id }, data: { achievements: Array.from(have) } });
  }
  return unlocked;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// ==================== ESTADO PÚBLICO (tela do jogador) ====================
app.get('/api/state', async (req, res, next) => {
  try {
    const [config, tasks, submissions] = await Promise.all([
      getConfig(),
      prisma.task.findMany({ orderBy: { id: 'asc' } }),
      prisma.submission.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    const weekStart = startOfWeekSaoPaulo();
    const weekCounts = await prisma.submission.groupBy({
      by: ['taskId'],
      where: { createdAt: { gte: weekStart }, status: { not: 'rejected' } },
      _count: { _all: true },
    });
    const weekCountByTask = Object.fromEntries(weekCounts.map((w) => [w.taskId, w._count._all]));
    const stats = computeStats(config, submissions);

    res.json({
      player: { name: config.playerName, pointsPerReal: config.pointsPerReal },
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        desc: t.desc,
        points: t.points,
        frequencyPerWeek: t.frequencyPerWeek,
        remainingThisWeek: Math.max(0, t.frequencyPerWeek - (weekCountByTask[t.id] || 0)),
      })),
      submissions: submissions.map((s) => ({
        id: s.id,
        taskName: s.taskName,
        points: s.points,
        status: s.status,
        createdAt: s.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

app.post('/api/submissions', upload.single('photo'), async (req, res, next) => {
  try {
    const taskId = parseInt(req.body.taskId, 10);
    if (!taskId) return res.status(400).json({ error: 'missing_task' });
    if (!req.file) return res.status(400).json({ error: 'missing_photo' });

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return res.status(404).json({ error: 'task_not_found' });

    const weekStart = startOfWeekSaoPaulo();
    const usedThisWeek = await prisma.submission.count({
      where: { taskId, createdAt: { gte: weekStart }, status: { not: 'rejected' } },
    });
    if (usedThisWeek >= task.frequencyPerWeek) {
      return res.status(409).json({ error: 'weekly_limit_reached', limit: task.frequencyPerWeek });
    }

    const submission = await prisma.submission.create({
      data: {
        taskId: task.id,
        taskName: task.name,
        points: task.points,
        photo: req.file.buffer,
        photoMime: req.file.mimetype,
        status: 'pending',
      },
    });

    const config = await getConfig();
    const allSubmissions = await prisma.submission.findMany();
    const stats = computeStats(config, allSubmissions);
    const unlocked = await checkAchievements(config, { done: stats.done, earned: stats.earned });

    res.status(201).json({ id: submission.id, points: submission.points, unlocked, level: stats.level });
  } catch (e) {
    next(e);
  }
});

app.get('/api/photos/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const submission = await prisma.submission.findUnique({ where: { id } });
    if (!submission) return res.status(404).end();
    res.set('Content-Type', submission.photoMime);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(Buffer.from(submission.photo));
  } catch (e) {
    next(e);
  }
});

// ==================== ADMIN ====================
app.post('/api/admin/login', loginLimiter, async (req, res, next) => {
  try {
    const { password } = req.body;
    const config = await getConfig();
    if (!password || !verifyPassword(password, config.passwordHash)) {
      return res.status(401).json({ error: 'wrong_password' });
    }
    issueSession(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.use('/api/admin', requireAdmin);

app.get('/api/admin/overview', async (req, res, next) => {
  try {
    const [config, tasks, submissions] = await Promise.all([
      getConfig(),
      prisma.task.findMany({ orderBy: { id: 'asc' } }),
      prisma.submission.findMany({ orderBy: { createdAt: 'desc' } }),
    ]);
    const stats = computeStats(config, submissions);
    res.json({
      config: { playerName: config.playerName, pointsPerReal: config.pointsPerReal },
      stats,
      cashoutReais: stats.balance / config.pointsPerReal,
      projectionReais: projectionReais(tasks, config.pointsPerReal),
      tasks: tasks.map((t) => ({ ...t, valueReais: t.points / config.pointsPerReal })),
      submissions: submissions.map((s) => ({
        id: s.id,
        taskName: s.taskName,
        points: s.points,
        status: s.status,
        createdAt: s.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

app.patch('/api/admin/submissions/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const submission = await prisma.submission.update({
      where: { id },
      data: { status, reviewedAt: new Date() },
    });
    res.json({ id: submission.id, status: submission.status });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/admin/submissions/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.submission.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/tasks', async (req, res, next) => {
  try {
    const { name, desc, points, frequencyPerWeek } = req.body;
    if (!name || !points || points < 1) return res.status(400).json({ error: 'invalid_task' });
    const task = await prisma.task.create({
      data: {
        name: String(name).trim(),
        desc: (desc || '').toString().trim(),
        points: parseInt(points, 10),
        frequencyPerWeek: Math.min(7, Math.max(1, parseInt(frequencyPerWeek, 10) || 7)),
      },
    });
    res.status(201).json(task);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/admin/tasks/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.task.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.patch('/api/admin/config', async (req, res, next) => {
  try {
    const config = await getConfig();
    const data = {};
    if (typeof req.body.playerName === 'string' && req.body.playerName.trim()) {
      data.playerName = req.body.playerName.trim();
    }
    if (req.body.pointsPerReal && parseInt(req.body.pointsPerReal, 10) > 0) {
      data.pointsPerReal = parseInt(req.body.pointsPerReal, 10);
    }
    if (typeof req.body.password === 'string' && req.body.password.trim()) {
      data.passwordHash = hashPassword(req.body.password.trim());
    }
    const updated = await prisma.config.update({ where: { id: config.id }, data });
    res.json({ playerName: updated.playerName, pointsPerReal: updated.pointsPerReal });
  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/cashout', async (req, res, next) => {
  try {
    const config = await getConfig();
    const submissions = await prisma.submission.findMany();
    const stats = computeStats(config, submissions);
    if (stats.balance <= 0) return res.status(400).json({ error: 'nothing_to_pay' });
    await prisma.config.update({ where: { id: config.id }, data: { redeemedPoints: stats.earned } });
    res.json({ paidReais: stats.balance / config.pointsPerReal });
  } catch (e) {
    next(e);
  }
});

// Zera histórico de envios/conquistas/saldo resgatado (recomeça o progresso),
// sem apagar tarefas cadastradas nem trocar a senha do admin.
app.post('/api/admin/reset', async (req, res, next) => {
  try {
    const config = await getConfig();
    await prisma.submission.deleteMany();
    await prisma.config.update({ where: { id: config.id }, data: { redeemedPoints: 0, achievements: [] } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ==================== FRONTEND ESTÁTICO ====================
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  if (err && err.message === 'invalid_mimetype') return res.status(400).json({ error: 'invalid_mimetype' });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

async function start() {
  await getConfig();
  await ensureSeedTasks();
  app.listen(PORT, '0.0.0.0', () => console.log(`craft-tarefas ouvindo na porta ${PORT}`));
}

start();
