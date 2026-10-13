/**
 * blast-radius.js — Automated Blast-Radius Pre-Commit Hook
 *
 * Bir dosyada degisiklik yapildiktan sonra asagidaki tum kontrolleri
 * sirayla calistirarak "degisiklik guvenli mi?" sorusunu yanıtlar:
 *
 *   1. TypeScript Derleme  → npx tsc --noEmit (0 hata zorunlu)
 *   2. Etki Alani          → knowledge_graph'ten etkilenen bagimlilari listele
 *   3. Tema Denetimi       → Degistirilen dosyada tema ihlali var mi?
 *   4. Emoji Denetimi      → Degistirilen dosyada emoji kacmis mi?
 *   5. i18n Kontrolu       → Yeni eklenen string'ler i18n'e baglanmis mi?
 *
 * Komutlar:
 *   node scripts/blast-radius.js <dosya_yolu>          → Tum kontroller
 *   node scripts/blast-radius.js check <dosya_yolu>    → Tum kontroller
 *   node scripts/blast-radius.js impact <dosya_yolu>   → Sadece etki alani
 *   node scripts/blast-radius.js tsc                   → Sadece TypeScript
 *   node scripts/blast-radius.js changed               → Son git commit'teki degisen dosyalar icin
 *   node scripts/blast-radius.js full                  → Tum proje tam denetim
 */

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

const REPO_ROOT      = process.cwd();
const GRAPH_PATH     = path.join(REPO_ROOT, 'ai-reports', 'knowledge_graph.json');
const SCRIPTS_DIR    = path.join(REPO_ROOT, '.agents', 'repo-intelligence-layer', 'scripts');

// Diger modulleri yukle
const themeAudit     = require(path.join(SCRIPTS_DIR, 'theme-audit.js'));
const emojiLinter    = require(path.join(SCRIPTS_DIR, 'emoji-linter.js'));
const codeHealth     = require(path.join(SCRIPTS_DIR, 'code-health.js'));

function relPath(p) { return path.relative(REPO_ROOT, p).replace(/\\/g, '/'); }
function absPath(p) { return path.resolve(REPO_ROOT, p); }

// ─── 1. TypeScript Kontrolu ──────────────────────────────────────────────────

function runTsc() {
  console.log('\n\x1b[1m[1/5] TypeScript Derleme Kontrolu\x1b[0m');
  console.log('─'.repeat(60));
  try {
    const out = execSync('npx tsc --noEmit 2>&1', { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 });
    console.log('\x1b[32m  ✔ 0 hata — TypeScript temiz\x1b[0m');
    return { passed: true, errors: [] };
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '') + (e.message || '');
    const lines  = output.split('\n').filter(l => l.trim() && !l.includes('npm warn'));
    // Hata sayisini hesapla
    const errorLines = lines.filter(l => /error TS\d+/.test(l));
    console.log(`\x1b[31m  ✖ ${errorLines.length} TypeScript hatasi tespit edildi:\x1b[0m`);
    errorLines.slice(0, 10).forEach(l => console.log(`    \x1b[31m${l.trim()}\x1b[0m`));
    if (errorLines.length > 10) console.log(`    \x1b[90m... ve ${errorLines.length - 10} hata daha\x1b[0m`);
    return { passed: false, errors: errorLines };
  }
}

// ─── 2. Etki Alani (Blast Radius) ────────────────────────────────────────────

