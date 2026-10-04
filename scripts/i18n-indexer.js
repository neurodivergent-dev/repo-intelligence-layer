const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const LOCALES_DIR = path.join(REPO_ROOT, 'src', 'i18n', 'locales');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const OUTPUT_INDEX_PATH = path.join(REPO_ROOT, 'ai-reports', 'i18n_index.json');

// Türkçe karakter & aksan normalizasyonu (ı/i eşleşmesi dahil)
function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Nested JSON objesini 'a.b.c' biçiminde düzleştirme
function flattenObject(obj, prefix = '') {
  let result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, fullKey));
    } else if (typeof value === 'string') {
      result[fullKey] = value;
    }
  }
  return result;
}

// Projedeki tüm .ts / .tsx dosyalarını bulma
function getSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      if (file.name !== 'node_modules' && file.name !== '.expo') {
        getSourceFiles(fullPath, fileList);
      }
    } else if (/\.(tsx|ts|jsx|js)$/.test(file.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// Dosyalardaki tüm string literalleri ve satır numaralarını regex ile çıkarma
function extractStringLiterals(content) {
  const lines = content.split('\n');
  const found = [];
  // Tek tırnak, çift tırnak veya backtick içindeki olası i18n anahtarları
  const stringRegex = /['"`]([a-zA-Z0-9_\-.]+)['"`]/g;

  lines.forEach((line, lineIndex) => {
    let match;
    while ((match = stringRegex.exec(line)) !== null) {
      found.push({
        value: match[1],
        line: lineIndex + 1
      });
    }
  });

  return found;
}

// Ana İndeksleme Fonksiyonu
function buildI18nIndex() {
  const startTime = Date.now();

  if (!fs.existsSync(LOCALES_DIR)) {
    console.error(`❌ Locales dizini bulunamadı: ${LOCALES_DIR}`);
    return null;
  }

  // 1. Locale dosyalarını oku ve düzleştir
  const localeFiles = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
  const translations = {}; // { 'sos.nonVerbal': { tr: '...', en: '...' } }
  const knownKeysSet = new Set();

  localeFiles.forEach(file => {
    const lang = path.basename(file, '.json');
    const filePath = path.join(LOCALES_DIR, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const flat = flattenObject(raw);
      for (const [key, value] of Object.entries(flat)) {
        knownKeysSet.add(key);
        if (!translations[key]) {
          translations[key] = { values: {}, usedIn: [] };
        }
        translations[key].values[lang] = value;
      }
    } catch (e) {
      console.warn(`⚠️ Locale dosyası okunamadı: ${file}`, e.message);
    }
  });

  // 2. Kaynak dosyaları tara ve bilinen anahtarları eşle
  const sourceFiles = getSourceFiles(SRC_DIR);
  const keyUsageMap = new Map(); // key -> Map(relPath -> Set(lines))

  sourceFiles.forEach(absPath => {
    const relPath = path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    const content = fs.readFileSync(absPath, 'utf8');
    const literals = extractStringLiterals(content);

    literals.forEach(({ value, line }) => {
      if (knownKeysSet.has(value)) {
        if (!keyUsageMap.has(value)) {
          keyUsageMap.set(value, new Map());
        }
        const fileMap = keyUsageMap.get(value);
        if (!fileMap.has(relPath)) {
          fileMap.set(relPath, new Set());
        }
        fileMap.get(relPath).add(line);
      }
    });
  });

  // 3. İndeks veri modelini oluştur
  for (const [key, fileMap] of keyUsageMap.entries()) {
    if (translations[key]) {
      const usedInList = [];
      for (const [file, linesSet] of fileMap.entries()) {
        usedInList.push({
          file,
          lines: Array.from(linesSet).sort((a, b) => a - b)
        });
      }
      translations[key].usedIn = usedInList;
    }
  }

  const indexData = {
    generatedAt: Date.now(),
    totalKeys: Object.keys(translations).length,
    totalFilesScanned: sourceFiles.length,
    translations
  };

  const reportsDir = path.dirname(OUTPUT_INDEX_PATH);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_INDEX_PATH, JSON.stringify(indexData, null, 2), 'utf8');
  const elapsed = Date.now() - startTime;
  return { indexData, elapsed };
}

function isIndexStale() {
  if (!fs.existsSync(OUTPUT_INDEX_PATH)) return true;
  const indexMtime = fs.statSync(OUTPUT_INDEX_PATH).mtimeMs;

  // 1. Locales dizinini kontrol et
  if (fs.existsSync(LOCALES_DIR)) {
    const localeFiles = fs.readdirSync(LOCALES_DIR);
    for (const file of localeFiles) {
      const full = path.join(LOCALES_DIR, file);
      if (fs.statSync(full).mtimeMs > indexMtime) return true;
    }
  }

  // 2. Src dizinindeki en son değiştirilen dosyalara bak
  function checkStaleDir(dir) {
    if (!fs.existsSync(dir)) return false;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.expo') {
          if (checkStaleDir(full)) return true;
        }
      } else if (/\.(tsx|ts|jsx|js|json)$/.test(entry.name)) {
        if (fs.statSync(full).mtimeMs > indexMtime) return true;
      }
    }
    return false;
  }

  return checkStaleDir(SRC_DIR);
}

