// Brasil não observa horário de verão desde 2019 -> offset fixo de -3h.
const OFFSET_MS = -3 * 60 * 60 * 1000;

function startOfWeekSaoPaulo(now = new Date()) {
  const local = new Date(now.getTime() + OFFSET_MS);
  const day = local.getUTCDay(); // 0=domingo .. 6=sábado
  const diffToMonday = day === 0 ? 6 : day - 1;
  local.setUTCDate(local.getUTCDate() - diffToMonday);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - OFFSET_MS);
}

module.exports = { startOfWeekSaoPaulo };
