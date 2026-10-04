#!/usr/bin/env node
// Query ai-reports/knowledge_graph.json without dumping the raw JSON into an LLM's context.
// Usage:
//   node scripts/dependencies.js query <term>       search path / purpose / entities by substring
//   node scripts/dependencies.js file <path>         exact node lookup (path as stored in the graph)
//   node scripts/dependencies.js dependents <path>   list files that import <path>
//   node scripts/dependencies.js deps <path>          list files/packages <path> imports
//   node scripts/dependencies.js callers <fnName>     list files whose AST-derived call list references <fnName>
//   node scripts/dependencies.js where <Component>    which files render <Component> in JSX
//   node scripts/dependencies.js style <Component>    most-used "name" prop values on <Component> (icon sets etc.)
//   node scripts/dependencies.js impact <path>        transitive dependents + risk level (LOW/MEDIUM/HIGH)
//   node scripts/dependencies.js change <path>         only the screens (routes) affected if <path> changes
//   node scripts/dependencies.js similar <path>        most similar files (Ollama embeddings if available, else word-based fallback)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = process.cwd();
const GRAPH_PATH = path.join(process.cwd(), 'ai-reports', 'knowledge_graph.json');
const EMBED_CACHE_PATH = path.join(__dirname, '..', 'ai-reports', 'embeddings_cache.json');
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

function loadGraph() {
  if (!fs.existsSync(GRAPH_PATH)) {
    console.error(`Knowledge graph not found at ${GRAPH_PATH}. Run the analysis tool first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function readSourceLines(filePath) {
  const absPath = path.join(__dirname, '..', filePath);
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, 'utf8').split('\n');
}

// Exact-word matches of `identifier` inside `filePath` (used for callers — plain function/hook names).
function findIdentifierLines(filePath, identifier) {
  const lines = readSourceLines(filePath);
  if (!lines) return [];
  const re = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const hits = [];
  lines.forEach((line, idx) => {
    if (re.test(line)) hits.push(idx + 1);
  });
  return hits;
}

// Import/require lines inside `filePath` that reference `targetPath` (matched by basename, since
// source files use relative specifiers like '../services/db/database' while the graph stores
// resolved paths like 'src/services/db/database.ts'). Best-effort — can false-match same-named files.
function findImportLines(filePath, targetPath) {
  const lines = readSourceLines(filePath);
  if (!lines) return [];
  const basename = path.basename(targetPath).replace(/\.(tsx|ts|jsx|js)$/, '');
  const re = new RegExp(`(from|require)\\s*\\(?\\s*['"][^'"]*${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  const hits = [];
  lines.forEach((line, idx) => {
    if (re.test(line)) hits.push(idx + 1);
  });
  return hits;
}

// Deps/dependents line matching is a basename-in-quotes heuristic — >1 hit can mean a real
// duplicate import OR an unrelated same-named file falsely matching. Callers uses an exact word
// match on an already-specific function name, so multiple hits there are just normal call sites.
function formatWithLines(filePath, lines, { warnOnMultiple = false } = {}) {
  if (!lines.length) return `${filePath} (satır bulunamadı)`;
  const warning = warnOnMultiple && lines.length > 1 ? '  ⚠️ birden fazla eşleşme, kontrol et' : '';
  return `${filePath}:${lines.join(',')}${warning}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  return d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatAge(ms) {
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 60) return `${diffMin} dk önce`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)} saat önce`;
  return `${Math.floor(diffMin / 60 / 24)} gün önce`;
}

function findStaleFiles(generatedAtMs) {
  const srcDir = path.join(__dirname, '..', 'src');
  const stale = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      if (fs.statSync(full).mtimeMs > generatedAtMs) {
        stale.push(path.relative(path.join(__dirname, '..'), full).replace(/\\/g, '/'));
      }
    }
  }
  if (fs.existsSync(srcDir)) walk(srcDir);
  return stale;
}

function printFreshnessBanner(graph) {
  const generatedAtMs = graph.generatedAt ? new Date(graph.generatedAt).getTime() : null;
  if (!generatedAtMs) {
    console.log('📅 Grafik tarihi bilinmiyor (generatedAt yok).\n');
    return;
  }
  console.log(`📅 Grafik tarihi: ${formatDate(generatedAtMs)} (${formatAge(generatedAtMs)})`);
  const stale = findStaleFiles(generatedAtMs);
  if (stale.length > 0) {
    const preview = stale.slice(0, 5).join(', ') + (stale.length > 5 ? `, +${stale.length - 5} daha` : '');
    console.log(`⚠️  Bu tarihten sonra değişmiş ${stale.length} dosya var: ${preview}`);
    console.log('   Bu dosyalarla ilgili sonuçlar bayat olabilir — analiz aracını yeniden çalıştırmayı düşün.');
  }
  console.log('');
}

function printNode(filePath, node) {
  const importedByCount = (node.importedBy || []).length;
  const route = node.objective && node.objective.route ? ` ${node.objective.route}` : '';
  console.log(`📄 ${filePath}${route} · ${importedByCount} bağımlı`);
  const purpose = node.semantic && node.semantic.purpose ? node.semantic.purpose : '(açıklama yok)';
  console.log(`${purpose} · ${node.objective.framework}`);
  const entityNames = (node.entities || []).map(e => e.name).filter(Boolean);
  if (entityNames.length) console.log(entityNames.join(', '));
  const renders = (node.graph && node.graph.renders) || [];
  if (renders.length) console.log(`render: ${renders.join(', ')}`);
  console.log('');
}

function cmdQuery(term) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const needle = term.toLowerCase();
  const matches = Object.entries(graph.nodes).filter(([filePath, node]) => {
    if (filePath.toLowerCase().includes(needle)) return true;
    if (node.semantic && node.semantic.purpose && node.semantic.purpose.toLowerCase().includes(needle)) return true;
    if ((node.entities || []).some(e => (e.name || '').toLowerCase().includes(needle))) return true;
    return false;
  });
  if (matches.length === 0) {
    console.log(`"${term}" için eşleşme bulunamadı.`);
    return;
  }
  matches
    .sort((a, b) => (b[1].importedBy || []).length - (a[1].importedBy || []).length)
    .forEach(([filePath, node]) => printNode(filePath, node));
}

function cmdFile(filePath) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const node = graph.nodes[filePath];
  if (!node) {
    console.log(`"${filePath}" grafikte bulunamadı. Tam yolu ai-reports/knowledge_graph.json'daki gibi verin (örn. src/app/quiz.tsx).`);
    return;
  }
  printIdentityCard(filePath, node, graph);
}