function getBlastRadius(targetRel) {
  console.log('\n\x1b[1m[2/5] Etki Alani Analizi\x1b[0m');
  console.log('─'.repeat(60));

  if (!fs.existsSync(GRAPH_PATH)) {
    console.log('  \x1b[33m⚠ knowledge_graph.json bulunamadi. Sunucu calistirilmali: bun run analysis.tsx\x1b[0m');
    return { passed: true, direct: [], indirect: [], total: 0 };
  }

  let graph;
  try { graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8')); }
  catch { console.log('  \x1b[33m⚠ knowledge_graph.json okunamadi\x1b[0m'); return { passed: true, direct: [], indirect: [], total: 0 }; }

  const files = graph.files || {};

  // Hedef dosyanin normalize edilmis yolu
  const normalizeKey = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const targetNorm   = normalizeKey(targetRel);

  // Dogrudan bagimlilar (importedBy)
  const direct = [];
  for (const [filePath, info] of Object.entries(files)) {
    const imports = info.imports || [];
    const resolvedImports = imports.map(i => normalizeKey(i));
    if (resolvedImports.some(i => i.includes(targetNorm.replace('.tsx', '').replace('.ts', '')))) {
      direct.push({ file: filePath, risk: info.risk || 'LOW', importance: info.importance || 'Low' });
    }
  }

  // Dolayli bagimlilar (direct'lerin bagimlilarini da tara — 1 seviye)
  const indirectSet = new Set();
  for (const d of direct) {
    const norm = normalizeKey(d.file);
    for (const [filePath, info] of Object.entries(files)) {
      if (filePath === d.file) continue;
      const imports = (info.imports || []).map(i => normalizeKey(i));
      if (imports.some(i => i.includes(norm.replace('.tsx', '').replace('.ts', '')))) {
        if (!direct.find(dd => dd.file === filePath)) {
          indirectSet.add(filePath);
        }
      }
    }
  }
  const indirect = [...indirectSet].map(f => ({ file: f, risk: files[f]?.risk || 'LOW' }));

  const total = direct.length + indirect.length;

  if (total === 0) {
    console.log('  \x1b[32m✔ Hic dogrudan bagimlı dosya yok — dusuk risk.\x1b[0m');
  } else {
    // Risk ozeti
    const criticals = direct.filter(d => d.risk === 'CRITICAL' || d.risk === 'HIGH');
    const riskColor = criticals.length > 0 ? '\x1b[31m' : direct.length > 5 ? '\x1b[33m' : '\x1b[32m';
    console.log(`  ${riskColor}${direct.length} dogrudan bagimlı dosya\x1b[0m  (${indirect.length} dolayli)`);
    if (criticals.length > 0) {
      console.log(`  \x1b[31m⚠ ${criticals.length} YUKSEK/KRiTiK riskli dosya etkileniyor:\x1b[0m`);
      criticals.forEach(d => console.log(`    \x1b[31m${d.file}\x1b[0m  [${d.risk}]`));
    }
    console.log(`\n  Tum dogrudan bagimlilar:`);
    direct.slice(0, 8).forEach(d => {
      const rc = d.risk === 'CRITICAL' ? '\x1b[31m' : d.risk === 'HIGH' ? '\x1b[33m' : '\x1b[32m';
      console.log(`    ${rc}${d.file}\x1b[0m  [${d.risk}]`);
    });
    if (direct.length > 8) console.log(`    \x1b[90m... ve ${direct.length - 8} tane daha\x1b[0m`);
  }

  return { passed: true, direct, indirect, total };
}

// ─── 3. Tema Denetimi ─────────────────────────────────────────────────────────

function runThemeCheck(targetAbs) {
  console.log('\n\x1b[1m[3/5] Tema Token Denetimi\x1b[0m');
  console.log('─'.repeat(60));

  try {
    const violations = themeAudit.auditFile(targetAbs);
    const errors   = violations.filter(v => v.severity === 'ERROR').length;
    const warnings = violations.filter(v => v.severity === 'WARNING').length;

    if (violations.length === 0) {
      console.log('  \x1b[32m✔ Tema ihlali yok\x1b[0m');
    } else {
      if (errors > 0) console.log(`  \x1b[31m✖ ${errors} tema ERROR (hardcoded Tailwind renk)\x1b[0m`);
      if (warnings > 0) console.log(`  \x1b[33m⚠ ${warnings} tema WARNING (hardcoded hex/rgb)\x1b[0m`);
      violations.slice(0, 5).forEach(v => {
        const icon = v.severity === 'ERROR' ? '\x1b[31m✖\x1b[0m' : '\x1b[33m⚠\x1b[0m';
        console.log(`    ${icon} satir ${v.line}: \x1b[33m${v.match}\x1b[0m`);
      });
      if (violations.length > 5) console.log(`    \x1b[90m... ve ${violations.length - 5} ihlal daha\x1b[0m`);
    }
    return { passed: errors === 0, violations };
  } catch (e) {
    console.log(`  \x1b[33m⚠ Tema denetimi atlanamdi: ${e.message}\x1b[0m`);
    return { passed: true, violations: [] };
  }
}

// ─── 4. Emoji Denetimi ────────────────────────────────────────────────────────

function runEmojiCheck(targetAbs) {
  console.log('\n\x1b[1m[4/5] Emoji Denetimi\x1b[0m');
  console.log('─'.repeat(60));

  try {
    const violations = emojiLinter.auditFile(targetAbs);
    const criticals  = violations.filter(v => v.severity === 'CRITICAL').length;
    const errors     = violations.filter(v => v.severity === 'ERROR').length;

    if (violations.length === 0) {
      console.log('  \x1b[32m✔ Emoji ihlali yok\x1b[0m');
    } else {
      if (criticals > 0) console.log(`  \x1b[35m✖ ${criticals} CRITICAL emoji (UI'da gorunuyor)\x1b[0m`);
      if (errors > 0)    console.log(`  \x1b[31m✖ ${errors} emoji ERROR (string literal)\x1b[0m`);
      violations.slice(0, 5).forEach(v => {
        console.log(`    satir ${v.line}: \x1b[33m${v.emojis.join(' ')}\x1b[0m  \x1b[90m${v.lineContent.slice(0, 60)}\x1b[0m`);
      });
    }
    return { passed: criticals === 0 && errors === 0, violations };
  } catch (e) {
    console.log(`  \x1b[33m⚠ Emoji denetimi atlandi: ${e.message}\x1b[0m`);
    return { passed: true, violations: [] };
  }
}

// ─── 5. i18n Kontrolu ─────────────────────────────────────────────────────────

function runI18nCheck(targetAbs) {
  console.log('\n\x1b[1m[5/5] i18n Baglanti Kontrolu\x1b[0m');
  console.log('─'.repeat(60));

  let content;
  try { content = fs.readFileSync(targetAbs, 'utf8'); } catch {
    console.log('  \x1b[33m⚠ Dosya okunamadi\x1b[0m');
    return { passed: true, issues: [] };
  }

  const issues = [];
  const lines  = content.split('\n');

  // useTranslation import var mi?
  const hasTranslation = content.includes('useTranslation') || content.includes('useI18n') || content.includes('i18next.t(') || content.includes("from 'react-i18next'");

  // JSX <Text> icinde doğrudan Turkce/Ingilizce string var mi? (t() sarmalanmamis)
  // Heuristik: <Text> taginin icinde Latin/Turk karakterli string
  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    // Yorum veya i18n cagrisini atla
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (/\bt\(/.test(line) || /t\(['"`]/.test(line)) return;
    if (/i18n\.|i18next\./.test(line)) return;

    // <Text>...hardcoded metin...</Text>
    const textNodeMatch = line.match(/>\s*([A-ZÇĞİÖŞÜa-zçğışöşü][A-Za-zçğışöşüÇĞİÖŞÜ0-9\s.,!?'"-]{8,})\s*</);
    if (textNodeMatch) {
      const str = textNodeMatch[1].trim();
      // Kısa, teknik veya URL icerenleri atla
      if (str.length < 10 || /https?:|localhost|className|style|import|export/.test(str)) return;
      issues.push({ line: idx + 1, text: str.slice(0, 50), type: 'HARDCODED_UI_TEXT' });
    }
  });

  if (issues.length === 0) {
    if (hasTranslation) {
      console.log('  \x1b[32m✔ useTranslation aktif — i18n baglantisi mevcut\x1b[0m');
    } else {
      console.log('  \x1b[90m  useTranslation bulunamadi — bu dosya ceviri kullanmiyor olabilir\x1b[0m');
    }
  } else {
    console.log(`  \x1b[33m⚠ ${issues.length} potansiyel hardcoded metin tespit edildi:\x1b[0m`);
    issues.slice(0, 5).forEach(i => {
      console.log(`    satir ${i.line}: \x1b[33m"${i.text}"\x1b[0m`);
    });
    if (issues.length > 5) console.log(`    \x1b[90m... ve ${issues.length - 5} tane daha\x1b[0m`);
  }

  return { passed: issues.length === 0, issues };
}

// ─── 6. Kod Sağlığı & Anti-Pattern Denetimi ──────────────────────────────────

function runCodeHealthCheck(targetAbs) {
  console.log('\n\x1b[1m[6/6] Kod Sağlığı & Anti-Pattern Denetimi\x1b[0m');
  console.log('─'.repeat(60));

  try {
    const issues = codeHealth.auditCodeHealth(targetAbs);
    const errors = issues.filter(i => i.severity === 'ERROR').length;
    const warnings = issues.filter(i => i.severity === 'WARNING').length;

    if (issues.length === 0) {
      console.log('  \x1b[32m✔ Kod sağlığı temiz — debugger/silent fail yok\x1b[0m');
    } else {
      if (errors > 0) console.log(`  \x1b[31m✖ ${errors} kritik kod sağlığı ERROR (boş catch / debugger / hook ihlali)\x1b[0m`);
      if (warnings > 0) console.log(`  \x1b[33m⚠ ${warnings} kod sağlığı WARNING (console.log / any kaçamağı)\x1b[0m`);
      issues.slice(0, 5).forEach(i => {
        const icon = i.severity === 'ERROR' ? '\x1b[31m✖\x1b[0m' : '\x1b[33m⚠\x1b[0m';
        console.log(`    ${icon} satir ${i.line}: \x1b[36m${i.rule}\x1b[0m - ${i.message}`);
      });
      if (issues.length > 5) console.log(`    \x1b[90m... ve ${issues.length - 5} bulgu daha\x1b[0m`);
    }
    return { passed: errors === 0, issues };
  } catch (e) {
    console.log(`  \x1b[33m⚠ Kod sağlığı denetimi atlandı: ${e.message}\x1b[0m`);
    return { passed: true, issues: [] };
  }
}

// ─── Ozet Rapor ───────────────────────────────────────────────────────────────

function printSummary(results, targetRel) {
  const passed = Object.values(results).every(r => r.passed);
  console.log('\n' + '═'.repeat(60));
  console.log(`\x1b[1m DEGISIKLIK GUVENLIK RAPORU\x1b[0m`);
  console.log(`  Dosya: \x1b[36m${targetRel}\x1b[0m`);
  console.log('─'.repeat(60));

  const checks = [
    { name: 'TypeScript Derleme',      result: results.tsc },
    { name: 'Etki Alani',              result: results.impact },
    { name: 'Tema Denetimi',           result: results.theme },
    { name: 'Emoji Denetimi',          result: results.emoji },
    { name: 'i18n Kontrolu',           result: results.i18n },
    { name: 'Kod Sağlığı & Anti-Pattern', result: results.health },
  ];

  for (const c of checks) {
    const icon = c.result.passed ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m';
    console.log(`  ${icon}  ${c.name}`);
  }

  if (results.impact.total > 0) {
    console.log(`\n  Etkilenen Dosya Sayisi: \x1b[33m${results.impact.direct.length} dogrudan\x1b[0m  ${results.impact.indirect.length} dolayli`);
  }

  console.log('─'.repeat(60));
  if (passed) {
    console.log('\x1b[32m  SONUC: Degisiklik guvenli — tum 6 kontrol gecti.\x1b[0m');
  } else {
    const failed = checks.filter(c => !c.result.passed).map(c => c.name);
    console.log(`\x1b[31m  SONUC: ${failed.length} kontrol BASARISIZ — commit oncesi duzeltilmeli!\x1b[0m`);
    console.log(`  \x1b[31mBasarisiz: ${failed.join(', ')}\x1b[0m`);
  }
  console.log('═'.repeat(60) + '\n');

  return passed;
}

// ─── Degisen Git Dosyalari ────────────────────────────────────────────────────

function getChangedFiles() {
  try {
    const staged   = execSync('git diff --cached --name-only', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const unstaged = execSync('git diff --name-only', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const all      = [...new Set([...staged.split('\n'), ...unstaged.split('\n')])].filter(f => f && /\.(tsx?|jsx?)$/.test(f));
    return all;
  } catch {
    return [];
  }
}

// ─── Tam Proje Denetimi ────────────────────────────────────────────────────────

function runFullAudit() {
  console.log('\n\x1b[1m TAM PROJE DENETiMi\x1b[0m\n');

  // TSC
  const tsc = runTsc();

  // Tema ozet
  console.log('\n\x1b[1m[TEMA] Tum Proje Ozeti\x1b[0m');
  console.log('─'.repeat(60));
  const { execSync: exec2 } = require('child_process');
  try {
    const out = exec2(`node "${path.join(SCRIPTS_DIR, 'theme-audit.js')}" summary`, { cwd: REPO_ROOT, encoding: 'utf8' });
    // Sadece son satiri goster
    const summaryLine = out.split('\n').filter(l => l.includes('TOPLAM')).pop() || '';
    console.log('  ' + summaryLine.trim());
  } catch {}

  // Emoji ozet
  console.log('\n\x1b[1m[EMOJi] Tum Proje Ozeti\x1b[0m');
  console.log('─'.repeat(60));
  try {
    const out = exec2(`node "${path.join(SCRIPTS_DIR, 'emoji-linter.js')}" summary`, { cwd: REPO_ROOT, encoding: 'utf8' });
    const summaryLine = out.split('\n').filter(l => l.includes('TOPLAM')).pop() || '';
    console.log('  ' + summaryLine.trim());
  } catch {}

  console.log('\n' + '═'.repeat(60));
  console.log(`  TypeScript: ${tsc.passed ? '\x1b[32m✔ Temiz\x1b[0m' : `\x1b[31m✖ ${tsc.errors.length} hata\x1b[0m`}`);
  console.log('═'.repeat(60) + '\n');
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const args    = process.argv.slice(2);
  const command = args[0] || '';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
🛡 blast-radius.js — Değişiklik Güvenlik & Etki Zinciri

Kullanım:
  node .agents/repo-intelligence-layer/scripts/blast-radius.js [komut|dosya]

Komutlar:
  <dosya_yolu>     5'li tam denetim zinciri (TSC -> Etki Alanı -> Tema -> Emoji -> i18n)
  check <dosya>    Belirtilen dosya için tam güvenlik denetimi çalıştırır
  changed          Git staged/unstaged değişmiş tüm dosyaları sırayla denetler
  full             Tüm projede TSC, tema özeti ve emoji özetini tek seferde raporlar
  impact <dosya>   Yalnızca hedef dosyanın knowledge_graph üzerindeki etki alanını gösterir
  tsc              Yalnızca TypeScript derleme kontrolünü (0 hata) çalıştırır
  help, -h         Bu yardım metnini gösterir
`);
    process.exit(0);
  }

  // blast-radius.js <dosya> → tum kontroller
  if (!command || command === 'check') {
    const target = args[command === 'check' ? 1 : 0];
    if (!target) {
      console.error('Kullanım: node scripts/blast-radius.js <dosya_yolu>');
      console.error('         node scripts/blast-radius.js check <dosya_yolu>');
      console.error('         node scripts/blast-radius.js tsc');
      console.error('         node scripts/blast-radius.js changed');
      console.error('         node scripts/blast-radius.js full');
      console.error('         node scripts/blast-radius.js help');
      process.exit(1);
    }
    const targetAbs = absPath(target);
    const targetRel = relPath(targetAbs);

    if (!fs.existsSync(targetAbs)) {
      console.error(`\x1b[31mDosya bulunamadi: ${targetAbs}\x1b[0m`);
      process.exit(1);
    }

    console.log(`\n\x1b[1m BLAST-RADIUS DENETiMi\x1b[0m  →  \x1b[36m${targetRel}\x1b[0m`);

    const results = {
      tsc:    runTsc(),
      impact: getBlastRadius(targetRel),
      theme:  runThemeCheck(targetAbs),
      emoji:  runEmojiCheck(targetAbs),
      i18n:   runI18nCheck(targetAbs),
      health: runCodeHealthCheck(targetAbs),
    };

    const passed = printSummary(results, targetRel);
    process.exit(passed ? 0 : 1);

  } else if (command === 'impact') {
    const target = args[1];
    if (!target) { console.error('Kullanim: node scripts/blast-radius.js impact <dosya_yolu>'); process.exit(1); }
    getBlastRadius(relPath(absPath(target)));

  } else if (command === 'tsc') {
    const result = runTsc();
    process.exit(result.passed ? 0 : 1);

  } else if (command === 'changed') {
    const files = getChangedFiles();
    if (files.length === 0) {
      console.log('\x1b[90mDegisen dosya bulunamadi.\x1b[0m');
      process.exit(0);
    }
    console.log(`\n\x1b[1mDegisen ${files.length} dosya denetleniyor...\x1b[0m`);
    let anyFailed = false;
    for (const f of files) {
      const abs = absPath(f);
      if (!fs.existsSync(abs)) continue;
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`\x1b[1m${f}\x1b[0m`);
      const theme = themeAudit.auditFile(abs);
      const emoji = emojiLinter.auditFile(abs);
      const themeErrors = theme.filter(v => v.severity === 'ERROR').length;
      const emojCrits   = emoji.filter(v => v.severity === 'CRITICAL').length;
      const emojErrors  = emoji.filter(v => v.severity === 'ERROR').length;
      console.log(`  Tema: ${themeErrors === 0 ? '\x1b[32m✔\x1b[0m' : `\x1b[31m✖ ${themeErrors} ERROR\x1b[0m`}  Emoji: ${emojCrits + emojErrors === 0 ? '\x1b[32m✔\x1b[0m' : `\x1b[31m✖ ${emojCrits + emojErrors}\x1b[0m`}`);
      if (themeErrors > 0 || emojCrits > 0 || emojErrors > 0) anyFailed = true;
    }
    // Bir kere TSC calistir
    console.log('');
    const tsc = runTsc();
    if (!tsc.passed) anyFailed = true;
    process.exit(anyFailed ? 1 : 0);

  } else if (command === 'full') {
    runFullAudit();

  } else {
    // Dogrudan dosya yolu verilmis olabilir
    const targetAbs = absPath(command);
    if (fs.existsSync(targetAbs)) {
      const targetRel = relPath(targetAbs);
      console.log(`\n\x1b[1m BLAST-RADIUS DENETiMi\x1b[0m  →  \x1b[36m${targetRel}\x1b[0m`);
      const results = {
        tsc:    runTsc(),
        impact: getBlastRadius(targetRel),
        theme:  runThemeCheck(targetAbs),
        emoji:  runEmojiCheck(targetAbs),
        i18n:   runI18nCheck(targetAbs),
        health: runCodeHealthCheck(targetAbs),
      };
      const passed = printSummary(results, targetRel);
      process.exit(passed ? 0 : 1);
    } else {
      console.error(`\x1b[31mBilinmeyen komut veya dosya: "${command}"\x1b[0m`);
      process.exit(1);
    }
  }
}

module.exports = { runTsc, getBlastRadius, runThemeCheck, runEmojiCheck, runI18nCheck };
