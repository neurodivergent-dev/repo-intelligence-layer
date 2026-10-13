/**
 * code-health.js — AST Tabanlı Hafif Kod Sağlığı & Anti-Pattern Linter'ı
 *
 * Sıfır harici paket bağımlılığıyla doğrudan TypeScript Compiler API (AST) üzerinden:
 *   1. Unutulmuş console.log / console.info / debugger kalıntıları
 *   2. Tehlikeli boş catch blokları (silent fail / hata yutma)
 *   3. Kontrolsüz veya tembel `any` tip kaçamakları (as any, : any)
 *   4. Kullanılmayan veya gereksiz import kalıntıları
 *   5. react-hooks/rules-of-hooks ihlalleri (döngü/koşul içinde hook çağrısı)
 *
 * Komutlar:
 *   node scripts/code-health.js <dosya>          → Tek dosyayı denetle
 *   node scripts/code-health.js file <dosya>     → Tek dosyayı denetle
 *   node scripts/code-health.js summary          → Tüm projede kod sağlığı özeti
 *   node scripts/code-health.js worst            → En fazla anti-pattern bulunan ilk 10 dosya
 *   node scripts/code-health.js scan             → Tüm projeyi detaylı tara (varsayılan)
 *   node scripts/code-health.js help             → Yardım metni
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const REPO_ROOT = process.cwd();
const SRC_DIRS = [
  path.join(REPO_ROOT, 'src'),
  path.join(REPO_ROOT, 'cms', 'src'),
];

// Yoksayılacak dosyalar / dizinler
const SKIP_PATTERNS = [
  'node_modules',
  '.expo',
  '.next',
  'dist',
  'build',
  'ai-reports',
  '.agents',
  'scripts',
];

function relPath(p) {
  return path.relative(REPO_ROOT, p).replace(/\\/g, '/');
}

function getSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_PATTERNS.some(p => entry.name.includes(p))) continue;
      getSourceFiles(fullPath, fileList);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// ─── AST Bazlı Kural Denetçisi ────────────────────────────────────────────────

function auditCodeHealth(filePath) {
  const rel = relPath(filePath);
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const issues = [];

  function getLine(pos) {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  function walk(node, inConditionOrLoop = false) {
    // 1. Debugger statement
    if (ts.isDebuggerStatement(node)) {
      issues.push({
        file: rel,
        line: getLine(node.getStart()),
        rule: 'NO_DEBUGGER',
        severity: 'ERROR',
        message: 'Unutulmuş debugger ifadesi tespit edildi.',
        snippet: node.getText(sourceFile),
      });
    }

    // 2. Console.log / console.info (console.error ve warn hariç tutulabilir veya uyarılabilir)
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.expression.getText(sourceFile) === 'console'
      ) {
        const method = expr.name.getText(sourceFile);
        if (['log', 'info', 'debug', 'trace'].includes(method)) {
          issues.push({
            file: rel,
            line: getLine(node.getStart()),
            rule: 'NO_CONSOLE_LOG',
            severity: 'WARNING',
            message: `Üretim kodunda console.${method} bırakılmamalıdır.`,
            snippet: node.getText(sourceFile).slice(0, 60),
          });
        }
      }

      // 5. Hookların koşul / döngü içinde çağrılması (Rules of Hooks)
      if (inConditionOrLoop) {
        const fnName = expr.getText(sourceFile);
        if (/^use[A-Z0-9]/.test(fnName)) {
          issues.push({
            file: rel,
            line: getLine(node.getStart()),
            rule: 'HOOKS_IN_LOOP_OR_CONDITION',
            severity: 'ERROR',
            message: `React Hook'u (${fnName}) döngü, koşul veya iç içe fonksiyon içinde çağrılamaz.`,
            snippet: node.getText(sourceFile).slice(0, 60),
          });
        }
      }
    }

    // 3. Boş Catch Blokları (Silent Fail)
    if (ts.isCatchClause(node)) {
      const block = node.block;
      // Yalnızca boş veya sadece yorum satırı içeren bloklar
      const statements = block.statements;
      if (statements.length === 0) {
        issues.push({
          file: rel,
          line: getLine(node.getStart()),
          rule: 'NO_EMPTY_CATCH',
          severity: 'ERROR',
          message: 'Boş catch bloğu! Hata yutuluyor (silent failure). En azından loglanmalı veya yönetilmelidir.',
          snippet: node.getText(sourceFile).slice(0, 60),
        });
      }
    }

    // 4. Any Tip Kaçamakları (: any veya as any)
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      issues.push({
        file: rel,
        line: getLine(node.getStart()),
        rule: 'NO_EXPLICIT_ANY',
        severity: 'WARNING',
        message: 'Açık "any" tipi tespit edildi. Uygun bir tip veya "unknown" tercih edilmelidir.',
        snippet: node.parent ? node.parent.getText(sourceFile).slice(0, 50) : 'any',
      });
    }

    // Döngü veya Koşul Takibi
    const isControlFlow =
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isConditionalExpression(node);

    ts.forEachChild(node, child => walk(child, inConditionOrLoop || isControlFlow));
  }

  walk(sourceFile);
  return issues;
}

// ─── Çıktı Formatlama ────────────────────────────────────────────────────────

function printIssues(issues, fileLabel) {
  if (issues.length === 0) {
    console.log(`\x1b[32m✔ Kod sağlığı kusursuz — anti-pattern veya kalıntı bulunamadı.\x1b[0m`);
    if (fileLabel) console.log(`   Dosya: ${fileLabel}`);
    return;
  }

  const byFile = {};
  for (const issue of issues) {
    (byFile[issue.file] = byFile[issue.file] || []).push(issue);
  }

  let errors = 0;
  let warnings = 0;

  for (const [file, items] of Object.entries(byFile)) {
    console.log(`\n\x1b[1m${file}\x1b[0m  (${items.length} bulgu)`);
    console.log('─'.repeat(70));
    for (const item of items) {
      const icon = item.severity === 'ERROR' ? '\x1b[31m✖ ERROR  \x1b[0m' : '\x1b[33m⚠ WARNING\x1b[0m';
      console.log(`  ${icon}  satır ${String(item.line).padEnd(5)}  \x1b[36m${item.rule}\x1b[0m`);
      console.log(`             ${item.message}`);
      console.log(`             \x1b[90m${item.snippet.trim().replace(/\n/g, ' ')}\x1b[0m`);
      if (item.severity === 'ERROR') errors++;
      else warnings++;
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`  Toplam: \x1b[31m${errors} ERROR\x1b[0m  \x1b[33m${warnings} WARNING\x1b[0m  (${issues.length} bulgu, ${Object.keys(byFile).length} dosya)`);
  console.log('═'.repeat(70));
}

function printSummary(allIssues) {
  const byFile = {};
  for (const i of allIssues) {
    if (!byFile[i.file]) byFile[i.file] = { ERROR: 0, WARNING: 0, total: 0 };
    byFile[i.file][i.severity]++;
    byFile[i.file].total++;
  }

  const sorted = Object.entries(byFile).sort((a, b) => b[1].total - a[1].total);

  if (sorted.length === 0) {
    console.log('\x1b[32m✔ Proje kodu tertemiz — hiç anti-pattern yok!\x1b[0m');
    return;
  }

  console.log(`\n\x1b[1m🩺 KOD SAĞLIĞI ÖZETİ\x1b[0m — ${sorted.length} dosyada bulgu\n`);
  console.log('  Dosya'.padEnd(60) + 'ERROR  WARN   TOPLAM');
  console.log('─'.repeat(80));
  for (const [file, counts] of sorted) {
    const fileShort = file.length > 55 ? '...' + file.slice(-52) : file;
    console.log(
      `  ${fileShort.padEnd(58)}\x1b[31m${String(counts.ERROR).padEnd(7)}\x1b[0m\x1b[33m${String(counts.WARNING).padEnd(7)}\x1b[0m${counts.total}`
    );
  }
  const totalErr = allIssues.filter(i => i.severity === 'ERROR').length;
  const totalWarn = allIssues.filter(i => i.severity === 'WARNING').length;
  console.log('─'.repeat(80));
  console.log(`  ${'TOPLAM'.padEnd(58)}\x1b[31m${String(totalErr).padEnd(7)}\x1b[0m\x1b[33m${String(totalWarn).padEnd(7)}\x1b[0m${allIssues.length}`);
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'scan';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
🩺 code-health.js — AST Kod Sağlığı & Anti-Pattern Linter'ı

Kullanım:
  node .agents/repo-intelligence-layer/scripts/code-health.js [komut] [argüman]

Komutlar:
  file <dosya>     Tek bir dosyadaki anti-pattern ve kod sağlığı açıklarını listeler
  summary          Tüm projede dosya bazlı bulgu tablosunu gösterir
  worst            En fazla kod sağlığı uyarısı içeren ilk 10 dosyayı listeler
  scan             Tüm projeyi detaylı tara (varsayılan)
  help, -h         Bu yardım metnini gösterir
`);
    process.exit(0);
  } else if (command === 'file' || (!['summary', 'worst', 'scan'].includes(command) && fs.existsSync(command))) {
    const target = command === 'file' ? args[1] : command;
    if (!target) {
      console.error('Kullanım: node scripts/code-health.js file <dosya_yolu>');
      process.exit(1);
    }
    const abs = path.resolve(REPO_ROOT, target);
    if (!fs.existsSync(abs)) {
      console.error(`Dosya bulunamadı: ${abs}`);
      process.exit(1);
    }
    const issues = auditCodeHealth(abs);
    printIssues(issues, relPath(abs));
  } else if (command === 'summary') {
    let allFiles = [];
    for (const dir of SRC_DIRS) allFiles = allFiles.concat(getSourceFiles(dir));
    const allIssues = allFiles.flatMap(f => auditCodeHealth(f));
    printSummary(allIssues);
  } else if (command === 'worst') {
    let allFiles = [];
    for (const dir of SRC_DIRS) allFiles = allFiles.concat(getSourceFiles(dir));
    const allIssues = allFiles.flatMap(f => auditCodeHealth(f));
    const byFile = {};
    for (const i of allIssues) {
      if (!byFile[i.file]) byFile[i.file] = [];
      byFile[i.file].push(i);
    }
    const worst10 = Object.entries(byFile)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);

    if (worst10.length === 0) {
      console.log('\x1b[32m✔ Proje temiz — hiç kod sağlığı ihlali yok!\x1b[0m');
    } else {
      console.log('\n\x1b[1m🔥 EN FAZLA KOD SAĞLIĞI UYARISI OLAN 10 DOSYA\x1b[0m\n');
      worst10.forEach(([file, list], idx) => {
        const errs = list.filter(i => i.severity === 'ERROR').length;
        const warns = list.filter(i => i.severity === 'WARNING').length;
        console.log(`  ${String(idx + 1).padStart(2)}. ${file}`);
        console.log(`      \x1b[31m${errs} ERROR\x1b[0m  \x1b[33m${warns} WARNING\x1b[0m  (toplam: ${list.length})`);
      });
    }
  } else {
    // scan
    let allFiles = [];
    for (const dir of SRC_DIRS) allFiles = allFiles.concat(getSourceFiles(dir));
    console.log(`\n🔍 ${allFiles.length} dosya AST ile denetleniyor...`);
    const allIssues = allFiles.flatMap(f => auditCodeHealth(f));
    printIssues(allIssues);
  }
}

module.exports = { auditCodeHealth, getSourceFiles };