// CLI Sorgu Arayüzü
function queryI18n(searchTerm) {
  let indexData;
  if (isIndexStale()) {
    const res = buildI18nIndex();
    if (!res) return;
    indexData = res.indexData;
  } else {
    indexData = JSON.parse(fs.readFileSync(OUTPUT_INDEX_PATH, 'utf8'));
  }

  if (!searchTerm || !searchTerm.trim()) {
    console.log(`ℹ️ Toplam ${indexData.totalKeys} i18n anahtarı indekslenmiş.`);
    console.log('Kullanım: node i18n-indexer.js query <aranacak_kelime_veya_anahtar>');
    return;
  }

  const normQuery = normalizeText(searchTerm);
  const results = [];

  for (const [key, data] of Object.entries(indexData.translations)) {
    const normKey = normalizeText(key);
    let matched = false;
    let matchField = '';

    if (normKey.includes(normQuery)) {
      matched = true;
      matchField = `anahtar (${key})`;
    } else {
      for (const [lang, val] of Object.entries(data.values)) {
        if (normalizeText(val).includes(normQuery)) {
          matched = true;
          matchField = `${lang.toUpperCase()} değeri ("${val}")`;
          break;
        }
      }
    }

    if (matched) {
      results.push({ key, data, matchField });
    }
  }

  if (results.length === 0) {
    console.log(`❌ "${searchTerm}" için eşleşen i18n anahtarı veya çeviri bulunamadı.`);
    return;
  }

  console.log(`\n🔍 "${searchTerm}" için ${results.length} eşleşme bulundu:\n`);
  results.slice(0, 10).forEach(({ key, data, matchField }) => {
    console.log(`────────────────────────────────────────────────────────`);
    console.log(`🔑 Anahtar: \x1b[36m${key}\x1b[0m  (Eşleşme: ${matchField})`);
    
    const trVal = data.values['tr'] ? `🇹🇷 TR: "${data.values['tr']}"` : '';
    const enVal = data.values['en'] ? `🇬🇧 EN: "${data.values['en']}"` : '';
    if (trVal) console.log(`   ${trVal}`);
    if (enVal) console.log(`   ${enVal}`);

    if (data.usedIn && data.usedIn.length > 0) {
      console.log(`   📄 Kullanılan Dosyalar (${data.usedIn.length}):`);
      data.usedIn.forEach(u => {
        console.log(`      • \x1b[32m${u.file}:${u.lines.join(',')}\x1b[0m`);
      });
    } else {
      console.log(`   ⚪ Kod içinde doğrudan kullanım tespit edilmedi.`);
    }
  });
  console.log(`────────────────────────────────────────────────────────\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'build';

  if (command === 'build' || command === 'index') {
    console.log('⚡ i18n İndeksi oluşturuluyor...');
    const res = buildI18nIndex();
    if (res) {
      console.log(`✅ ${res.indexData.totalKeys} anahtar, ${res.indexData.totalFilesScanned} dosya ${res.elapsed}ms içinde indekslendi.`);
      console.log(`📁 Kayıt yeri: ${OUTPUT_INDEX_PATH}`);
    }
  } else if (command === 'query' || command === 'find') {
    const queryTerm = args.slice(1).join(' ');
    queryI18n(queryTerm);
  } else {
    // Direkt terim arandıysa
    queryI18n(args.join(' '));
  }
}

module.exports = { buildI18nIndex, queryI18n };
