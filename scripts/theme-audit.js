/**
 * theme-audit.js — Design Token & Theme Enforcer
 *
 * Projedeki .ts/.tsx dosyalarını tarayarak tema ihlallerini tespit eder:
 *   - Hardcoded Tailwind renk class'ları (text-purple-500, bg-emerald-400 vb.)
 *   - Hardcoded hex renk string'leri (#a855f7, #10b981 vb.) StyleSheet içinde
 *   - Token olarak kullanılması gereken ama hardcoded yazılmış rgba/rgb değerleri
 *
 * Komutlar:
 *   node scripts/theme-audit.js              → Tüm proje tarama (tam rapor)
 *   node scripts/theme-audit.js scan         → Tüm proje tarama (tam rapor)
 *   node scripts/theme-audit.js file <path>  → Tek dosya denetimi
 *   node scripts/theme-audit.js summary      → Sadece özet (dosya bazlı sayım)
 *   node scripts/theme-audit.js worst        → En fazla ihlal olan ilk 10 dosya
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const SRC_DIRS = [
  path.join(REPO_ROOT, 'src'),
  path.join(REPO_ROOT, 'cms', 'src'),
];

// ─── İhlal Kuralları ────────────────────────────────────────────────────────

// 1) Hardcoded Tailwind renk class'ları (CMS/Web için geçerli)
//    Kural: Bunların yerine var(--theme-accent) tabanlı custom class'lar kullanılmalı.
const TAILWIND_COLOR_PATTERN = /\b(text|bg|border|ring|fill|stroke|shadow|from|to|via|outline|decoration|caret|divide|placeholder|accent)-(purple|violet|fuchsia|pink|rose|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|slate|gray|zinc|neutral|stone)\s*-\s*(50|100|200|300|400|500|600|700|800|900|950)\b/g;

// 2) Hardcoded hex renk string'leri (her iki platform için)
//    Beyaz (#fff, #ffffff), siyah (#000, #000000) ve tam şeffaf (transparent) kabul edilir.
const HEX_COLOR_PATTERN = /#([0-9a-fA-F]{3,8})\b/g;
const ALLOWED_HEX = new Set([
  '#fff', '#ffffff', '#FFF', '#FFFFFF',
  '#000', '#000000', '#000000',
  '#transparent',
]);
// Tema dosyalarındaki hex'ler (tanım yerleri) ihlal sayılmaz
const THEME_DEFINITION_FILES = [
  'src/theme/theme.ts',
  'src/theme/ThemeProvider.tsx',
  'cms/src/lib/theme.ts',
];

// 3) Hardcoded rgba/rgb renk değerleri (arka plan, glow vs.)
const RGB_COLOR_PATTERN = /\brgba?\s*\(\s*[\d.,\s]+\)/g;

// ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────

function getSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.expo', '.next', 'dist', 'build', 'ai-reports'].includes(entry.name)) continue;
      getSourceFiles(fullPath, fileList);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}

function isThemeDefinitionFile(absPath) {
  const rel = relPath(absPath);
  return THEME_DEFINITION_FILES.some(f => rel === f || rel.endsWith(f));
}

function auditFile(absPath) {
  const rel = relPath(absPath);
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  const isThemeDef = isThemeDefinitionFile(absPath);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // Yorum satırlarını atla
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    // ── Kural 1: Tailwind hardcoded renk class'ları ──
    const twMatches = [...line.matchAll(TAILWIND_COLOR_PATTERN)];
    for (const m of twMatches) {
      violations.push({
        file: rel,
        line: lineNo,
        rule: 'TAILWIND_HARDCODED_COLOR',
        severity: 'ERROR',
        match: m[0].trim(),
        lineContent: trimmed,
        fix: `var(--theme-accent) veya var(--theme-accent-bg) kullan`,
      });
    }

    // ── Kural 2: Hardcoded hex renk string'leri ──
    if (!isThemeDef) {
      const hexMatches = [...line.matchAll(HEX_COLOR_PATTERN)];
      for (const m of hexMatches) {
        const hex = m[0].toLowerCase();
        if (ALLOWED_HEX.has(hex) || ALLOWED_HEX.has(m[0])) continue;
        // Sadece stil bağlamında geçenleri yakala (StyleSheet, style=, color:, backgroundColor:)
        const isStyleContext = /style|color|Color|background|Background|tint|Tint|fill|stroke|shadow|Shadow|gradient|Gradient|border|Border/.test(line);
        if (!isStyleContext) continue;
        violations.push({
          file: rel,
          line: lineNo,
          rule: 'HARDCODED_HEX_COLOR',
          severity: 'WARNING',
          match: m[0],
          lineContent: trimmed,
          fix: `theme.colors.accent / theme.colors.text veya CSS token kullan`,
        });
      }
    }

    // ── Kural 3: Hardcoded rgba/rgb değerleri (stil bağlamı) ──
    if (!isThemeDef) {
      const rgbMatches = [...line.matchAll(RGB_COLOR_PATTERN)];
      for (const m of rgbMatches) {
        const isStyleContext = /style|color|Color|background|Background|tint|fill|shadow|Shadow|gradient|Gradient|border|Border/.test(line);
        if (!isStyleContext) continue;
        violations.push({
          file: rel,
          line: lineNo,
          rule: 'HARDCODED_RGB_COLOR',
          severity: 'WARNING',
          match: m[0],
          lineContent: trimmed,
          fix: `theme.colors.* veya var(--theme-accent-glow) / var(--theme-accent-bg) kullan`,
        });
      }
    }
  });

  return violations;
}

// ─── Çıktı Formatlama ────────────────────────────────────────────────────────

const SEVERITY_ICON = { ERROR: '\x1b[31m✖ ERROR\x1b[0m', WARNING: '\x1b[33m⚠ WARN \x1b[0m' };
const RULE_LABEL = {
  TAILWIND_HARDCODED_COLOR: 'Tailwind Hardcoded Renk',
  HARDCODED_HEX_COLOR: 'Hardcoded Hex Renk',
  HARDCODED_RGB_COLOR: 'Hardcoded RGB/RGBA',
};

function printViolations(violations, fileLabel) {
  if (violations.length === 0) {
    console.log(`\x1b[32m✔ Temiz — tema ihlali bulunamadı.\x1b[0m`);
    if (fileLabel) console.log(`   Dosya: ${fileLabel}`);
    return;
  }

  const byFile = {};
  for (const v of violations) {
    (byFile[v.file] = byFile[v.file] || []).push(v);
  }

  let errorCount = 0, warnCount = 0;

  for (const [file, viols] of Object.entries(byFile)) {
    console.log(`\n\x1b[1m${file}\x1b[0m  (${viols.length} ihlal)`);
    console.log('─'.repeat(60));
    for (const v of viols) {
      console.log(`  ${SEVERITY_ICON[v.severity]}  satır ${String(v.line).padEnd(5)}  \x1b[36m${RULE_LABEL[v.rule]}\x1b[0m`);
      console.log(`             \x1b[90m${v.lineContent.slice(0, 90)}\x1b[0m`);
      console.log(`             Eşleşme: \x1b[33m${v.match}\x1b[0m`);
      console.log(`             Düzeltme: ${v.fix}`);
      if (v.severity === 'ERROR') errorCount++;
      else warnCount++;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`  Toplam: \x1b[31m${errorCount} ERROR\x1b[0m  \x1b[33m${warnCount} WARNING\x1b[0m  (${violations.length} ihlal, ${Object.keys(byFile).length} dosya)`);
  console.log('═'.repeat(60));
}

function printSummary(allViolations) {
  const byFile = {};
  for (const v of allViolations) {
    if (!byFile[v.file]) byFile[v.file] = { ERROR: 0, WARNING: 0, total: 0 };
    byFile[v.file][v.severity]++;
    byFile[v.file].total++;
  }

  const sorted = Object.entries(byFile).sort((a, b) => b[1].total - a[1].total);

  if (sorted.length === 0) {
    console.log('\x1b[32m✔ Proje temiz — hiç tema ihlali yok!\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1m📋 TEMA DENETİM ÖZETİ\x1b[0m — ${sorted.length} dosyada ihlal\n`);
  console.log('  Dosya'.padEnd(60) + 'ERROR  WARN   TOPLAM');
  console.log('─'.repeat(80));
  for (const [file, counts] of sorted) {
    const fileShort = file.length > 55 ? '...' + file.slice(-52) : file;
    console.log(
      `  ${fileShort.padEnd(58)}\x1b[31m${String(counts.ERROR).padEnd(7)}\x1b[0m\x1b[33m${String(counts.WARNING).padEnd(7)}\x1b[0m${counts.total}`
    );
  }
  const totalErr = allViolations.filter(v => v.severity === 'ERROR').length;
  const totalWarn = allViolations.filter(v => v.severity === 'WARNING').length;
  console.log('─'.repeat(80));
  console.log(`  ${'TOPLAM'.padEnd(58)}\x1b[31m${String(totalErr).padEnd(7)}\x1b[0m\x1b[33m${String(totalWarn).padEnd(7)}\x1b[0m${allViolations.length}`);
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'scan';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
📋 theme-audit.js — Tema Token & Hardcoded Renk Denetçisi

Kullanım:
  node .agents/repo-intelligence-layer/scripts/theme-audit.js [komut] [argüman]

Komutlar:
  summary          Tüm projede dosya bazlı ihlal özeti tablosu
  worst            En fazla tema ihlali bulunan ilk 10 dosya
  file <dosya>     Tek bir dosyayı detaylı denetle (satır numaraları ve öneriler)
  scan             Tüm projeyi detaylı tara (varsayılan)
  help, -h         Bu yardım metnini gösterir
`);
    process.exit(0);
  } else if (command === 'file') {
    const targetRel = args[1];
    if (!targetRel) {
      console.error('Kullanım: node scripts/theme-audit.js file <dosya_yolu>');
      process.exit(1);
    }
    const absPath = path.resolve(REPO_ROOT, targetRel);
    if (!fs.existsSync(absPath)) {
      console.error(`Dosya bulunamadı: ${absPath}`);
      process.exit(1);
    }
    const violations = auditFile(absPath);
    printViolations(violations, targetRel);

  } else if (command === 'summary') {
    let allFiles = [];
    for (const dir of SRC_DIRS) allFiles = allFiles.concat(getSourceFiles(dir));
    const allViolations = allFiles.flatMap(f => auditFile(f));
    printSummary(allViolations);

  } else if (command === 'worst') {
    let allFiles = [];
    for (const dir of SRC_DIRS) allFiles = allFiles.concat(getSourceFiles(dir));
    const allViolations = allFiles.flatMap(f => auditFile(f));
    const byFile = {};
    for (const v of allViolations) {
      if (!byFile[v.file]) byFile[v.file] = [];
      byFile[v.file].push(v);
    }
    const worst10 = Object.entries(byFile)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);

    if (worst10.length === 0) {
      console.log('\x1b[32m✔ Proje temiz — hiç tema ihlali yok!\x1b[0m');
    } else {
      console.log('\n\x1b[1m🔥 EN FAZLA İHLAL OLAN 10 DOSYA\x1b[0m\n');
      worst10.forEach(([file, viols], i) => {
        const errors = viols.filter(v => v.severity === 'ERROR').length;
        const warns = viols.filter(v => v.severity === 'WARNING').length;
        console.log(`  ${String(i + 1).padStart(2)}. ${file}`);
        console.log(`      \x1b[31m${errors} ERROR\x1b[0m  \x1b[33m${warns} WARNING\x1b[0m  (toplam: ${viols.length})`);
      });
    }

  } else {
    // scan (varsayilan)
    let allFiles = [];
    for (const dir of SRC_DIRS) allFiles = allFiles.concat(getSourceFiles(dir));
    console.log(`\n🔍 ${allFiles.length} dosya taranıyor...`);
    const allViolations = allFiles.flatMap(f => auditFile(f));
    printViolations(allViolations);
  }
}

module.exports = { auditFile, getSourceFiles };