function cmdDependents(filePath) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const node = graph.nodes[filePath];
  if (!node) {
    console.log(`"${filePath}" grafikte bulunamadı.`);
    return;
  }
  const dependents = node.importedBy || [];
  if (dependents.length === 0) {
    console.log(`${filePath} dosyasına hiçbir dosya bağımlı değil.`);
    return;
  }
  console.log(`${filePath} → ${dependents.length} bağımlı:`);
  dependents.forEach(dep => console.log(`  ${formatWithLines(dep, findImportLines(dep, filePath), { warnOnMultiple: true })}`));
}

function cmdDeps(filePath) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const node = graph.nodes[filePath];
  if (!node) {
    console.log(`"${filePath}" grafikte bulunamadı.`);
    return;
  }
  const deps = (node.graph && node.graph.dependencies) || [];
  if (deps.length === 0) {
    console.log(`${filePath} hiçbir şeye bağımlı değil.`);
    return;
  }
  console.log(`${filePath} → ${deps.length} bağımlılık:`);
  deps.forEach(dep => console.log(`  ${formatWithLines(dep, findImportLines(filePath, dep), { warnOnMultiple: true })}`));
}

// JSX opening-tag lines for <componentName ...> / <componentName> (best-effort, single-line match).
function findJsxLines(filePath, componentName) {
  const lines = readSourceLines(filePath);
  if (!lines) return [];
  const re = new RegExp(`<${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s/>]`);
  const hits = [];
  lines.forEach((line, idx) => {
    if (re.test(line)) hits.push(idx + 1);
  });
  return hits;
}

