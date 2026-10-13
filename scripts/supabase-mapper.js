/**
 * supabase-mapper.js — Supabase Schema & RPC Mapper
 *
 * Projedeki tüm Supabase servis dosyalarini, migration SQL'lerini ve
 * types.ts dosyalarini tarayarak:
 *   - Hangi tablolarin kullanildigini (.from('table') cagrilari)
 *   - Hangi kolonlarin sorgulandigini (.select, .eq, .order)
 *   - Hangi RPC fonksiyonlarinin cagrildigini (.rpc('func'))
 *   - Her tablonun hangi servis/screen dosyasindan kullanildigini
 *   - SQL migration'lardan kolon ve RLS policy bilgilerini
 * indeksler ve rapor eder.
 *
 * Komutlar:
 *   node scripts/supabase-mapper.js              → Tüm tablo haritasi
 *   node scripts/supabase-mapper.js map          → Tüm tablo haritasi
 *   node scripts/supabase-mapper.js table <name> → Tek tablo detayi
 *   node scripts/supabase-mapper.js rpc          → Tüm RPC cagrilari
 *   node scripts/supabase-mapper.js who <table>  → Bu tabloyu kim kullaniyor?
 *   node scripts/supabase-mapper.js migrations   → SQL migration'lari listele
 *   node scripts/supabase-mapper.js types <svc>  → Servis'in TypeScript tiplerini özetle
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT      = process.cwd();
const SRC_DIR        = path.join(REPO_ROOT, 'src');
const CMS_DIR        = path.join(REPO_ROOT, 'cms', 'src');
const MIGRATION_DIR  = path.join(REPO_ROOT, 'supabase', 'migrations');
const SERVICES_DIR   = path.join(SRC_DIR, 'services');
const CACHE_PATH     = path.join(REPO_ROOT, 'ai-reports', 'supabase_map.json');

// ─── Dosya Toplama ────────────────────────────────────────────────────────────

function getFiles(dir, ext = /\.(tsx?|jsx?)$/, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.expo', '.next', 'dist', 'ai-reports'].includes(entry.name)) continue;
      getFiles(full, ext, fileList);
    } else if (ext.test(entry.name)) {
      fileList.push(full);
    }
  }
  return fileList;
}

function relPath(p) { return path.relative(REPO_ROOT, p).replace(/\\/g, '/'); }

// ─── .from('table') ve .rpc('func') Tarama ──────────────────────────────────

function parseSupabaseCalls(files) {
  // { tableName: { usedIn: [{file, line, ops:[]}], columns: Set, filters: Set } }
  const tables = {};
  // { rpcName: [{file, line, args}] }
  const rpcs   = {};

  for (const absPath of files) {
    const rel = relPath(absPath);
    let content;
    try { content = fs.readFileSync(absPath, 'utf8'); } catch { continue; }
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      const lineNo = idx + 1;

      // .from('table_name') veya .from("table_name")
      const fromMatches = [...line.matchAll(/\.from\(['"`]([a-z_A-Z][a-z_A-Z0-9]*?)['"`]\)/g)];
      for (const m of fromMatches) {
        const table = m[1];
        if (!tables[table]) tables[table] = { usedIn: [], columns: new Set(), filters: new Set(), operations: new Set() };
        // Zaten bu dosya ve satir eklenmemisse ekle
        const existing = tables[table].usedIn.find(u => u.file === rel && u.line === lineNo);
        if (!existing) tables[table].usedIn.push({ file: rel, line: lineNo });

        // Ayni satirda/cevredeki operasyonlari yakala
        if (/\.select\(/.test(line)) tables[table].operations.add('SELECT');
        if (/\.insert\(/.test(line)) tables[table].operations.add('INSERT');
        if (/\.update\(/.test(line)) tables[table].operations.add('UPDATE');
        if (/\.delete\(/.test(line)) tables[table].operations.add('DELETE');
        if (/\.upsert\(/.test(line)) tables[table].operations.add('UPSERT');

        // .eq('column', ...) filtre kolonlarini topla
        const eqMatches = [...line.matchAll(/\.eq\(['"`]([a-z_A-Z][a-z_A-Z0-9]*?)['"`]/g)];
        for (const eq of eqMatches) tables[table].filters.add(eq[1]);

        // .select('col1, col2, ...') kolon listelerini topla
        const selectMatch = line.match(/\.select\(['"`]([^'"`*]+?)['"`]\)/);
        if (selectMatch) {
          for (const col of selectMatch[1].split(',')) {
            const c = col.trim().split('(')[0].trim(); // ilişki notasyonunu temizle
            if (c && !c.includes(' ') && c !== '*') tables[table].columns.add(c);
          }
        }
      }

      // .rpc('function_name', { ...args })
      const rpcMatches = [...line.matchAll(/\.rpc\(['"`]([a-z_A-Z][a-z_A-Z0-9]*?)['"`]/g)];
      for (const m of rpcMatches) {
        const fn = m[1];
        if (!rpcs[fn]) rpcs[fn] = [];
        rpcs[fn].push({ file: rel, line: lineNo });
      }
    });
  }

  // Set'leri diziye cevir
  for (const t of Object.values(tables)) {
    t.columns    = [...t.columns];
    t.filters    = [...t.filters];
    t.operations = [...t.operations];
  }

  return { tables, rpcs };
}

// ─── SQL Migration Parse ──────────────────────────────────────────────────────

function parseMigrations() {
  const migrations = [];
  if (!fs.existsSync(MIGRATION_DIR)) return migrations;

  const files = fs.readdirSync(MIGRATION_DIR).filter(f => f.endsWith('.sql'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');
    const tables = [];

    // CREATE TABLE ...
    const tableMatches = [...content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_A-Z][a-z_A-Z0-9]*)\s*\(([^;]+)\)/gis)];
    for (const m of tableMatches) {
      const tableName = m[1];
      const body = m[2];

      // Kolonlari parse et
      const columns = [];
      for (const colLine of body.split('\n')) {
        const cl = colLine.trim();
        if (!cl || cl.startsWith('--') || cl.startsWith('CONSTRAINT') ||
            cl.startsWith('PRIMARY') || cl.startsWith('FOREIGN') ||
            cl.startsWith('UNIQUE') || cl.startsWith('CHECK') ||
            cl.startsWith('INDEX')) continue;

        const colMatch = cl.match(/^([a-z_A-Z][a-z_A-Z0-9]*)\s+([A-Z][A-Z0-9_\s()]*?)(?:\s+(?:DEFAULT|NOT\s+NULL|NULL|PRIMARY|REFERENCES|UNIQUE|CHECK).*)?[,]?$/i);
        if (colMatch) {
          columns.push({ name: colMatch[1], type: colMatch[2].trim().replace(/,$/, '') });
        }
      }

      // RLS politikalari
      const policies = [];
      const policyMatches = [...content.matchAll(/CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+(?:public\.)?([a-z_A-Z][a-z_A-Z0-9]*)\s+FOR\s+([A-Z]+)/gi)];
      for (const p of policyMatches) {
        if (p[2].toLowerCase() === tableName.toLowerCase()) {
          policies.push({ name: p[1], operation: p[3] });
        }
      }

      tables.push({ tableName, columns, policies });
    }

    // INDEX bilgileri
    const indexes = [];
    const indexMatches = [...content.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_A-Z][a-z_A-Z0-9]*)\s+ON\s+(?:public\.)?([a-z_A-Z][a-z_A-Z0-9]*)\s*\(([^)]+)\)/gi)];
    for (const m of indexMatches) {
      indexes.push({ name: m[1], table: m[2], on: m[3].trim() });
    }

    migrations.push({ file, tables, indexes });
  }
  return migrations;
}

// ─── TypeScript types.ts ozeti ────────────────────────────────────────────────

function parseTypeFile(serviceDir) {
  const typesFile = path.join(serviceDir, 'types.ts');
  if (!fs.existsSync(typesFile)) return null;
  const content = fs.readFileSync(typesFile, 'utf8');
  const rel = relPath(typesFile);

  const interfaces = [];
  const ifaceMatches = [...content.matchAll(/(?:export\s+)?(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)\s*(?:=\s*)?[{<]/g)];
  for (const m of ifaceMatches) interfaces.push(m[1]);

  const enums = [];
  const enumMatches = [...content.matchAll(/(?:export\s+)?(?:const\s+enum|enum)\s+([A-Z][A-Za-z0-9_]*)/g)];
  for (const m of enumMatches) enums.push(m[1]);

  const typeAliases = [];
  const aliasMatches = [...content.matchAll(/export\s+type\s+([A-Z][A-Za-z0-9_]*)\s*=/g)];
  for (const m of aliasMatches) typeAliases.push(m[1]);

  return { file: rel, interfaces, enums, typeAliases };
}

// ─── Ana build ────────────────────────────────────────────────────────────────

function buildMap() {
  const allFiles = [
    ...getFiles(SRC_DIR),
    ...getFiles(CMS_DIR),
  ];

  const { tables, rpcs } = parseSupabaseCalls(allFiles);
  const migrations = parseMigrations();

  // Migration'lardan kolon bilgisi ekle
  for (const mg of migrations) {
    for (const t of mg.tables) {
      if (tables[t.tableName]) {
        tables[t.tableName].migrationCols  = t.columns;
        tables[t.tableName].rlsPolicies    = t.policies;
      } else {
        // Migration'da tanimi var ama kodda henuz kullanilmiyor
        tables[t.tableName] = {
          usedIn: [],
          columns: [],
          filters: [],
          operations: [],
          migrationCols: t.columns,
          rlsPolicies: t.policies,
          onlyInMigration: true,
        };
      }
    }
  }

  // Service type dosyalarini topla
  const serviceTypes = {};
  if (fs.existsSync(SERVICES_DIR)) {
    for (const svc of fs.readdirSync(SERVICES_DIR)) {
      const svcDir = path.join(SERVICES_DIR, svc);
      if (fs.statSync(svcDir).isDirectory()) {
        const info = parseTypeFile(svcDir);
        if (info) serviceTypes[svc] = info;
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    tableCount:  Object.keys(tables).length,
    rpcCount:    Object.keys(rpcs).length,
    tables,
    rpcs,
    migrations,
    serviceTypes,
  };

  try {
    if (!fs.existsSync(path.dirname(CACHE_PATH))) fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2), 'utf8');
  } catch {}

  return result;
}

function loadOrBuild() {
  if (fs.existsSync(CACHE_PATH)) {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}
  }
  return buildMap();
}

// ─── Cikti ────────────────────────────────────────────────────────────────────

function printMap(data) {
  const entries = Object.entries(data.tables).sort((a, b) => b[1].usedIn.length - a[1].usedIn.length);
  console.log(`\n\x1b[1m SUPABASE TABLO HARiTASI\x1b[0m  (${entries.length} tablo, ${data.rpcCount} RPC)\n`);
  console.log('  Tablo'.padEnd(36) + 'Ops'.padEnd(32) + 'Kullanim');
  console.log('─'.repeat(80));

  for (const [name, t] of entries) {
    const ops    = (t.operations || []).join('/') || '?';
    const usages = t.usedIn.length;
    const migTag = t.onlyInMigration ? ' \x1b[90m[migration-only]\x1b[0m' : '';
    const colTag = t.migrationCols ? ` \x1b[90m(${t.migrationCols.length} kolon)\x1b[0m` : '';
    console.log(
      `  \x1b[1m${name.padEnd(34)}\x1b[0m` +
      `\x1b[36m${ops.padEnd(30)}\x1b[0m` +
      `${usages} dosya${migTag}${colTag}`
    );
  }
  console.log('─'.repeat(80));
  console.log(`  Toplam: ${entries.length} tablo  ${data.rpcCount} RPC fonksiyonu\n`);
}

function printTable(data, name) {
  const t = data.tables[name];
  if (!t) {
    console.log(`\x1b[31mTablo bulunamadi: "${name}"\x1b[0m`);
    console.log(`Mevcut tablolar: ${Object.keys(data.tables).join(', ')}`);
    return;
  }

  console.log(`\n\x1b[1m${name}\x1b[0m`);
  console.log('─'.repeat(60));

  if (t.migrationCols && t.migrationCols.length > 0) {
    console.log(`  Kolonlar (migration'dan):`);
    for (const c of t.migrationCols) {
      console.log(`    \x1b[36m${c.name.padEnd(28)}\x1b[0m \x1b[90m${c.type}\x1b[0m`);
    }
  }

  if (t.rlsPolicies && t.rlsPolicies.length > 0) {
    console.log(`\n  RLS Politikalari:`);
    for (const p of t.rlsPolicies) {
      console.log(`    \x1b[33m${p.operation.padEnd(8)}\x1b[0m  "${p.name}"`);
    }
  }

  if (t.operations && t.operations.length > 0) {
    console.log(`\n  Kod'da Kullanilan Operasyonlar: \x1b[36m${t.operations.join(', ')}\x1b[0m`);
  }

  if (t.filters && t.filters.length > 0) {
    console.log(`  Filtreleme Kolonlari (.eq): \x1b[90m${t.filters.join(', ')}\x1b[0m`);
  }

  if (t.columns && t.columns.length > 0) {
    console.log(`  .select() ile Cekilen Kolonlar: \x1b[90m${t.columns.join(', ')}\x1b[0m`);
  }

  if (t.usedIn && t.usedIn.length > 0) {
    console.log(`\n  Kullanan Dosyalar (${t.usedIn.length}):`);
    const byFile = {};
    for (const u of t.usedIn) {
      if (!byFile[u.file]) byFile[u.file] = [];
      byFile[u.file].push(u.line);
    }
    for (const [f, lines] of Object.entries(byFile)) {
      console.log(`    \x1b[32m${f}\x1b[0m  \x1b[90msatir: ${lines.join(', ')}\x1b[0m`);
    }
  } else {
    console.log(`\n  \x1b[90mKod'da kullanim tespit edilmedi (sadece migration'da tanimli)\x1b[0m`);
  }
  console.log('');
}

function printRpcs(data) {
  const entries = Object.entries(data.rpcs);
  if (entries.length === 0) {
    console.log('\x1b[90mHic RPC cagris tespit edilmedi.\x1b[0m');
    return;
  }
  console.log(`\n\x1b[1m SUPABASE RPC FONKSiYONLARI\x1b[0m  (${entries.length} adet)\n`);
  for (const [fn, callers] of entries) {
    console.log(`  \x1b[1m${fn}\x1b[0m  (${callers.length} cagri)`);
    for (const c of callers) {
      console.log(`    \x1b[32m${c.file}:${c.line}\x1b[0m`);
    }
  }
  console.log('');
}

function printMigrations(data) {
  if (!data.migrations || data.migrations.length === 0) {
    console.log('\x1b[90mHic migration dosyasi bulunamadi.\x1b[0m');
    return;
  }
  console.log(`\n\x1b[1m SQL MiGRATiON DOSYALARI\x1b[0m  (${data.migrations.length} adet)\n`);
  for (const mg of data.migrations) {
    console.log(`  \x1b[1m${mg.file}\x1b[0m`);
    for (const t of mg.tables) {
      console.log(`    Tablo: \x1b[36m${t.tableName}\x1b[0m  (${t.columns.length} kolon, ${t.policies.length} RLS policy)`);
    }
    if (mg.indexes.length > 0) {
      console.log(`    Index: \x1b[90m${mg.indexes.map(i => i.name).join(', ')}\x1b[0m`);
    }
  }
  console.log('');
}

function printTypes(data, svcName) {
  if (svcName) {
    const svc = data.serviceTypes[svcName];
    if (!svc) {
      console.log(`\x1b[31mServis bulunamadi: "${svcName}"\x1b[0m`);
      console.log(`Mevcut servisler: ${Object.keys(data.serviceTypes).join(', ')}`);
      return;
    }
    console.log(`\n\x1b[1m${svcName}\x1b[0m  →  ${svc.file}`);
    if (svc.interfaces.length) console.log(`  Interfaces:   \x1b[36m${svc.interfaces.join(', ')}\x1b[0m`);
    if (svc.typeAliases.length) console.log(`  Type Aliases: \x1b[90m${svc.typeAliases.join(', ')}\x1b[0m`);
    if (svc.enums.length)      console.log(`  Enums:        \x1b[33m${svc.enums.join(', ')}\x1b[0m`);
    console.log('');
  } else {
    console.log(`\n\x1b[1m TUM SERViS TiPLERi\x1b[0m\n`);
    for (const [svc, info] of Object.entries(data.serviceTypes)) {
      const total = info.interfaces.length + info.typeAliases.length + info.enums.length;
      console.log(`  \x1b[1m${svc.padEnd(20)}\x1b[0m  ${total} tip  \x1b[90m(${info.file})\x1b[0m`);
      if (info.interfaces.length) console.log(`    \x1b[36m${info.interfaces.join(', ')}\x1b[0m`);
    }
    console.log('');
  }
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const args    = process.argv.slice(2);
  const command = args[0] || 'map';

  const data = (command === 'rebuild') ? buildMap() : loadOrBuild();

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
🗄 supabase-mapper.js — Supabase Şema, Tablo & RPC Haritası

Kullanım:
  node .agents/repo-intelligence-layer/scripts/supabase-mapper.js [komut] [argüman]

Komutlar:
  map              Tüm tabloların operasyon ve kullanım haritası (varsayılan)
  table <tablo>    Tek bir tablonun kolon şeması, RLS kuralları ve kullanan dosyaları
  who <tablo>      Bu tabloyu hangi dosyaların ve satırların çağırdığını listeler
  rpc              Tüm Supabase RPC fonksiyonlarını ve çağıran yerleri listeler
  migrations       Mevcut SQL migration dosyalarını ve içeriklerini listeler
  types [servis]   Servis dizinlerindeki TypeScript arayüz ve tiplerini özetler
  rebuild          Supabase haritasını dosyaları baştan tarayarak yeniler
  help, -h         Bu yardım metnini gösterir
`);
    process.exit(0);
  } else if (command === 'table') {
    const name = args.slice(1).join(' ');
    if (!name) { console.error('Kullanım: node scripts/supabase-mapper.js table <tablo_adi>'); process.exit(1); }
    printTable(data, name);

  } else if (command === 'who') {
    const name = args.slice(1).join(' ');
    if (!name) { console.error('Kullanim: node scripts/supabase-mapper.js who <tablo_adi>'); process.exit(1); }
    const t = data.tables[name];
    if (!t) { console.log(`\x1b[31mTablo bulunamadi: "${name}"\x1b[0m`); process.exit(1); }
    console.log(`\n\x1b[1m"${name}"\x1b[0m tablosunu kullanan dosyalar:\n`);
    const byFile = {};
    for (const u of t.usedIn) { if (!byFile[u.file]) byFile[u.file] = []; byFile[u.file].push(u.line); }
    for (const [f, lines] of Object.entries(byFile)) {
      console.log(`  \x1b[32m${f}\x1b[0m  \x1b[90m(satir: ${lines.join(', ')})\x1b[0m`);
    }
    console.log('');

  } else if (command === 'rpc') {
    printRpcs(data);

  } else if (command === 'migrations') {
    printMigrations(data);

  } else if (command === 'types') {
    printTypes(data, args[1] || null);

  } else if (command === 'rebuild') {
    console.log(`\x1b[32m✔ Supabase haritasi yeniden olusturuldu — ${data.tableCount} tablo, ${data.rpcCount} RPC.\x1b[0m`);

  } else {
    // map (default)
    printMap(data);
  }
}

module.exports = { buildMap, loadOrBuild };
