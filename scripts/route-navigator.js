/**
 * route-navigator.js — Route & Deep Link Navigator
 *
 * App.tsx ve BottomTabNavigator.tsx uzerindeki Stack.Screen / Tab.Screen
 * tanimlarini, her ekranin component dosyasini, animasyonunu, auth durumunu
 * ve navigation.navigate / router.push cagrilarini (kim nereye gidiyor)
 * indeksleyerek tam bir navigasyon haritas cikartir.
 *
 * Komutlar:
 *   node scripts/route-navigator.js               → Tum rota haritasi
 *   node scripts/route-navigator.js map           → Tum rota haritasi
 *   node scripts/route-navigator.js screen <name> → Tek ekran detayi (hangi paramlar, nereden aciliyor)
 *   node scripts/route-navigator.js callers <name>→ Bu ekrana kim navigate ediyor?
 *   node scripts/route-navigator.js params <name> → Bu ekranin beklenen route.params'lari
 *   node scripts/route-navigator.js tree          → Hiyerarsik agac gorunumu
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const APP_FILE  = path.join(REPO_ROOT, 'App.tsx');
const TAB_FILE  = path.join(REPO_ROOT, 'src', 'navigation', 'BottomTabNavigator.tsx');
const SRC_DIR   = path.join(REPO_ROOT, 'src');
const ROUTE_CACHE = path.join(REPO_ROOT, 'ai-reports', 'route_map.json');

// ─── Parser: Stack.Screen ve Tab.Screen tanimlarini yakala ──────────────────

function parseScreens(filePath, authContext) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const screens = [];

  // Stack.Screen name="X" component={Y} options={{ animation: 'Z' }}
  // Tab.Screen name="X" component={Y}
  const screenRegex = /<(?:Stack|Tab)\.Screen\s+([^/]*?)(?:\/>|>)/gs;
  let match;

  while ((match = screenRegex.exec(content)) !== null) {
    const block = match[1];

    const nameMatch      = block.match(/name=["']([^"']+)["']/);
    const componentMatch = block.match(/component=\{([A-Za-z0-9_]+)\}/);
    const animMatch      = block.match(/animation:\s*['"]([^'"]+)['"]/);
    const titleMatch     = block.match(/title:\s*['"]([^'"]+)['"]/);

    if (!nameMatch) continue;

    const name      = nameMatch[1];
    const component = componentMatch ? componentMatch[1] : null;
    const animation = animMatch ? animMatch[1] : 'fade';

    // Component dosya yolunu coz
    let componentFile = null;
    if (component) {
      componentFile = resolveComponentFile(component);
    }

    // Auth durumunu satir baglamina gore tespit et
    let auth = authContext;
    // App.tsx'te !isLoggedIn blogu mu, isLoggedIn blogu mu?
    const idx = content.indexOf(match[0]);
    const before = content.slice(0, idx);
    const lastLoggedInBlock  = before.lastIndexOf('isLoggedIn');
    const lastNotLoggedIn    = before.lastIndexOf('!isLoggedIn');
    if (lastNotLoggedIn > lastLoggedInBlock) auth = 'guest-only';
    else if (lastLoggedInBlock > -1) auth = 'auth-required';

    screens.push({ name, component, componentFile, animation, title: titleMatch ? titleMatch[1] : null, auth, sourceFile: path.relative(REPO_ROOT, filePath).replace(/\\/g, '/') });
  }

  return screens;
}

function resolveComponentFile(componentName) {
  // Screens klasoru
  const screenCandidates = [
    path.join(SRC_DIR, 'screens', `${componentName}.tsx`),
    path.join(SRC_DIR, 'screens', `${componentName}.ts`),
    path.join(SRC_DIR, 'components', `${componentName}.tsx`),
    path.join(SRC_DIR, 'components', `${componentName}.ts`),
    path.join(SRC_DIR, 'navigation', `${componentName}.tsx`),
  ];
  for (const c of screenCandidates) {
    if (fs.existsSync(c)) return path.relative(REPO_ROOT, c).replace(/\\/g, '/');
  }
  return null;
}

// ─── navigate() ve router.push() cagrilarini bul ────────────────────────────

function getSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.expo', '.next', 'dist', 'ai-reports'].includes(entry.name)) continue;
      getSourceFiles(fullPath, fileList);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function parseNavigateCalls(allFiles) {
  // { routeName: [{ callerFile, line, params }] }
  const callers = {};

  for (const absPath of allFiles) {
    const rel = path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    let content;
    try { content = fs.readFileSync(absPath, 'utf8'); } catch { continue; }

    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      // navigation.navigate('RouteName', { ...params })
      // navigation.navigate('RouteName')
      // router.push('/routeName')
      const navMatch = line.match(/navigation\.navigate\(\s*['"]([^'"]+)['"]\s*(?:,\s*(\{[^)]*\}))?\s*\)/);
      const routerMatch = line.match(/router\.push\(\s*['"]([^'"]+)['"]\s*\)/);

      if (navMatch) {
        const routeName = navMatch[1];
        const rawParams = navMatch[2] || null;
        if (!callers[routeName]) callers[routeName] = [];
        callers[routeName].push({ callerFile: rel, line: idx + 1, params: rawParams ? rawParams.replace(/\s+/g, ' ').trim() : null });
      }

      if (routerMatch) {
        const routeName = routerMatch[1];
        if (!callers[routeName]) callers[routeName] = [];
        callers[routeName].push({ callerFile: rel, line: idx + 1, params: null });
      }
    });
  }

  return callers;
}

// ─── route.params kullanimini bul ─────────────────────────────────────────────

function parseRouteParams(componentFile) {
  if (!componentFile) return [];
  const absPath = path.resolve(REPO_ROOT, componentFile);
  if (!fs.existsSync(absPath)) return [];
  let content;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { return []; }

  const params = new Set();
  const lines = content.split('\n');

  lines.forEach(line => {
    // route.params.X veya route?.params?.X veya const { X } = route.params
    const dotMatch = [...line.matchAll(/route\.params\??\.([A-Za-z_][A-Za-z0-9_]*)/g)];
    for (const m of dotMatch) params.add(m[1]);

    const destructMatch = line.match(/const\s*\{([^}]+)\}\s*=\s*route\.params/);
    if (destructMatch) {
      for (const p of destructMatch[1].split(',')) {
        const name = p.trim().split(':')[0].trim().replace('?', '');
        if (name) params.add(name);
      }
    }
  });

  return [...params];
}

// ─── Ana veri yapisi ─────────────────────────────────────────────────────────

function buildRouteMap() {
  const stackScreens = parseScreens(APP_FILE, 'unknown');
  const tabScreens   = parseScreens(TAB_FILE, 'auth-required');

  // Tab screens'i MainTabs altina al
  const mainTabs = { name: 'MainTabs', type: 'tab-group', children: tabScreens };

  const allFiles = getSourceFiles(SRC_DIR);
  allFiles.push(APP_FILE);
  const callerMap = parseNavigateCalls(allFiles);

  // Her screen icin params ekle
  for (const s of stackScreens) {
    s.type  = 'stack';
    s.callers = callerMap[s.name] || [];
    s.params  = parseRouteParams(s.componentFile);
  }
  for (const s of tabScreens) {
    s.type    = 'tab';
    s.callers = callerMap[s.name] || [];
    s.params  = parseRouteParams(s.componentFile);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    stackScreens,
    tabScreens,
    callerMap,
  };

  // Cache'e yaz
  try {
    if (!fs.existsSync(path.dirname(ROUTE_CACHE))) fs.mkdirSync(path.dirname(ROUTE_CACHE), { recursive: true });
    fs.writeFileSync(ROUTE_CACHE, JSON.stringify(result, null, 2), 'utf8');
  } catch {}

  return result;
}

function loadOrBuild() {
  // Eger cache varsa ve App.tsx'ten daha yeniyse kullan
  if (fs.existsSync(ROUTE_CACHE)) {
    const cacheStat = fs.statSync(ROUTE_CACHE);
    const appStat   = fs.existsSync(APP_FILE) ? fs.statSync(APP_FILE) : null;
    if (!appStat || cacheStat.mtimeMs > appStat.mtimeMs) {
      try { return JSON.parse(fs.readFileSync(ROUTE_CACHE, 'utf8')); } catch {}
    }
  }
  return buildRouteMap();
}

// ─── Cikti ──────────────────────────────────────────────────────────────────

const AUTH_LABEL = {
  'auth-required': '\x1b[32m[AUTH]\x1b[0m',
  'guest-only':    '\x1b[33m[GUEST]\x1b[0m',
  'unknown':       '\x1b[90m[ANY]\x1b[0m',
};
const ANIM_SHORT = {
  'slide_from_right':  '→',
  'slide_from_bottom': '↑',
  'slide_from_left':   '←',
  'fade':              '~',
  'none':              '-',
};

function printMap(data) {
  const { stackScreens, tabScreens } = data;

  console.log('\n\x1b[1m NAVIGASYON HARiTASI\x1b[0m\n');

  console.log('\x1b[1m[STACK - Auth Gerekli]\x1b[0m');
  console.log('─'.repeat(72));

  // Auth required stack'ler
  for (const s of stackScreens.filter(s => s.auth === 'auth-required')) {
    const anim   = ANIM_SHORT[s.animation] || '~';
    const params = s.params && s.params.length ? `  params: \x1b[36m${s.params.join(', ')}\x1b[0m` : '';
    const callerCount = s.callers.length;
    console.log(`  \x1b[1m${s.name.padEnd(30)}\x1b[0m ${anim}  ${s.componentFile || s.component || '?'}${params}`);
    if (callerCount > 0) console.log(`    \x1b[90m↳ ${callerCount} yerden cagrilıyor\x1b[0m`);
  }

  console.log('\n\x1b[1m[STACK - Misafir]\x1b[0m');
  console.log('─'.repeat(72));
  for (const s of stackScreens.filter(s => s.auth === 'guest-only')) {
    console.log(`  \x1b[1m${s.name.padEnd(30)}\x1b[0m  ${s.componentFile || s.component || '?'}`);
  }

  console.log('\n\x1b[1m[BOTTOM TABS - MainTabs]\x1b[0m');
  console.log('─'.repeat(72));
  for (const s of tabScreens) {
    console.log(`  \x1b[1m${s.name.padEnd(20)}\x1b[0m  ${s.componentFile || s.component || '?'}`);
  }

  const totalScreens = stackScreens.length + tabScreens.length;
  console.log(`\n  Toplam: ${totalScreens} ekran  (${stackScreens.length} stack + ${tabScreens.length} tab)\n`);
}

function printScreen(data, screenName) {
  const all = [...data.stackScreens, ...data.tabScreens];
  const screen = all.find(s => s.name.toLowerCase() === screenName.toLowerCase());

  if (!screen) {
    console.log(`\x1b[31mEkran bulunamadi: "${screenName}"\x1b[0m`);
    console.log(`Mevcut ekranlar: ${all.map(s => s.name).join(', ')}`);
    return;
  }

  console.log(`\n\x1b[1m${screen.name}\x1b[0m`);
  console.log('─'.repeat(60));
  console.log(`  Tip:        ${screen.type === 'tab' ? 'Bottom Tab' : 'Stack Screen'}`);
  console.log(`  Komponent:  ${screen.componentFile || screen.component || 'bilinmiyor'}`);
  console.log(`  Auth:       ${AUTH_LABEL[screen.auth] || screen.auth}`);
  console.log(`  Animasyon:  ${screen.animation || 'fade'}`);

  if (screen.params && screen.params.length > 0) {
    console.log(`  Params:     \x1b[36m${screen.params.join(', ')}\x1b[0m`);
  } else {
    console.log(`  Params:     (yok)`);
  }

  if (screen.callers && screen.callers.length > 0) {
    console.log(`\n  Nereden Aciliyor? (${screen.callers.length} cagri):`);
    for (const c of screen.callers) {
      const paramStr = c.params ? `  → ${c.params}` : '';
      console.log(`    \x1b[32m${c.callerFile}:${c.line}\x1b[0m${paramStr}`);
    }
  } else {
    console.log(`\n  Nereden Aciliyor: \x1b[90mnavigation.navigate() cagris tespit edilmedi\x1b[0m`);
  }
  console.log('');
}

function printTree(data) {
  const { stackScreens, tabScreens } = data;
  console.log('\n\x1b[1mNavigationContainer\x1b[0m');
  console.log('  └── \x1b[1mStack.Navigator\x1b[0m');

  const guestScreens = stackScreens.filter(s => s.auth === 'guest-only');
  const authScreens  = stackScreens.filter(s => s.auth !== 'guest-only');

  if (guestScreens.length) {
    console.log('       ├── \x1b[33m[!isLoggedIn]\x1b[0m');
    guestScreens.forEach((s, i) => {
      const isLast = i === guestScreens.length - 1;
      console.log(`       │   ${isLast ? '└' : '├'}── ${s.name}  \x1b[90m(${s.component})\x1b[0m`);
    });
  }

  console.log('       └── \x1b[32m[isLoggedIn]\x1b[0m');
  authScreens.forEach((s, i) => {
    const isLast = i === authScreens.length - 1;
    if (s.name === 'MainTabs') {
      console.log(`           ├── \x1b[1mMainTabs\x1b[0m → BottomTabNavigator`);
      tabScreens.forEach((t, ti) => {
        const isTabLast = ti === tabScreens.length - 1;
        console.log(`           │   ${isTabLast ? '└' : '├'}── Tab: ${t.name}  \x1b[90m(${t.component})\x1b[0m`);
      });
    } else {
      console.log(`           ${isLast ? '└' : '├'}── ${s.name}  \x1b[90m(${s.component})  ${ANIM_SHORT[s.animation] || ''}\x1b[0m`);
    }
  });
  console.log('');
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

if (require.main === module) {
  const args    = process.argv.slice(2);
  const command = args[0] || 'map';

  const data = loadOrBuild();

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
🗺 route-navigator.js — Navigasyon & Rota Haritası

Kullanım:
  node .agents/repo-intelligence-layer/scripts/route-navigator.js [komut] [ekran]

Komutlar:
  tree             Hiyerarşik navigasyon ağacı görünümü (Stack + Bottom Tabs)
  map              Tüm ekranlar ve animasyon/auth listesi (varsayılan)
  screen <Ad>      Tek bir ekranın detaylı kimliği (bileşen yolu, animasyon, params, callers)
  callers <Ad>     Bu ekrana nereden navigate() veya router.push() yapıldığını gösterir
  params <Ad>      Bu ekranın beklediği route.params parametrelerini listeler
  help, -h         Bu yardım metnini gösterir
`);
    process.exit(0);
  } else if (command === 'screen') {
    const name = args.slice(1).join(' ');
    if (!name) { console.error('Kullanım: node scripts/route-navigator.js screen <ScreenName>'); process.exit(1); }
    printScreen(data, name);

  } else if (command === 'callers') {
    const name = args.slice(1).join(' ');
    if (!name) { console.error('Kullanim: node scripts/route-navigator.js callers <ScreenName>'); process.exit(1); }
    const callers = data.callerMap[name] || [];
    if (callers.length === 0) {
      console.log(`\x1b[33m"${name}" icin hic navigate() cagris bulunamadi.\x1b[0m`);
    } else {
      console.log(`\n\x1b[1m"${name}" ekranina giden cagrilar (${callers.length}):\x1b[0m\n`);
      for (const c of callers) {
        const p = c.params ? `  params: \x1b[36m${c.params}\x1b[0m` : '';
        console.log(`  \x1b[32m${c.callerFile}:${c.line}\x1b[0m${p}`);
      }
    }
    console.log('');

  } else if (command === 'params') {
    const name = args.slice(1).join(' ');
    if (!name) { console.error('Kullanim: node scripts/route-navigator.js params <ScreenName>'); process.exit(1); }
    const all    = [...data.stackScreens, ...data.tabScreens];
    const screen = all.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!screen) { console.log(`\x1b[31mEkran bulunamadi: "${name}"\x1b[0m`); process.exit(1); }
    const params = parseRouteParams(screen.componentFile);
    if (params.length === 0) {
      console.log(`\x1b[90m"${name}" icin route.params kullanimi tespit edilmedi.\x1b[0m`);
    } else {
      console.log(`\n\x1b[1m"${name}" beklenen params:\x1b[0m  \x1b[36m${params.join(', ')}\x1b[0m\n`);
    }

  } else if (command === 'tree') {
    printTree(data);

  } else {
    // map (default)
    printMap(data);
  }
}

module.exports = { buildRouteMap, loadOrBuild, parseRouteParams };