// Values of `attrName` on every <componentName .../> tag in filePath (tag body may span lines).
function extractAttrValues(filePath, componentName, attrName) {
  const absPath = path.join(__dirname, '..', filePath);
  if (!fs.existsSync(absPath)) return [];
  const content = fs.readFileSync(absPath, 'utf8');
  const tagRe = new RegExp(`<${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b([\\s\\S]*?)(?:/>|>)`, 'g');
  const attrRe = new RegExp(`\\b${attrName}\\s*=\\s*["'\`{]([^"'\`}]+)["'\`}]`);
  const values = [];
  let m;
  while ((m = tagRe.exec(content))) {
    const am = m[1].match(attrRe);
    if (am) values.push(am[1]);
  }
  return values;
}

// True if `node` renders `componentName`, matching e.g. "View" against both "View" and "Animated.View".
function nodeRenders(node, componentName) {
  return ((node.graph && node.graph.renders) || []).some(
    r => r === componentName || r.split('.').pop() === componentName
  );
}

// BFS over importedBy edges — every file that depends on `start`, directly or transitively.
function transitiveDependents(graph, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    const node = graph.nodes[cur];
    if (!node) continue;
    for (const dep of node.importedBy || []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

function riskLevel(fileCount, routeCount) {
  if (fileCount >= 15 || routeCount >= 3) return 'HIGH';
  if (fileCount >= 5 || routeCount >= 1) return 'MEDIUM';
  return 'LOW';
}

// Mutually-exclusive bucket for a node, used for the impact "Sebep" breakdown and the "what breaks" grouping.
// Order matters — checked top to bottom, first match wins.
function categorizeNode(filePath, node) {
  const purpose = (node.semantic && node.semantic.purpose) || '';
  const route = node.objective && node.objective.route;
  const isAiRelated = /\bai\b/i.test(filePath) || /\bai\b/i.test(purpose) || /yapay zeka/i.test(purpose);

  if (route) return isAiRelated ? 'AI Screen' : 'UI Screen';
  if (node.objective && node.objective.isLayout) return 'Layout';
  if (/services[\\/]db[\\/]/.test(filePath)) return 'CRUD';
  if (/theme/i.test(filePath)) return 'Theme Provider';
  if (/[\\/]hooks[\\/]/.test(filePath) || /^use[A-Z]/.test(path.basename(filePath, path.extname(filePath)))) return 'Hook';
  if (/[\\/]components[\\/]/.test(filePath)) return 'Component';
  if (/[\\/]services[\\/]/.test(filePath)) return 'Service';
  return 'Diğer';
}

// This app's routes only vary by a handful of known suffixes/plurals — collapsing them into one
// feature group (e.g. card-ai/card-creator/card-editor → "Card") is what makes "what breaks" readable.
const SCREEN_GROUP_ALIASES = { questions: 'question', subjects: 'subject' };

function friendlyScreenName(route) {
  let seg = route.replace(/^\//, '');
  if (seg === '') seg = 'home';
  seg = seg.replace(/-(ai|creator|editor)$/, '');
  seg = SCREEN_GROUP_ALIASES[seg] || seg;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

// "useAIChat" -> "AI Chat", "TopicExplainer" -> "Topic Explainer" — splits camelCase while keeping
// existing letter casing (so acronyms like "AI" survive), used to turn a bare identifier into a label.
function splitCamelWords(name) {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!spaced) return '';
  return spaced.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Narrative architectural role for the Identity card — complements the coarser categorizeNode() bucket.
function deriveRole(filePath, category) {
  const base = path.basename(filePath, path.extname(filePath));
  switch (category) {
    case 'CRUD': return 'Persistence Layer';
    case 'Theme Provider': return 'Theme Provider';
    case 'Layout': return 'App Shell';
    case 'AI Screen': return 'AI Feature Screen';
    case 'UI Screen': return 'UI Screen';
    case 'Component': return 'UI Component';
    case 'Hook': {
      const domain = splitCamelWords(base.replace(/^use[-_]?/, ''));
      return domain ? `${domain} Hook` : 'Hook';
    }
    case 'Service': {
      if (/prompt/i.test(base)) return 'Prompt Builder';
      if (/client/i.test(base)) return 'API Client';
      if (/llm/i.test(base)) return 'LLM Service';
      const domain = splitCamelWords(base);
      return domain ? `${domain} Service` : 'Service';
    }
    default: return '—';
  }
}

const FRAMEWORK_PRIORITY = [
  [/^expo-sqlite$/, 'Expo SQLite'],
  [/^expo-router$/, 'Expo Router'],
  [/^expo-/, 'Expo'],
  [/^@react-navigation/, 'React Navigation'],
  [/^react-native$/, 'React Native'],
  [/^react$/, 'React'],
];

// objective.framework is a coarse TypeScript/React/React Native tag — prefer a more specific
// dependency (e.g. expo-sqlite) when one is present, since that's what actually identifies the file.
function deriveFramework(node) {
  const deps = (node.graph && node.graph.dependencies) || [];
  for (const [re, label] of FRAMEWORK_PRIORITY) {
    if (deps.some(d => re.test(d))) return label;
  }
  return (node.objective && node.objective.framework) || '—';
}

// Commits since this file's last change (git history), used as a rough "how settled is this" signal.
// Returns null if the file has no git history yet (untracked/new) or git isn't available.
function computeStability(filePath) {
  try {
    const lastCommit = execFileSync('git', ['log', '-1', '--format=%H', '--', filePath], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    if (!lastCommit) return null;
    const count = execFileSync('git', ['rev-list', '--count', `${lastCommit}..HEAD`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return parseInt(count, 10);
  } catch {
    return null;
  }
}

function formatSizeKB(filePath) {
  const absPath = path.join(REPO_ROOT, filePath);
  if (!fs.existsSync(absPath)) return '—';
  return `${(fs.statSync(absPath).size / 1024).toFixed(1)} KB`;
}

function printIdentityCard(filePath, node, graph) {
  const category = categorizeNode(filePath, node);
  const categoryDisplay = category === 'CRUD' ? 'CRUD Service' : category;
  const role = deriveRole(filePath, category);
  const affected = transitiveDependents(graph, filePath);
  const screenCount = [...affected].filter(p => graph.nodes[p].objective && graph.nodes[p].objective.route).length;
  const risk = riskLevel(affected.size, screenCount);
  const importance = { HIGH: 'Critical', MEDIUM: 'High', LOW: 'Low' }[risk];
  const stableSince = computeStability(filePath);
  const entityNames = (node.entities || []).map(e => e.name).filter(Boolean);
  const entityPreview = entityNames.length > 8
    ? `${entityNames.slice(0, 8).join(', ')}, +${entityNames.length - 8} daha`
    : entityNames.join(', ') || '—';

  const rows = [
    ['Path', filePath],
    ['Category', categoryDisplay],
    ['Role', role],
    ['Framework', deriveFramework(node)],
    ['Language', node.objective.language || '—'],
    ['Size', formatSizeKB(filePath)],
    ['Lines', String(node.objective.lines ?? '—')],
    ['', ''],
    ['Exports', String(node.objective.exports ?? 0)],
    ['Functions', String(node.objective.functions ?? 0)],
    ['Hooks', String(node.objective.hooks ?? 0)],
    ['Components', String(node.objective.components ?? 0)],
    ['Entities', entityPreview],
    ['', ''],
    ['Dependents', String((node.importedBy || []).length)],
    ['Risk', risk],
    ['Stability', stableSince === null ? '—' : `Stable since ${stableSince} commit${stableSince === 1 ? '' : 's'}`],
    ['', ''],
    ['Importance', importance],
    ['Reason', [`${affected.size} dependents`, screenCount > 0 ? `${screenCount} screens` : null, role !== '—' ? role : null].filter(Boolean).join(', ')],
  ];

  console.log('Identity');
  console.log('─'.repeat(44));
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  rows.forEach(([label, value]) => {
    if (!label) { console.log(''); return; }
    console.log(`${label.padEnd(labelWidth)}  ${value}`);
  });
}

function cmdWhere(componentName) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const matches = Object.entries(graph.nodes).filter(([, node]) => nodeRenders(node, componentName));
  if (matches.length === 0) {
    console.log(`"${componentName}" grafiğe göre hiçbir dosyada render edilmiyor.`);
    return;
  }
  console.log(`${componentName} → ${matches.length} dosyada render ediliyor:`);
  matches.forEach(([filePath]) => console.log(`  ${formatWithLines(filePath, findJsxLines(filePath, componentName))}`));
}

function cmdStyle(componentName) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const files = Object.entries(graph.nodes)
    .filter(([, node]) => nodeRenders(node, componentName))
    .map(([filePath]) => filePath);
  if (files.length === 0) {
    console.log(`"${componentName}" grafiğe göre hiçbir dosyada render edilmiyor.`);
    return;
  }
  const tally = {};
  files.forEach(f => extractAttrValues(f, componentName, 'name').forEach(v => {
    tally[v] = (tally[v] || 0) + 1;
  }));
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) {
    console.log(`${componentName} ${files.length} dosyada render ediliyor ama "name" prop'u bulunamadı (best-effort regex, JSX'in şekline göre kaçabilir).`);
    return;
  }
  console.log(`${componentName} → en çok kullanılan "name" değerleri:`);
  ranked.forEach(([value, count]) => console.log(`  ${value}  (${count})`));
}

function cmdImpact(filePath) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  if (!graph.nodes[filePath]) {
    console.log(`"${filePath}" grafikte bulunamadı.`);
    return;
  }
  const affected = transitiveDependents(graph, filePath);
  const routes = [...affected].filter(p => graph.nodes[p] && graph.nodes[p].objective && graph.nodes[p].objective.route);
  const risk = riskLevel(affected.size, routes.length);
  console.log(`${filePath} → ${affected.size} dosya etkileniyor.`);
  console.log(`Risk: ${risk}`);

  const tally = {};
  affected.forEach(p => {
    const cat = categorizeNode(p, graph.nodes[p]);
    tally[cat] = (tally[cat] || 0) + 1;
  });
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0) {
    console.log('\nSebep:');
    console.log(`  ${affected.size} dependent`);
    ranked.forEach(([cat, count]) => console.log(`  ${count} ${cat}`));
  }

  if (affected.size > 0) {
    console.log('');
    [...affected]
      .sort((a, b) => (graph.nodes[b].importedBy || []).length - (graph.nodes[a].importedBy || []).length)
      .forEach(p => {
        const route = graph.nodes[p].objective && graph.nodes[p].objective.route;
        console.log(`  ${p}${route ? `  (ekran: ${route})` : ''}`);
      });
  }
}

function cmdChange(filePath) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  if (!graph.nodes[filePath]) {
    console.log(`"${filePath}" grafikte bulunamadı.`);
    return;
  }
  const affected = transitiveDependents(graph, filePath);
  const routes = [...affected]
    .filter(p => graph.nodes[p].objective && graph.nodes[p].objective.route)
    .map(p => graph.nodes[p].objective.route);
  if (routes.length === 0) {
    console.log(`${filePath} değişirse mevcut grafiğe göre doğrudan/dolaylı etkilenen bir ekran yok.`);
    return;
  }
  const groups = [...new Set(routes.map(friendlyScreenName))];
  console.log(`Neler bozulur? (${filePath})`);
  groups.forEach(g => console.log(`  ✓ ${g}`));
}

function nodeSimilarityText(filePath, node) {
  const purpose = (node.semantic && node.semantic.purpose) || '';
  const entities = (node.entities || []).map(e => e.name).filter(Boolean).join(', ');
  const renders = ((node.graph && node.graph.renders) || []).join(', ');
  const deps = ((node.graph && node.graph.dependencies) || []).join(', ');
  return `Dosya: ${filePath}\nAmaç: ${purpose}\nEntity: ${entities}\nRender: ${renders}\nBağımlılık: ${deps}`;
}

function loadEmbedCache() {
  if (!fs.existsSync(EMBED_CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(EMBED_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveEmbedCache(cache) {
  fs.writeFileSync(EMBED_CACHE_PATH, JSON.stringify(cache));
}

async function fetchOllamaEmbedding(text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.embedding) throw new Error(data.error || 'boş embedding döndü');
  return data.embedding;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Fallback when no Ollama embedding model is available: plain bag-of-words cosine similarity.
function tokenize(text) {
  return text.toLowerCase().match(/[a-zçğıöşü0-9]+/gi) || [];
}

function bowVector(text) {
  const vec = {};
  tokenize(text).forEach(t => { vec[t] = (vec[t] || 0) + 1; });
  return vec;
}

function cosineSimSparse(vecA, vecB) {
  let dot = 0, na = 0, nb = 0;
  for (const k in vecA) {
    na += vecA[k] * vecA[k];
    if (vecB[k]) dot += vecA[k] * vecB[k];
  }
  for (const k in vecB) nb += vecB[k] * vecB[k];
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function cmdSimilar(filePath) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const targetNode = graph.nodes[filePath];
  if (!targetNode) {
    console.log(`"${filePath}" grafikte bulunamadı.`);
    return;
  }
  const others = Object.entries(graph.nodes).filter(([p]) => p !== filePath);
  const cache = loadEmbedCache();
  const scores = [];
  let usedEmbeddings = true;

  try {
    const targetHash = targetNode.identity && targetNode.identity.fileHash;
    const cached = cache[filePath];
    const targetVec = cached && cached.hash === targetHash ? cached.vec : await fetchOllamaEmbedding(nodeSimilarityText(filePath, targetNode));
    cache[filePath] = { hash: targetHash, vec: targetVec };

    for (const [p, node] of others) {
      const hash = node.identity && node.identity.fileHash;
      const c = cache[p];
      const vec = c && c.hash === hash ? c.vec : await fetchOllamaEmbedding(nodeSimilarityText(p, node));
      cache[p] = { hash, vec };
      scores.push([p, cosineSim(targetVec, vec)]);
    }
    saveEmbedCache(cache);
  } catch (err) {
    usedEmbeddings = false;
    console.log(`⚠️  Ollama embedding servisine ulaşılamadı (${err.message}). Kelime tabanlı benzerliğe düşülüyor.`);
    console.log(`   Gerçek embedding için: Ollama'yı "OLLAMA_ORIGINS=* ollama serve" + embeddings destekli bir model ile çalıştırıp OLLAMA_EMBED_MODEL ortam değişkenini ayarlayın (örn. nomic-embed-text).\n`);
    const targetVec = bowVector(nodeSimilarityText(filePath, targetNode));
    for (const [p, node] of others) {
      scores.push([p, cosineSimSparse(targetVec, bowVector(nodeSimilarityText(p, node)))]);
    }
  }

  scores.sort((a, b) => b[1] - a[1]);
  console.log(`${filePath} → en benzer dosyalar${usedEmbeddings ? ' (embedding)' : ' (kelime tabanlı, yaklaşık)'}:`);
  scores.slice(0, 5).forEach(([p, score]) => console.log(`  ${p}  %${Math.round(score * 100)}`));
}

function cmdCallers(fnName) {
  const graph = loadGraph();
  printFreshnessBanner(graph);
  const callers = Object.entries(graph.nodes).filter(([, node]) => (node.graph && node.graph.calls || []).includes(fnName));
  if (callers.length === 0) {
    console.log(`"${fnName}" hiçbir dosyanın call listesinde geçmiyor. (AST tabanlı, LLM'e sormaz — isim tam eşleşmeli.)`);
    return;
  }
  console.log(`${fnName} → ${callers.length} dosyada çağrılıyor:`);
  callers.forEach(([filePath]) => console.log(`  ${formatWithLines(filePath, findIdentifierLines(filePath, fnName))}`));
}

const [, , cmd, arg] = process.argv;

if (!cmd || !arg) {
  console.log('Usage: node scripts/dependencies.js <query|file|dependents|deps|callers|where|style|impact|change|similar> <term>');
  process.exit(1);
}

switch (cmd) {
  case 'query':
    cmdQuery(arg);
    break;
  case 'file':
    cmdFile(arg);
    break;
  case 'dependents':
    cmdDependents(arg);
    break;
  case 'deps':
    cmdDeps(arg);
    break;
  case 'callers':
    cmdCallers(arg);
    break;
  case 'where':
    cmdWhere(arg);
    break;
  case 'style':
    cmdStyle(arg);
    break;
  case 'impact':
    cmdImpact(arg);
    break;
  case 'change':
    cmdChange(arg);
    break;
  case 'similar':
    cmdSimilar(arg).catch(err => {
      console.error(err);
      process.exit(1);
    });
    break;
  case 'i18n': {
    const { queryI18n } = require('./i18n-indexer');
    queryI18n(process.argv.slice(3).join(' '));
    break;
  }
  default:
    console.log(`Bilinmeyen komut: ${cmd}`);
    process.exit(1);
}
