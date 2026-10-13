/**
 * emoji-linter.js — Zero-Emoji Enforcer
 *
 * Projedeki .ts/.tsx dosyalarını tarayarak emoji kullanimi tespit eder.
 * Kural: Arayzde (UI), baslik, bildirim, kart, buton ve CMS iceriklerinde
 * hicbir emoji kullanilmamalidir. Sadece profesyonel Lucide/SVG ikonlar kullanilir.
 *
 * Oncelik seviyeleri:
 *   CRITICAL  → JSX icerisindeki text node'lar, string proplar (UI'da gorunen)
 *   ERROR     → String literal icerisinde emoji (i18n, const, return degeri)
 *   WARNING   → console.log / yorum satirlari icindeki emojiler
 *   SKIP      → Yalnizca gelistirici arac dosyalari (scripts/, .agents/, ai-reports/)
 *
 * Komutlar:
 *   node scripts/emoji-linter.js              → Tam rapor
 *   node scripts/emoji-linter.js scan         → Tam rapor
 *   node scripts/emoji-linter.js summary      → Dosya bazli ozet tablo
 *   node scripts/emoji-linter.js worst        → En fazla ihlal olan 10 dosya
 *   node scripts/emoji-linter.js file <path>  → Tek dosya denetimi
 *   node scripts/emoji-linter.js ui           → Sadece CRITICAL (JSX/UI) ihlaller
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const SRC_DIRS = [
  path.join(REPO_ROOT, 'src'),
  path.join(REPO_ROOT, 'cms', 'src'),
];

// ─── Emoji Unicode Aralik Tespiti ───────────────────────────────────────────
// Kapsamli emoji regex — Unicode 15.x dahil
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1FA00}-\u{1FA9F}]|[\u{1FAB0}-\u{1FABB}]|[\u{1F004}]|[\u{1F0CF}]|[\u{1F170}-\u{1F171}]|[\u{1F17E}-\u{1F17F}]|[\u{1F18E}]|[\u{1F191}-\u{1F19A}]|[\u{1F1E6}-\u{1F1FF}]|[\u{1F201}-\u{1F202}]|[\u{1F21A}]|[\u{1F22F}]|[\u{1F232}-\u{1F23A}]|[\u{1F250}-\u{1F251}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]/gu;

// Izin verilen istisna dosyalar (gelistirici araci, kural dosyasi, bu script kendisi)
const SKIP_PATH_PATTERNS = [
  '.agents/',
  'ai-reports/',
  'scripts/',
  'node_modules/',
  '.expo/',
  '.git/',
  'AGENTS.md',
  'README',
];

// ─── Baglam Tespiti ──────────────────────────────────────────────────────────

function detectContext(line, lineNo, content) {
  const trimmed = line.trim();

  // console.log / console.warn / console.error / yorum
  if (/console\.(log|warn|error|info|debug)/.test(line) ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')) {
    return 'WARNING';
  }

  // JSX text node: >{emoji}< veya >{emoji}  veya sadece text icerigi
  if (/>\s*[^<{]*[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(line)) {
    return 'CRITICAL';
  }

  // JSX string prop: title="..emoji.." label="..emoji.."
  if (/(?:title|label|placeholder|text|value|message|description|name|children)\s*=\s*["'][^"']*[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(line)) {
    return 'CRITICAL';
  }

  // i18n JSON deger / string literal
  if (/["'][^"']*[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(line)) {
    return 'ERROR';
  }

  // Genel string
  return 'ERROR';
}

// ─── Dosya Tarama ────────────────────────────────────────────────────────────

function getSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.expo', '.next', 'dist', 'build', 'ai-reports'].includes(entry.name)) continue;
      getSourceFiles(fullPath, fileList);
    } else if (/\.(tsx?|jsx?|json)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}

function shouldSkip(absPath) {
  const rel = relPath(absPath);
  return SKIP_PATH_PATTERNS.some(p => rel.includes(p));
}

function auditFile(absPath) {
  if (shouldSkip(absPath)) return [];

  const rel = relPath(absPath);
  let content;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { return []; }

  const lines = content.split('\n');
  const violations = [];

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const matches = [...line.matchAll(EMOJI_REGEX)];
    if (matches.length === 0) return;

    const severity = detectContext(line, lineNo, content);
    const emojis = [...new Set(matches.map(m => m[0]))];

    violations.push({
      file: rel,
      line: lineNo,
      severity,
      emojis,
      lineContent: line.trim().slice(0, 100),
      count: matches.length,
    });
  });

  return violations;
}

// ─── Cikti ──────────────────────────────────────────────────────────────────

const SEV_COLOR = {
  CRITICAL: '\x1b[35m✖ CRITICAL\x1b[0m',
  ERROR:    '\x1b[31m✖ ERROR   \x1b[0m',
  WARNING:  '\x1b[33m⚠ WARNING \x1b[0m',
};

function printViolations(violations, onlyUI = false) {
  let filtered = onlyUI ? violations.filter(v => v.severity === 'CRITICAL') : violations;

  if (filtered.length === 0) {
    console.log('\x1b[32m✔ Temiz — hic emoji ihlali bulunamadi!\x1b[0m');
    return;
  }

  const byFile = {};
  for (const v of filtered) {
    (byFile[v.file] = byFile[v.file] || []).push(v);
  }

  for (const [file, viols] of Object.entries(byFile)) {
    console.log(`\n\x1b[1m${file}\x1b[0m  (${viols.length} ihlal)`);
    console.log('─'.repeat(70));
    for (const v of viols) {
      console.log(`  ${SEV_COLOR[v.severity]}  satir ${String(v.line).padEnd(5)}  Emoji: \x1b[33m${v.emojis.join(' ')}\x1b[0m`);
      console.log(`             \x1b[90m${v.lineContent}\x1b[0m`);
    }
  }

  const counts = { CRITICAL: 0, ERROR: 0, WARNING: 0 };
  for (const v of filtered) counts[v.severity]++;

  console.log('\n' + '═'.repeat(70));
  console.log(
    `  \x1b[35m${counts.CRITICAL} CRITICAL\x1b[0m  ` +
    `\x1b[31m${counts.ERROR} ERROR\x1b[0m  ` +
    `\x1b[33m${counts.WARNING} WARNING\x1b[0m  ` +
    `(${filtered.length} ihlal, ${Object.keys(byFile).length} dosya)`
  );
  console.log('═'.repeat(70));
}

function printSummary(allViolations) {
  const byFile = {};
  for (const v of allViolations) {
    if (!byFile[v.file]) byFile[v.file] = { CRITICAL: 0, ERROR: 0, WARNING: 0, total: 0 };
    byFile[v.file][v.severity]++;
    byFile[v.file].total++;
  }

  const sorted = Object.entries(byFile).sort((a, b) => b[1].total - a[1].total);

  if (sorted.length === 0) {
    console.log('\x1b[32m✔ Proje temiz — hic emoji ihlali yok!\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1m🔍 EMOJI DENETiM OZETi\x1b[0m — ${sorted.length} dosyada ihlal\n`);
  console.log('  Dosya'.padEnd(62) + 'CRIT   ERR    WARN   TOPLAM');
  console.log('─'.repeat(90));

  for (const [file, c] of sorted) {
    const short = file.length > 57 ? '...' + file.slice(-54) : file;
    console.log(
      `  ${short.padEnd(60)}` +
      `\x1b[35m${String(c.CRITICAL).padEnd(7)}\x1b[0m` +
      `\x1b[31m${String(c.ERROR).padEnd(7)}\x1b[0m` +
      `\x1b[33m${String(c.WARNING).padEnd(7)}\x1b[0m` +
      `${c.total}`
    );
  }

  const totCrit  = allViolations.filter(v => v.severity === 'CRITICAL').length;
  const totErr   = allViolations.filter(v => v.severity === 'ERROR').length;
  const totWarn  = allViolations.filter(v => v.severity === 'WARNING').length;
  console.log('─'.repeat(90));
  console.log(
    `  ${'TOPLAM'.padEnd(60)}` +
    `\x1b[35m${String(totCrit).padEnd(7)}\x1b[0m` +
    `\x1b[31m${String(totErr).padEnd(7)}\x1b[0m` +
    `\x1b[33m${String(totWarn).padEnd(7)}\x1b[0m` +
    `${allViolations.length}`
  );
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'scan';

  const collectAll = () => {
    let allFiles = [];
    for (const dir of SRC_DIRS) allFiles = allFiles.concat(getSourceFiles(dir));
    // i18n locale JSON dosyalarini da ekle
    const localesDir = path.join(REPO_ROOT, 'src', 'i18n', 'locales');
    if (fs.existsSync(localesDir)) allFiles = allFiles.concat(getSourceFiles(localesDir));
    return allFiles.flatMap(f => auditFile(f));
  };

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
🔍 emoji-linter.js — Zero-Emoji Enforcer

Kullanım:
  node .agents/repo-intelligence-layer/scripts/emoji-linter.js [komut] [argüman]

Komutlar:
  summary          Tüm projede dosya bazlı emoji ihlal tablosu
  ui               Yalnızca kullanıcıya doğrudan görünen UI/JSX içi CRITICAL emojiler
  worst            En fazla emoji ihlali bulunan ilk 10 dosya
  file <dosya>     Tek bir dosyadaki emojileri satır satır denetle
  scan             Tüm projeyi detaylı tara (varsayılan)
  help, -h         Bu yardım metnini gösterir
`);
    process.exit(0);
  } else if (command === 'file') {
    const targetRel = args[1];
    if (!targetRel) { console.error('Kullanım: node scripts/emoji-linter.js file <dosya_yolu>'); process.exit(1); }
    const absPath = path.resolve(REPO_ROOT, targetRel);
    if (!fs.existsSync(absPath)) { console.error(`Dosya bulunamadı: ${absPath}`); process.exit(1); }
    const violations = auditFile(absPath);
    printViolations(violations);

  } else if (command === 'summary') {
    printSummary(collectAll());

  } else if (command === 'worst') {
    const all = collectAll();
    const byFile = {};
    for (const v of all) {
      if (!byFile[v.file]) byFile[v.file] = [];
      byFile[v.file].push(v);
    }
    const worst = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    if (worst.length === 0) {
      console.log('\x1b[32m✔ Proje temiz — hic emoji ihlali yok!\x1b[0m');
    } else {
      console.log('\n\x1b[1mEN FAZLA EMOJi IHLALI OLAN 10 DOSYA\x1b[0m\n');
      worst.forEach(([file, viols], i) => {
        const crit = viols.filter(v => v.severity === 'CRITICAL').length;
        const err  = viols.filter(v => v.severity === 'ERROR').length;
        const warn = viols.filter(v => v.severity === 'WARNING').length;
        console.log(`  ${String(i + 1).padStart(2)}. ${file}`);
        console.log(`      \x1b[35m${crit} CRITICAL\x1b[0m  \x1b[31m${err} ERROR\x1b[0m  \x1b[33m${warn} WARNING\x1b[0m  (toplam: ${viols.length})`);
      });
    }

  } else if (command === 'ui') {
    const all = collectAll();
    console.log('\n\x1b[1mSadece UI/JSX Emoji ihlalleri (CRITICAL)\x1b[0m\n');
    printViolations(all, true);

  } else {
    // scan
    const all = collectAll();
    console.log(`\n Emoji taramasi yapiliyor...`);
    printViolations(all);
  }
}

module.exports = { auditFile, getSourceFiles };
