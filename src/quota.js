import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAILY_LIMIT_PATTERNS = [
  /\b(?:daily|message|usage|rate)\s+limit\b/i,
  /\breached\s+(?:your|the)\s+(?:daily\s+)?limit\b/i,
  /\btry\s+again\s+(?:tomorrow|later)\b/i,
  /\blimit\s+for\s+(?:think\s+deeper|deep\s+thinking|this\s+model)\b/i,
  /(?:达到|已达|超过).{0,10}(?:每日|今日|使用|次数|消息).{0,6}(?:上限|限额|限制)/,
  /(?:配额|额度|次数).{0,6}(?:已用完|耗尽|不足)/,
  /(?:明天再试|明日再试|今日.*上限)/
];

const CONVERSATION_LIMIT_PATTERNS = [
  /\b(?:start\s+a\s+new\s+(?:chat|topic|conversation)|conversation\s+(?:limit|has\s+reached|is\s+full)|maximum\s+(?:turns|length)\s+reached)\b/i,
  /(?:开启新对话|新建聊天|新建主题|本对话已达上限|对话轮次已达上限|请开始新对话)/
];

export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function detectWebLimitNotice(text) {
  if (typeof text !== 'string') return { limited: false, kind: null };
  const trimmed = text.trim();
  // Genuine long protocol replies or code outputs should not be misclassified as short limit banners.
  if (!trimmed || trimmed.length > 1200 || trimmed.includes('<<<COPILOT_REPLY_START:')) {
    return { limited: false, kind: null };
  }
  if (DAILY_LIMIT_PATTERNS.some(pattern => pattern.test(trimmed))) {
    return { limited: true, kind: 'daily_limit', excerpt: trimmed.slice(0, 200) };
  }
  if (CONVERSATION_LIMIT_PATTERNS.some(pattern => pattern.test(trimmed))) {
    return { limited: true, kind: 'conversation_limit', excerpt: trimmed.slice(0, 200) };
  }
  return { limited: false, kind: null };
}

function emptyQuotaRecord(date) {
  return {
    date,
    counts: { think: 0, quick: 0, auto: 0, index: 0, total: 0 },
    thinkLimited: false,
    thinkLimitedAt: null
  };
}

export async function readTodayQuota(paths, now = new Date()) {
  const today = localDateKey(now);
  if (!paths?.quotaFile) return emptyQuotaRecord(today);
  try {
    const raw = await readFile(paths.quotaFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.date === today && parsed.counts) {
      return {
        date: today,
        counts: {
          think: Number(parsed.counts.think) || 0,
          quick: Number(parsed.counts.quick) || 0,
          auto: Number(parsed.counts.auto) || 0,
          index: Number(parsed.counts.index) || 0,
          total: Number(parsed.counts.total) || 0
        },
        thinkLimited: Boolean(parsed.thinkLimited),
        thinkLimitedAt: parsed.thinkLimitedAt ?? null
      };
    }
  } catch { /* missing or corrupt */ }
  return emptyQuotaRecord(today);
}

async function writeQuota(paths, record) {
  if (!paths?.quotaFile) return record;
  await mkdir(dirname(paths.quotaFile), { recursive: true });
  const temp = `${paths.quotaFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, paths.quotaFile);
  return record;
}

export async function recordWebTurn(paths, effectivePreference, now = new Date()) {
  const record = await readTodayQuota(paths, now);
  const bucket = effectivePreference?.kind === 'index'
    ? 'index'
    : ['think', 'quick', 'auto'].includes(effectivePreference?.name)
      ? effectivePreference.name
      : 'auto';
  record.counts[bucket] = (record.counts[bucket] ?? 0) + 1;
  record.counts.total = (record.counts.total ?? 0) + 1;
  try { await writeQuota(paths, record); } catch { /* best effort */ }
  return record;
}

export async function markThinkLimitedToday(paths, now = new Date()) {
  const record = await readTodayQuota(paths, now);
  record.thinkLimited = true;
  record.thinkLimitedAt = now.toISOString();
  try { await writeQuota(paths, record); } catch { /* best effort */ }
  return record;
}

export function formatQuotaShort(record) {
  if (!record?.counts) return '';
  const { think, quick, auto, total } = record.counts;
  if (!total) return 'today: 0';
  const parts = [];
  if (think) parts.push(`${think}t`);
  if (quick) parts.push(`${quick}q`);
  if (auto) parts.push(`${auto}a`);
  const detail = parts.length ? ` (${parts.join('/')})` : '';
  return `today: ${total}${detail}${record.thinkLimited ? ' [think cap]' : ''}`;
}
