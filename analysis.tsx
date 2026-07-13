import { readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, relative, dirname } from "path";
import { createHash, randomUUID } from "crypto";
import { execSync } from "child_process";
import * as ts from "typescript";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "gemma4:26b";
const TARGET_DIR = process.cwd();
const REPORTS_DIR = join(TARGET_DIR, "ai-reports");
const STATE_PATH = join(REPORTS_DIR, ".state.json");
const STATUS_PATH = join(REPORTS_DIR, ".status.json");
const POLL_INTERVAL_MS = 5000;
const DASHBOARD_PORT = 5959;

// Sürekli çalışması gereken bir ajan için: beklenmedik bir hata tüm süreci öldürmesin
process.on("uncaughtException", (err) => console.error("❌ Yakalanmamış hata (süreç devam ediyor):", err));
process.on("unhandledRejection", (err) => console.error("❌ Yakalanmamış promise reddi (süreç devam ediyor):", err));

let GIT_COMMIT = "unknown";
try {
  GIT_COMMIT = execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim();
} catch {
  // git repo değil ya da henüz commit yok
}

// ---------- Dosya tarama ----------
function getCodeFiles(dir: string, fileList: string[] = []) {
  const files = readdirSync(dir);
  for (const file of files) {
    if (file === "node_modules" || file === ".next" || file === ".git" || file === "ai-reports" || file === ".expo") continue;

    const filePath = join(dir, file);
    if (statSync(filePath).isDirectory()) {
      getCodeFiles(filePath, fileList);
    } else if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// ---------- Değişen dosya bazlı state ----------
type FileState = Record<string, { hash: string; lastAnalyzed: number; reportPath: string }>;

function loadState(): FileState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: FileState) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function hashContent(content: string) {
  return createHash("md5").update(content).digest("hex");
}

// ---------- Dashboard durumu (paylaşımlı bellek) ----------
type StatusEvent = { time: number; icon: string; message: string };

type Status = {
  totalFiles: number;
  cycles: number;
  lastScanAt: number | null;
  queue: string[];
  current: { file: string; startedAt: number; streamText: string } | null;
  completed: { file: string; reportPath: string; finishedAt: number; preview: string }[];
  events: StatusEvent[];
  idle: boolean;
};

const status: Status = {
  totalFiles: 0,
  cycles: 0,
  lastScanAt: null,
  queue: [],
  current: null,
  completed: [],
  events: [],
  idle: true,
};

const listeners = new Set<(data: string) => void>();

function broadcast() {
  const payload = `data: ${JSON.stringify(status)}\n\n`;
  for (const send of listeners) send(payload);
  // debug/geri kalıcılık için diske de yaz
  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
}

function logEvent(icon: string, message: string) {
  status.events.unshift({ time: Date.now(), icon, message });
  status.events = status.events.slice(0, 50);
  broadcast();
}

function relPath(file: string) {
  return relative(TARGET_DIR, file).replace(/\\/g, "/");
}

// ---------- Route: Expo Router dosya-tabanlı rota konvansiyonundan türet (path'ten, kod'dan değil) ----------
const APP_DIR_PREFIX = "src/app/";

function computeRoute(rel: string): { isRoute: boolean; isLayout: boolean; isDynamic: boolean; route: string | null } {
  if (!rel.startsWith(APP_DIR_PREFIX)) return { isRoute: false, isLayout: false, isDynamic: false, route: null };

  let segment = rel.slice(APP_DIR_PREFIX.length).replace(/\.tsx?$/, "");
  const baseName = segment.split("/").pop() || "";

  if (baseName.startsWith("_layout")) return { isRoute: false, isLayout: true, isDynamic: false, route: null };
  if (baseName.startsWith("+")) return { isRoute: false, isLayout: false, isDynamic: false, route: null }; // +not-found vb.

  if (baseName === "index") segment = segment.slice(0, -"index".length).replace(/\/$/, "");

  return { isRoute: true, isLayout: false, isDynamic: /\[.+\]/.test(segment), route: "/" + segment };
}

// ---------- Objective: TypeScript AST tabanlı deterministik analiz (LLM'den değil, parser'dan) ----------
type ObjectiveFacts = {
  language: string;
  lines: number;
  jsx: boolean;
  imports: number;
  exports: number;
  functions: number;
  hooks: number;
  components: number;
};

type EntityFact = { name: string; type: "component" | "hook" | "function"; async: boolean; exported: boolean };

function analyzeWithAst(
  filePath: string,
  content: string
): { objective: ObjectiveFacts; entities: EntityFact[]; calls: string[]; renders: string[] } {
  const isTsx = filePath.endsWith(".tsx");
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  let importsCount = 0;
  let exportsCount = 0;
  let hasJsx = false;
  const entities: EntityFact[] = [];
  const calls = new Set<string>();
  const renders = new Set<string>(); // JSX'te render edilen component'ler (import değil, kullanım)

  const isComponentName = (name: string) => /^[A-Z]/.test(name);
  const isHookName = (name: string) => /^use[A-Z0-9]/.test(name);

  function hasExportModifier(node: ts.Node): boolean {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  function isAsyncFn(node: ts.FunctionLikeDeclarationBase): boolean {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  }

  function addEntity(name: string, async: boolean, exported: boolean) {
    const type: EntityFact["type"] = isComponentName(name) ? "component" : isHookName(name) ? "hook" : "function";
    entities.push({ name, type, async, exported });
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) importsCount++;
    if (ts.isExportAssignment(node)) exportsCount++;
    if (ts.isExportDeclaration(node)) {
      exportsCount += node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.length : 1;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      hasJsx = true;
    }
    if (ts.isJsxElement(node)) renders.add(node.openingElement.tagName.getText(sourceFile));
    if (ts.isJsxSelfClosingElement(node)) renders.add(node.tagName.getText(sourceFile));

    if (ts.isFunctionDeclaration(node) && node.name) {
      const exported = hasExportModifier(node);
      if (exported) exportsCount++;
      addEntity(node.name.text, isAsyncFn(node), exported);
    }

    if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const init = decl.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            if (exported) exportsCount++;
            addEntity(decl.name.text, isAsyncFn(init), exported);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) calls.add(expr.text);
      else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) calls.add(expr.name.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    objective: {
      language: isTsx ? "TypeScript (TSX)" : "TypeScript",
      lines: content.split("\n").length,
      jsx: hasJsx,
      imports: importsCount,
      exports: exportsCount,
      functions: entities.filter((e) => e.type === "function").length,
      hooks: entities.filter((e) => e.type === "hook").length,
      components: entities.filter((e) => e.type === "component").length,
    },
    entities,
    calls: [...calls].slice(0, 50),
    renders: [...renders].slice(0, 50),
  };
}

function safeAnalyzeWithAst(filePath: string, content: string) {
  try {
    return analyzeWithAst(filePath, content);
  } catch (error) {
    console.error(`⚠️  AST analiz hatası (${relPath(filePath)}), objective/entities boş kalacak:`, error);
    return {
      objective: {
        language: filePath.endsWith(".tsx") ? "TypeScript (TSX)" : "TypeScript",
        lines: content.split("\n").length,
        jsx: false,
        imports: 0,
        exports: 0,
        functions: 0,
        hooks: 0,
        components: 0,
      } as ObjectiveFacts,
      entities: [] as EntityFact[],
      calls: [] as string[],
      renders: [] as string[],
    };
  }
}

// ---------- Extraction: odaklı ikinci çağrı, Ollama'nın gerçek JSON şema zorlamasıyla ----------
// NOT: format:"json" sadece sözdizimsel geçerliliği garanti eder, alan adlarını değil.
// Büyük/karmaşık dosyalarda model bambaşka bir JSON şekli uydurabiliyor — bu yüzden tam şema veriyoruz.
// NOT: entities artık AST'den geliyor (analyzeWithAst). LLM'nin tek görevi purpose — tek serbest-metin
// alanı, halüsinasyon yüzeyini burada tutmak için kasıtlı olarak minimal.
// NOT: LLM'ye ham kod DEĞİL, parser'ın çıkardığı gerçekler (entities/imports/sayaçlar) veriliyor.
// Model artık koddan "yorum" değil, verilen gerçeklerden "özet" çıkarıyor — hem daha hızlı hem daha az halüsinasyon.
const SIDECAR_JSON_SCHEMA = {
  type: "object",
  properties: {
    purpose: { type: "string", maxLength: 90 },
  },
  required: ["purpose"],
};

async function extractSidecarViaLLM(
  rel: string,
  facts: { objective: ObjectiveFacts; entities: EntityFact[] },
  dependencies: string[]
): Promise<{ purpose?: string } | null> {
  try {
    const entityNames = facts.entities.map((e) => e.name).slice(0, 20).join(", ") || "yok";
    const importList = dependencies.slice(0, 15).join(", ") || "yok";
    const prompt = `Dosya: ${rel}
Fonksiyon/bileşen sayısı: ${facts.objective.functions}
Hook sayısı: ${facts.objective.hooks}
Entities: ${entityNames}
Imports: ${importList}

Kurallar:
- TEK cümle döndür, en fazla 12 kelime.
- SADECE yukarıdaki entities ve imports bilgisini kullan, başka hiçbir şey uydurma.
- Asla yeni bir sorumluluk icat etme.
- Birden fazla sorumluluk varmış gibi görünüyorsa tam olarak şunu döndür: "Çok amaçlı orkestrasyon modülü."
- TÜRKÇE yaz.

purpose alanını doldur.`;

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, format: SIDECAR_JSON_SCHEMA, stream: false, think: false }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.response);
    return { purpose: typeof parsed.purpose === "string" ? parsed.purpose : undefined };
  } catch {
    return null; // Ollama'ya ulaşılamadı ya da beklenmedik yanıt geldi, sidecar'ı atla
  }
}

// ---------- Derin AI özeti: dashboard'da node'a tıklanınca isteğe bağlı üretilir ----------
// NOT: Otomatik taramadaki purpose'ın aksine bu istek talep üzerine (kullanıcı tetikler) çalışır
// ve sonucu sidecar'a yazarak kalıcı hale getirir — bir sonraki knowledge_graph rebuild'inde
// otomatik olarak grafiğe de yansır.
// NOT: Bilerek format:JSON-şema KULLANMIYORUZ — grammar-constrained decoding, bu boyuttaki
// quantized modelde uzun serbest metinlerde tekrar döngüsüne (aynı kelime onlarca kez) yol
// açtığı gözlemlendi. Düz metin + num_predict tavanı + repeat_penalty çok daha kararlı.
function stripRepetitionLoop(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/([A-Za-zÇĞİıÖŞÜçğıöşü0-9]{2,})\W{0,3}(?:\1\W{0,3}){2,}/i);
  let result = match && match.index !== undefined ? trimmed.slice(0, match.index).trim() : trimmed;
  if (result.length > 380) {
    const cut = result.slice(0, 380);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    result = lastStop > 100 ? cut.slice(0, lastStop + 1).trim() : cut.trim() + "…";
  }
  return result;
}

async function generateDeepSummary(node: any): Promise<string | null> {
  try {
    const entityList = (node.entities || []).map((e: any) => `${e.name}(${e.type}${e.async ? ",async" : ""})`).join(", ") || "yok";
    const depsList = (node.graph?.dependencies || []).join(", ") || "yok";
    const importedByList = (node.importedBy || []).join(", ") || "hiçbiri";
    const prompt = `Dosya: ${node.file}
Katman: ${node.objective?.framework ?? "bilinmiyor"}
Rota: ${node.objective?.route ?? "yok"}
Satır: ${node.objective?.lines ?? 0}
Fonksiyon/Hook/Component: ${node.objective?.functions ?? 0}/${node.objective?.hooks ?? 0}/${node.objective?.components ?? 0}
Entities: ${entityList}
Bağımlılıklar: ${depsList}
Bu dosyayı kullanan dosyalar (${(node.importedBy || []).length} adet): ${importedByList}
Mevcut kısa özet: ${node.semantic?.purpose ?? "yok"}

Kurallar:
- SADECE yukarıdaki bilgileri kullan, başka hiçbir şey uydurma.
- Bu sayılar zaten arayüzde ayrı ayrı gösteriliyor — onları tek tek sıralama veya listeleme.
- Senin işin SADECE yorum: bu dosyanın mimarideki rolü ne, buradaki bir değişikliğin olası sonucu/etkisi ne olur.
- Tam olarak 2 kısa cümlelik TÜRKÇE bir mimari yorum yaz.
- Sadece düz metin yaz: başlık, madde işareti, JSON, markdown YOK.
- Cevabında başka hiçbir açıklama, giriş cümlesi olmasın — direkt yorumla başla.`;

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        think: false,
        options: { temperature: 0.3, repeat_penalty: 1.3, repeat_last_n: 128, num_predict: 160 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.response !== "string") return null;
    const cleaned = stripRepetitionLoop(data.response);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function persistDeepSummary(rel: string, summary: string) {
  const sidecarPath = join(REPORTS_DIR, `${rel}.json`);
  if (!existsSync(sidecarPath)) return;
  try {
    const data = JSON.parse(readFileSync(sidecarPath, "utf-8"));
    data.semantic = { ...data.semantic, deepSummary: summary };
    writeFileSync(sidecarPath, JSON.stringify(data, null, 2));
  } catch {
    // sidecar bozuksa özet sadece bu istekte döner, diske yazılamaz
  }
}

async function handleExplainRequest(url: URL): Promise<Response> {
  const rel = url.searchParams.get("file") || "";
  const refresh = url.searchParams.get("refresh") === "1";
  const graphPath = join(REPORTS_DIR, "knowledge_graph.json");
  if (!existsSync(graphPath)) return Response.json({ error: "Bilgi grafiği henüz oluşmadı" }, { status: 404 });

  let graphData: any;
  try {
    graphData = JSON.parse(readFileSync(graphPath, "utf-8"));
  } catch {
    return Response.json({ error: "Bilgi grafiği okunamadı" }, { status: 500 });
  }

  const node = graphData.nodes?.[rel];
  if (!node) return Response.json({ error: "Dosya bulunamadı" }, { status: 404 });

  if (!refresh && node.semantic?.deepSummary) {
    return Response.json({ summary: node.semantic.deepSummary, cached: true });
  }

  const summary = await generateDeepSummary(node);
  if (!summary) return Response.json({ error: "Ollama'dan yanıt alınamadı" }, { status: 502 });

  persistDeepSummary(rel, summary);
  return Response.json({ summary, cached: false });
}

// ---------- Extraction: import/require ifadelerini statik olarak çıkar ----------
function extractDependencies(content: string): string[] {
  const deps = new Set<string>();
  const importRegex = /import\s+(?:[\w*\s{},]+from\s+)?["']([^"']+)["']/g;
  const requireRegex = /require\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content))) deps.add(m[1]);
  while ((m = requireRegex.exec(content))) deps.add(m[1]);
  return [...deps];
}

// ---------- Yerel import'ları repo içindeki dosyaya çözümle (@/ ve ./ ) ----------
function resolveLocalImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) {
    base = join(dirname(fromFile), spec);
  } else if (spec.startsWith("@/")) {
    base = join(TARGET_DIR, "src", spec.slice(2));
  } else {
    return null; // harici paket, repo grafiğine dahil değil
  }

  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return relPath(c);
  }
  return null;
}

// ---------- Indexing: sidecar'ları birleştirip bilgi grafiğini oluştur ----------
function getJsonSidecars(dir: string, fileList: string[] = []) {
  const files = readdirSync(dir);
  for (const file of files) {
    if (file === "knowledge_graph.json" || file.startsWith(".")) continue;
    const filePath = join(dir, file);
    if (statSync(filePath).isDirectory()) {
      getJsonSidecars(filePath, fileList);
    } else if (filePath.endsWith(".json")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function rebuildKnowledgeGraph() {
  if (!existsSync(REPORTS_DIR)) return;
  const sidecars = getJsonSidecars(REPORTS_DIR);
  const nodes: Record<string, any> = {};

  for (const f of sidecars) {
    try {
      const data = JSON.parse(readFileSync(f, "utf-8"));
      if (data && typeof data.file === "string") {
        nodes[data.file] = { ...data, importedBy: [] as string[] };
      }
    } catch {
      // bozuk sidecar dosyasını atla
    }
  }

  for (const node of Object.values(nodes)) {
    for (const dep of node.graph?.dependencies || []) {
      if (nodes[dep]) nodes[dep].importedBy.push(node.file);
    }
  }

  for (const node of Object.values(nodes)) {
    node.importance = node.importedBy.length;
  }

  writeFileSync(
    join(REPORTS_DIR, "knowledge_graph.json"),
    JSON.stringify({ generatedAt: Date.now(), nodes }, null, 2)
  );
}

// ---------- Analiz ----------
async function analyzeFile(file: string, state: FileState) {
  const content = await Bun.file(file).text();
  const rel = relPath(file);
  const isNew = !state[rel];
  logEvent(isNew ? "📄" : "✏️", `${isNew ? "Yeni dosya tespit edildi" : "Değişiklik tespit edildi"}: ${rel}`);

  if (content.trim().length < 50) {
    // Çok kısa/boş dosyaları atla ama state'e işle — yoksa her tarama turunda sonsuza kadar "değişti" sanılıp yeniden denenir
    state[rel] = { hash: hashContent(content), lastAnalyzed: Date.now(), reportPath: "" };
    saveState(state);
    status.queue = status.queue.filter((f) => f !== rel);
    logEvent("⏭️", `Atlandı (çok kısa): ${rel}`);
    return;
  }

  const reportPath = join(REPORTS_DIR, `${rel}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });

  status.current = { file: rel, startedAt: Date.now(), streamText: "" };
  status.queue = status.queue.filter((f) => f !== rel);
  broadcast();

  console.log(`\n⏳ İNCELENİYOR: ${rel}`);

  let res: Response;
  try {
    res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt: `Sen kıdemli bir yazılım mimarısın. Aşağıdaki kod dosyasını incele. LÜTFEN SADECE TÜRKÇE YANIT VER. Mimarideki eksikleri, gereksiz render'ları ve iyileştirmeleri Markdown formatında raporla:\n\nKod:\n${content}`,
        stream: true,
        think: false,
      }),
    });
  } catch (error) {
    console.error(`❌ Hata: Ollama'ya bağlanılamadı (${OLLAMA_URL}).`);
    status.current = null;
    broadcast();
    return;
  }

  if (!res.ok || !res.body) {
    console.error(`❌ Hata: Sunucuyla iletişim kurulamadı.`);
    status.current = null;
    broadcast();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullReport = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.response) {
          process.stdout.write(parsed.response);
          fullReport += parsed.response;
          status.current!.streamText += parsed.response;
          broadcast();
        }
      } catch {
        // Yarım gelen JSON parçalarını sessizce es geç
      }
    }
  }

  mkdirSync(dirname(reportPath), { recursive: true }); // uzun süren istek boyunca klasör bir şekilde kaybolduysa diye tekrar garanti et
  writeFileSync(reportPath, fullReport);
  console.log(`\n✅ RAPOR YAZILDI: ${reportPath}`);
  logEvent("📖", `Rapor oluşturuldu: ${rel}`);

  const dependencies = extractDependencies(content).map((spec) => resolveLocalImport(file, spec) ?? spec);
  const facts = safeAnalyzeWithAst(file, content);
  const route = computeRoute(rel);
  const framework = dependencies.some((d) => d.startsWith("react-native"))
    ? "React Native"
    : dependencies.some((d) => d === "react" || d.startsWith("react/"))
      ? "React"
      : "TypeScript";
  logEvent("🌳", `AST oluşturuldu: ${rel} (${facts.objective.functions} fonksiyon, ${facts.entities.length} entity)`);

  const sidecar = await extractSidecarViaLLM(rel, facts, dependencies);
  logEvent("🧠", `Semantic bilgi çıkarıldı: ${rel}`);

  const sidecarPath = join(REPORTS_DIR, `${rel}.json`);
  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(
    sidecarPath,
    JSON.stringify(
      {
        file: rel,
        objective: { ...facts.objective, framework, ...route },
        semantic: { purpose: sidecar?.purpose ?? null },
        graph: { dependencies, calls: facts.calls, renders: facts.renders },
        entities: facts.entities,
        identity: { analysisId: randomUUID(), fileHash: hashContent(content), gitCommit: GIT_COMMIT },
        analyzedAt: Date.now(),
      },
      null,
      2
    )
  );
  if (!sidecar) console.warn(`⚠️  purpose LLM'den alınamadı: ${rel} (objective/entities parser'dan geldiği için yine de dolu)`);

  state[rel] = { hash: hashContent(content), lastAnalyzed: Date.now(), reportPath: relPath(reportPath) };
  saveState(state);

  status.current = null;
  status.completed.unshift({
    file: rel,
    reportPath: relPath(reportPath),
    finishedAt: Date.now(),
    preview: fullReport.slice(0, 240),
  });
  status.completed = status.completed.slice(0, 30);
  logEvent("✅", `Analiz tamamlandı: ${rel}`);
  broadcast();
}

// ---------- Sürekli döngü: sadece değişen dosyalar ----------
async function watchLoop() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const state = loadState();

  console.log("🤖 Otonom ajan başlatıldı. Değişen-dosya bazlı sürekli tarama modunda.");
  console.log(`📊 Dashboard: http://localhost:${DASHBOARD_PORT}`);

  while (true) {
    try {
      const files = getCodeFiles(TARGET_DIR);
      status.totalFiles = files.length;

      const changed = files.filter((f) => {
        const content = readFileSync(f, "utf-8");
        const rel = relPath(f);
        const prev = state[rel];
        return !prev || prev.hash !== hashContent(content);
      });

      status.queue = changed.map(relPath);
      status.idle = changed.length === 0;
      status.lastScanAt = Date.now();
      broadcast();

      if (changed.length > 0) {
        console.log(`\n🔎 ${changed.length} değişen dosya bulundu, analiz ediliyor...`);
        for (const file of changed) {
          try {
            await analyzeFile(file, state);
          } catch (error) {
            console.error(`❌ ${relPath(file)} analiz edilirken beklenmedik hata, atlanıyor:`, error);
            status.current = null;
            broadcast();
          }
          rebuildKnowledgeGraph(); // her dosyadan sonra artımlı güncelle, tüm turu beklemeden
          logEvent("🔗", `Bilgi grafiği güncellendi: ${relPath(file)}`);
        }
        console.log(`\n🧠 knowledge_graph.json güncellendi.`);
      }

      status.cycles += 1;
      status.idle = true;
      broadcast();
    } catch (error) {
      console.error("❌ Tarama turunda beklenmedik hata, döngü devam ediyor:", error);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ---------- Canlı dashboard sunucusu ----------
const DASHBOARD_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Kod Analiz Ajanı</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    background: #0b0e14; color: #d5dae3; min-height: 100vh;
  }
  header {
    padding: 20px 28px; border-bottom: 1px solid #1e2430;
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 600; letter-spacing: 0.3px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px;
    font-size: 12px; background: #141a24; border: 1px solid #232b3a;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ddc84; }
  .dot.busy { background: #ffb454; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  main { display: grid; grid-template-columns: 1.3fr 1fr; gap: 20px; padding: 24px 28px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .card {
    background: #10141c; border: 1px solid #1e2430; border-radius: 10px; padding: 18px;
  }
  .card h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.6px; color: #8b95a7; }
  .stream {
    font-size: 13px; line-height: 1.6; max-height: 60vh; overflow-y: auto;
    color: #b7f5c9;
  }
  .md h1, .md h2, .md h3 { margin: 14px 0 6px; color: #eaeef5; }
  .md h1 { font-size: 16px; }
  .md h2 { font-size: 15px; }
  .md h3 { font-size: 14px; }
  .md p { margin: 8px 0; }
  .md strong { color: #eaeef5; }
  .md em { color: #c9d1e0; }
  .md code { background: #1a2029; padding: 1px 5px; border-radius: 4px; font-size: 12px; color: #ffb454; }
  .md pre { background: #1a2029; padding: 10px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
  .md pre code { background: none; padding: 0; color: #b7f5c9; }
  .md ul { list-style: disc; margin: 6px 0 6px 20px; padding: 0; max-height: none; overflow: visible; }
  .md li { padding: 2px 0; border: none; }
  .current-file { font-size: 14px; color: #ffb454; margin-bottom: 10px; word-break: break-all; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; }
  .stat { background: #10141c; border: 1px solid #1e2430; border-radius: 10px; padding: 14px; text-align: center; }
  .stat .num { font-size: 22px; font-weight: 700; color: #7dc4ff; }
  .stat .label { font-size: 11px; color: #8b95a7; margin-top: 4px; }
  ul { list-style: none; margin: 0; padding: 0; max-height: 60vh; overflow-y: auto; }
  li { padding: 10px 0; border-bottom: 1px solid #1a2029; }
  li:last-child { border-bottom: none; }
  .fname { font-size: 13px; color: #d5dae3; word-break: break-all; }
  .fmeta { font-size: 11px; color: #6b7484; margin-top: 2px; }
  .preview { font-size: 12px; color: #8b95a7; margin-top: 6px; white-space: pre-wrap; }
  .queue-item { font-size: 12px; color: #8b95a7; padding: 4px 0; }
  .empty { color: #4a5262; font-size: 13px; }
  #completedList li, #searchResults li { cursor: pointer; transition: background 0.15s; border-radius: 6px; padding: 10px 8px; }
  #completedList li:hover, #searchResults li:hover { background: #161c26; }
  #searchInput {
    width: 100%; box-sizing: border-box; background: #0b0e14; border: 1px solid #232b3a; border-radius: 6px;
    color: #d5dae3; padding: 8px 10px; font-family: inherit; font-size: 13px; margin-bottom: 10px;
  }
  #searchInput:focus { outline: none; border-color: #3d5a80; }
  .importance-badge { color: #7dc4ff; font-weight: 600; }
  .event-log { max-height: 220px; overflow-y: auto; font-size: 12px; }
  .event-item {
    display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid #1a2029;
    animation: eventIn 0.25s ease; align-items: baseline;
  }
  .event-item:last-child { border-bottom: none; }
  .event-time { color: #6b7484; flex-shrink: 0; }
  .event-icon { flex-shrink: 0; }
  .event-msg { color: #d5dae3; word-break: break-all; }
  @keyframes eventIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  .overlay {
    display: none; position: fixed; inset: 0; background: rgba(4,6,10,0.72);
    align-items: center; justify-content: center; padding: 30px; z-index: 10;
  }
  .overlay.open { display: flex; }
  .modal {
    background: #10141c; border: 1px solid #232b3a; border-radius: 12px;
    width: min(820px, 100%); max-height: 85vh; display: flex; flex-direction: column;
  }
  .modal-header {
    padding: 16px 20px; border-bottom: 1px solid #1e2430; display: flex; justify-content: space-between; align-items: center; gap: 12px;
  }
  .modal-title { font-size: 13px; color: #ffb454; word-break: break-all; }
  .modal-close {
    background: #161c26; border: 1px solid #232b3a; color: #d5dae3; border-radius: 6px;
    width: 28px; height: 28px; cursor: pointer; font-size: 14px; flex-shrink: 0;
  }
  .modal-close:hover { background: #1e2430; }
  .modal-body { padding: 20px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: #b7f5c9; }
  .graph-modal { width: min(1400px, 96vw) !important; height: 88vh; }
  .graph-modal .modal-body { padding: 0; display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .graph-toolbar { display: flex; align-items: center; gap: 14px; padding: 10px 20px; border-bottom: 1px solid #1e2430; flex-wrap: wrap; }
  .graph-legend { display: flex; gap: 8px; flex-wrap: wrap; }
  .legend-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px;
    font-size: 11px; background: #141a24; border: 1px solid #232b3a; cursor: pointer; user-select: none;
    color: #d5dae3; transition: opacity 0.15s;
  }
  .legend-chip.off { opacity: 0.35; }
  .legend-swatch { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .graph-main { flex: 1; display: flex; overflow: hidden; }
  .graph-canvas-wrap { position: relative; flex: 1; overflow: hidden; background: #0b0e14; }
  #graphSvg { width: 100%; height: 100%; display: block; cursor: grab; }
  #graphSvg.dragging { cursor: grabbing; }
  .graph-edge { stroke: #2a3444; stroke-width: 1; fill: none; }
  .graph-node circle { stroke: #0b0e14; stroke-width: 1.5; cursor: pointer; }
  .graph-node text { fill: #d5dae3; font-size: 10px; pointer-events: none; }
  .graph-tooltip {
    position: absolute; pointer-events: none; background: #10141c; border: 1px solid #232b3a;
    border-radius: 8px; padding: 10px 12px; font-size: 12px; max-width: 280px; line-height: 1.5;
    color: #d5dae3; box-shadow: 0 8px 24px rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.1s; z-index: 20;
  }
  .graph-tooltip .gt-title { color: #ffb454; font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  .graph-tooltip .gt-meta { color: #8b95a7; }
  .graph-detail-panel { width: 320px; flex-shrink: 0; border-left: 1px solid #1e2430; background: #10141c; overflow-y: auto; padding: 18px; }
  .gdp-empty { color: #4a5262; font-size: 13px; text-align: center; margin-top: 40px; }
  .gdp-file { font-size: 14px; color: #ffb454; word-break: break-all; margin-bottom: 8px; font-weight: 600; }
  .gdp-badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; color: #0b0e14; margin-bottom: 6px; margin-right: 6px; }
  .gdp-route { font-size: 11px; color: #7dc4ff; margin-bottom: 12px; font-family: ui-monospace, monospace; }
  .gdp-reason { font-size: 12px; color: #d5dae3; padding: 2px 0 2px 14px; position: relative; line-height: 1.5; }
  .gdp-reason::before { content: "•"; position: absolute; left: 0; color: #6b7484; }
  .gdp-risk-formula { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; margin: 8px 0; padding: 8px 10px; background: #0b0e14; border: 1px solid #1e2430; border-radius: 8px; }
  .gdp-risk-row { display: flex; justify-content: space-between; padding: 2px 0; color: #8b95a7; }
  .gdp-risk-row .contrib { color: #7dc4ff; }
  .gdp-risk-total { display: flex; justify-content: space-between; padding-top: 6px; margin-top: 4px; border-top: 1px solid #1e2430; font-weight: 600; color: #d5dae3; }
  .gdp-risk-total .contrib { color: #ffb454; }
  .gdp-section { margin-top: 16px; }
  .gdp-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7484; margin-bottom: 6px; }
  .gdp-value { font-size: 13px; color: #d5dae3; line-height: 1.5; }
  .gdp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
  .gdp-stat { background: #0b0e14; border: 1px solid #1e2430; border-radius: 8px; padding: 8px 10px; }
  .gdp-stat .num { font-size: 16px; font-weight: 700; color: #7dc4ff; }
  .gdp-stat .label { font-size: 10px; color: #6b7484; margin-top: 2px; }
  .gdp-entity { font-size: 11px; color: #b7f5c9; padding: 3px 0; border-bottom: 1px solid #161c26; }
  .gdp-entity:last-child { border-bottom: none; }
  .gdp-entity .et { color: #6b7484; margin-left: 4px; }
  .gdp-ai-summary { font-size: 12px; color: #b7f5c9; line-height: 1.6; min-height: 20px; }
  .gdp-ai-btn, .gdp-report-btn {
    width: 100%; margin-top: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid #232b3a;
    background: #161c26; color: #d5dae3; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .gdp-ai-btn:hover, .gdp-report-btn:hover { background: #1e2430; }
  .gdp-ai-btn:disabled { opacity: 0.5; cursor: default; }
  .gdp-report-btn { margin-top: 20px; color: #ffb454; }
</style>
</head>
<body>
<header>
  <h1>🤖 AI Kod Analiz Ajanı — gemma4:26b</h1>
  <div style="display:flex; align-items:center; gap:10px;">
    <div class="badge" id="graphBtn" style="cursor:pointer;">🕸️ Bağımlılık Grafiği</div>
    <div class="badge"><span class="dot" id="statusDot"></span><span id="statusText">bağlanıyor...</span></div>
  </div>
</header>
<main>
  <div>
    <div class="stats">
      <div class="stat"><div class="num" id="statTotal">-</div><div class="label">toplam dosya</div></div>
      <div class="stat"><div class="num" id="statCycles">-</div><div class="label">tarama turu</div></div>
      <div class="stat"><div class="num" id="statQueue">-</div><div class="label">kuyrukta</div></div>
    </div>
    <div class="card" style="margin-bottom:20px;">
      <h2>şu an inceleniyor</h2>
      <div class="current-file" id="currentFile">— boşta —</div>
      <div class="stream" id="streamText"></div>
    </div>
    <div class="card">
      <h2>canlı olay akışı</h2>
      <div class="event-log" id="eventLog"><div class="empty">henüz olay yok</div></div>
    </div>
  </div>
  <div>
    <div class="card" style="margin-bottom:20px;">
      <h2>bilgi grafiğinde ara</h2>
      <input type="text" id="searchInput" placeholder="örn: question generation, useState, react-native..." />
      <ul id="searchResults"></ul>
    </div>
    <div class="card" style="margin-bottom:20px;">
      <h2>kuyruk</h2>
      <div id="queueList"><div class="empty">değişen dosya yok</div></div>
    </div>
    <div class="card">
      <h2>tamamlanan raporlar <span style="font-weight:400; color:#4a5262;">(açmak için tıkla)</span></h2>
      <ul id="completedList"><li class="empty">henüz yok</li></ul>
    </div>
  </div>
</main>
<div class="overlay" id="overlay">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="modalTitle"></div>
      <button class="modal-close" id="modalClose">✕</button>
    </div>
    <div class="modal-body md" id="modalBody"></div>
  </div>
</div>
<div class="overlay" id="graphOverlay">
  <div class="modal graph-modal">
    <div class="modal-header">
      <div class="modal-title">🕸️ Dosya Bağımlılık Grafiği</div>
      <button class="modal-close" id="graphClose">✕</button>
    </div>
    <div class="modal-body">
      <div class="graph-toolbar">
        <div class="graph-legend" id="graphLegend"></div>
        <div style="margin-left:auto; font-size:11px; color:#6b7484;" id="graphMeta"></div>
      </div>
      <div class="graph-main">
        <div class="graph-canvas-wrap">
          <svg id="graphSvg"></svg>
          <div class="graph-tooltip" id="graphTooltip"></div>
        </div>
        <div class="graph-detail-panel" id="graphDetailPanel">
          <div id="gdpEmpty" class="gdp-empty">Detay görmek için bir dosyaya tıkla</div>
          <div id="gdpContent" style="display:none;">
            <div class="gdp-file" id="gdpFile"></div>
            <div>
              <div class="gdp-badge" id="gdpLayer"></div>
              <div class="gdp-badge" id="gdpRisk"></div>
            </div>
            <div class="gdp-route" id="gdpRoute"></div>
            <div class="gdp-risk-formula" id="gdpRiskFormula"></div>
            <div class="gdp-section">
              <div class="gdp-label">Neden bu risk?</div>
              <div id="gdpRiskReasons"></div>
            </div>
            <div class="gdp-section">
              <div class="gdp-label">Purpose</div>
              <div class="gdp-value" id="gdpPurpose"></div>
            </div>
            <div class="gdp-grid" id="gdpStats"></div>
            <div class="gdp-section">
              <div class="gdp-label">Entities</div>
              <div id="gdpEntities"></div>
            </div>
            <div class="gdp-section">
              <div class="gdp-label">🧠 AI Özeti</div>
              <div class="gdp-ai-summary" id="gdpAiSummary"></div>
              <button class="gdp-ai-btn" id="gdpAiBtn">🧠 Derin AI Özeti Oluştur</button>
            </div>
            <button class="gdp-report-btn" id="gdpOpenReport">📄 Tam Raporu Aç</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdown(md) {
    if (!md) return "";
    let html = escapeHtml(md);

    html = html.replace(/\`\`\`([^]*?)\`\`\`/g, (_, code) => \`<pre><code>\${code.trim()}</code></pre>\`);
    html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
    html = html.replace(/[*]{2}(.+?)[*]{2}/g, "<strong>$1</strong>");
    html = html.replace(/(?<![*])[*](?![*])(.+?)(?<![*])[*](?![*])/g, "<em>$1</em>");
    html = html.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
    html = html.replace(/(^|\\n)((?:[-*] .*(?:\\n|$))+)/g, (m, lead, block) => {
      const items = block.trim().split("\\n").map(l => \`<li>\${l.slice(2)}</li>\`).join("");
      return \`\${lead}<ul>\${items}</ul>\`;
    });
    html = html.split(/\\n{2,}/).map(block => {
      if (/^<(h1|h2|h3|ul|pre)/.test(block.trim())) return block;
      return block.trim() ? \`<p>\${block.trim().replace(/\\n/g, "<br>")}</p>\` : "";
    }).join("");

    return html;
  }

  let graphCache = null;
  let lastGraphCycle = -1;
  let lastEventsSignature = "";

  async function loadGraph() {
    if (!graphCache) {
      const res = await fetch("/graph");
      graphCache = await res.json();
    }
    return graphCache;
  }

  function renderSearchResults(matches) {
    const el = document.getElementById("searchResults");
    el.innerHTML = matches.length
      ? matches.map(n => \`<li data-path="ai-reports/\${n.file}.md" data-file="\${n.file}">
          <div class="fname">📄 \${n.file} \${(n.objective && n.objective.route) ? \`<span class="importance-badge">\${n.objective.route}</span>\` : ""} <span class="importance-badge">· \${n.importance || 0} bağımlı</span></div>
          <div class="fmeta">\${(n.semantic && n.semantic.purpose) || "amaç bilgisi yok"} <span style="color:#4a5262;">· \${(n.objective && n.objective.framework) || ""}</span></div>
          <div class="preview">\${(n.entities || []).map(en => en.name).join(", ")}\${(n.graph && n.graph.renders && n.graph.renders.length) ? " · render: " + n.graph.renders.slice(0, 6).join(", ") : ""}</div>
        </li>\`).join("")
      : '<li class="empty">sonuç yok</li>';
  }

  let searchDebounce;
  document.getElementById("searchInput").addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim().toLowerCase();
    searchDebounce = setTimeout(async () => {
      if (!q) { document.getElementById("searchResults").innerHTML = ""; return; }
      const graph = await loadGraph();
      const nodes = Object.values(graph.nodes || {});
      const matches = nodes.filter(n => {
        const hay = [
          n.file,
          n.semantic && n.semantic.purpose,
          n.objective && n.objective.route,
          ...(n.entities || []).map(en => en.name),
          ...((n.graph && n.graph.dependencies) || []),
          ...((n.graph && n.graph.renders) || [])
        ].join(" ").toLowerCase();
        return hay.includes(q);
      }).sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 15);
      renderSearchResults(matches);
    }, 200);
  });

  const es = new EventSource("/events");
  es.onmessage = (e) => {
    const s = JSON.parse(e.data);
    if (s.cycles !== lastGraphCycle) { lastGraphCycle = s.cycles; graphCache = null; }
    document.getElementById("statTotal").textContent = s.totalFiles;
    document.getElementById("statCycles").textContent = s.cycles;
    document.getElementById("statQueue").textContent = s.queue.length;

    const dot = document.getElementById("statusDot");
    const txt = document.getElementById("statusText");
    if (s.current) {
      dot.classList.add("busy"); txt.textContent = "analiz ediyor";
    } else {
      dot.classList.remove("busy"); txt.textContent = s.idle ? "izliyor (boşta)" : "hazırlanıyor";
    }

    document.getElementById("currentFile").textContent = s.current ? s.current.file : "— boşta —";
    const streamEl = document.getElementById("streamText");
    streamEl.innerHTML = s.current ? \`<div class="md">\${renderMarkdown(s.current.streamText)}</div>\` : "";
    streamEl.scrollTop = streamEl.scrollHeight;

    const q = document.getElementById("queueList");
    q.innerHTML = s.queue.length
      ? s.queue.map(f => \`<div class="queue-item">⏳ \${f}</div>\`).join("")
      : '<div class="empty">değişen dosya yok</div>';

    const events = s.events || [];
    const eventsSignature = events.length + ":" + (events[0] ? events[0].time : "");
    if (eventsSignature !== lastEventsSignature) {
      lastEventsSignature = eventsSignature;
      const eventLog = document.getElementById("eventLog");
      eventLog.innerHTML = events.length
        ? events.map(ev => \`<div class="event-item">
            <span class="event-time">\${new Date(ev.time).toLocaleTimeString("tr-TR")}</span>
            <span class="event-icon">\${ev.icon}</span>
            <span class="event-msg">\${escapeHtml(ev.message)}</span>
          </div>\`).join("")
        : '<div class="empty">henüz olay yok</div>';
    }

    const list = document.getElementById("completedList");
    list.innerHTML = s.completed.length
      ? s.completed.map(c => \`<li data-path="\${c.reportPath}" data-file="\${c.file}">
          <div class="fname">✅ \${c.file}</div>
          <div class="fmeta">\${new Date(c.finishedAt).toLocaleTimeString("tr-TR")} · \${c.reportPath}</div>
          <div class="preview md">\${renderMarkdown(c.preview)}…</div>
        </li>\`).join("")
      : '<li class="empty">henüz yok</li>';
  };

  const overlay = document.getElementById("overlay");
  const modalTitle = document.getElementById("modalTitle");
  const modalBody = document.getElementById("modalBody");

  function closeModal() {
    overlay.classList.remove("open");
    modalBody.innerHTML = "";
  }

  async function openReport(path, file) {
    modalTitle.textContent = file;
    modalBody.innerHTML = "<p>Yükleniyor…</p>";
    overlay.classList.add("open");

    try {
      const res = await fetch("/report?path=" + encodeURIComponent(path));
      if (!res.ok) throw new Error("Rapor alınamadı");
      const data = await res.json();
      modalBody.innerHTML = renderMarkdown(data.content);
    } catch (err) {
      modalBody.innerHTML = "<p>Rapor yüklenemedi.</p>";
    }
  }

  function wireReportClicks(containerId) {
    document.getElementById(containerId).addEventListener("click", (e) => {
      const li = e.target.closest("li[data-path]");
      if (!li) return;
      openReport(li.dataset.path, li.dataset.file);
    });
  }
  wireReportClicks("completedList");
  wireReportClicks("searchResults");

  document.getElementById("modalClose").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  // ---------- Bağımlılık grafiği ----------
  const CATEGORY_META = {
    ui:       { label: "UI (app + components)", color: "#3987e5" },
    database: { label: "Database", color: "#199e70" },
    hooks:    { label: "Hooks", color: "#c98500" },
    services: { label: "Services (LLM)", color: "#008300" },
    theme:    { label: "Theme & Context", color: "#9085e9" },
    i18n:     { label: "i18n & Sabitler", color: "#e66767" },
    root:     { label: "Kök / Araçlar", color: "#d55181" },
  };

  function categoryOf(file) {
    if (file.indexOf("src/app/") === 0 || file.indexOf("src/components/") === 0) return "ui";
    if (file.indexOf("src/services/db/") === 0) return "database";
    if (file.indexOf("src/hooks/") === 0) return "hooks";
    if (file.indexOf("src/services/") === 0) return "services";
    if (file.indexOf("src/theme/") === 0 || file === "src/context/ThemeContext.tsx") return "theme";
    if (file.indexOf("src/i18n/") === 0 || file.indexOf("src/constants/") === 0) return "i18n";
    return "root";
  }

  let depGraphNodes = null;
  let depGraphEdges = null;
  const hiddenCategories = new Set();
  const svgNS = "http://www.w3.org/2000/svg";

  // Sürüklemede window'a per-node listener eklemek yerine tek global state kullanıyoruz —
  // aksi halde overlay her açılışta renderDepGraph tekrar çalışıp eski listener'lar birikirdi.
  let draggedNode = null;
  window.addEventListener("mousemove", (ev) => {
    if (!draggedNode) return;
    const rect = draggedNode.svg.getBoundingClientRect();
    draggedNode.d.x = (ev.clientX - rect.left) * (draggedNode.width / rect.width);
    draggedNode.d.y = (ev.clientY - rect.top) * (draggedNode.height / rect.height);
    draggedNode.g.setAttribute("transform", "translate(" + draggedNode.d.x + "," + draggedNode.d.y + ")");
    (draggedNode.nodeEdgeMap.get(draggedNode.d.id) || []).forEach((rec) => {
      rec.line.setAttribute("x1", rec.s.x); rec.line.setAttribute("y1", rec.s.y);
      rec.line.setAttribute("x2", rec.t.x); rec.line.setAttribute("y2", rec.t.y);
    });
  });
  window.addEventListener("mouseup", () => {
    if (draggedNode) draggedNode.svg.classList.remove("dragging");
    draggedNode = null;
  });

  function buildDepGraph(graph) {
    const nodesObj = graph.nodes || {};
    const ids = Object.keys(nodesObj);
    const nodes = ids.map((id) => {
      const n = nodesObj[id];
      const importedBy = n.importedBy || [];
      const deps = (n.graph && n.graph.dependencies) || [];
      return {
        id: id,
        file: n.file,
        category: categoryOf(id),
        importance: n.importance || 0,
        purpose: (n.semantic && n.semantic.purpose) || "",
        deepSummary: (n.semantic && n.semantic.deepSummary) || "",
        route: (n.objective && n.objective.route) || null,
        lines: (n.objective && n.objective.lines) || 0,
        functions: (n.objective && n.objective.functions) || 0,
        hooks: (n.objective && n.objective.hooks) || 0,
        components: (n.objective && n.objective.components) || 0,
        exports: (n.objective && n.objective.exports) || 0,
        callsCount: ((n.graph && n.graph.calls) || []).length,
        entities: n.entities || [],
        inCount: importedBy.length,
        outCount: deps.filter((d) => nodesObj[d]).length,
      };
    });
    const edges = [];
    for (const id of ids) {
      const deps = (nodesObj[id].graph && nodesObj[id].graph.dependencies) || [];
      for (const d of deps) {
        if (nodesObj[d]) edges.push({ source: id, target: d });
      }
    }
    return { nodes: nodes, edges: edges };
  }

  function layoutDepGraph(nodes, edges, width, height) {
    const idIndex = new Map(nodes.map((d, i) => [d.id, i]));
    nodes.forEach((d, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      const radius = Math.min(width, height) * 0.35;
      d.x = width / 2 + Math.cos(angle) * radius;
      d.y = height / 2 + Math.sin(angle) * radius;
      d.vx = 0;
      d.vy = 0;
    });
    const pairs = edges
      .map((e) => [idIndex.get(e.source), idIndex.get(e.target)])
      .filter((p) => p[0] !== undefined && p[1] !== undefined);

    const REPULSION = 2800;
    const LINK_DIST = 95;
    const LINK_STRENGTH = 0.05;
    const CENTER_STRENGTH = 0.006;
    const DAMPING = 0.82;

    for (let iter = 0; iter < 260; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const distSq = dx * dx + dy * dy || 0.01;
          const dist = Math.sqrt(distSq);
          const force = REPULSION / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          nodes[i].vx += fx; nodes[i].vy += fy;
          nodes[j].vx -= fx; nodes[j].vy -= fy;
        }
      }
      for (const p of pairs) {
        const a = nodes[p[0]], b = nodes[p[1]];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const diff = (dist - LINK_DIST) * LINK_STRENGTH;
        const fx = (dx / dist) * diff;
        const fy = (dy / dist) * diff;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      for (const d of nodes) {
        d.vx += (width / 2 - d.x) * CENTER_STRENGTH;
        d.vy += (height / 2 - d.y) * CENTER_STRENGTH;
        d.vx *= DAMPING; d.vy *= DAMPING;
        d.x += d.vx; d.y += d.vy;
        d.x = Math.max(24, Math.min(width - 24, d.x));
        d.y = Math.max(24, Math.min(height - 24, d.y));
      }
    }
    return nodes;
  }

  function radiusOf(d) {
    return Math.min(22, 5 + d.importance * 2.2);
  }

  // ---------- Risk skoru: %100 deterministik, parser verisinden hesaplanır — LLM'e sorulmaz ----------
  // score = dependents*3 + exports*2 + calls + lines/100 (eşikler bu repodaki gerçek dağılıma göre kalibre edildi)
  function computeRisk(d) {
    const score = d.inCount * 3 + d.exports * 2 + d.callsCount + d.lines / 100;
    return Math.round(score * 10) / 10;
  }

  function riskTier(score) {
    if (score >= 60) return { emoji: "🔴", label: "Critical", color: "#e66767" };
    if (score >= 30) return { emoji: "🟠", label: "High", color: "#eb6834" };
    if (score >= 12) return { emoji: "🟡", label: "Medium", color: "#c98500" };
    return { emoji: "🟢", label: "Low", color: "#008300" };
  }

  function riskReasons(d) {
    const reasons = [];
    if (d.inCount > 0) reasons.push(d.inCount + " dosya tarafından kullanılıyor");
    if (d.exports > 0) reasons.push(d.exports + " export içeriyor (public API)");
    if (d.callsCount >= 15) reasons.push("Yüksek karmaşıklık (" + d.callsCount + "+ farklı çağrı)");
    if (d.lines >= 400) reasons.push("Büyük dosya (" + d.lines + " satır)");
    if (reasons.length === 0) reasons.push("Düşük etki alanı, izole bir dosya");
    return reasons;
  }

  function renderDepGraph() {
    const svg = document.getElementById("graphSvg");
    svg.innerHTML = "";
    const wrap = svg.parentElement;
    const width = wrap.clientWidth || 1000;
    const height = wrap.clientHeight || 640;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);

    const nodeById = new Map(depGraphNodes.map((d) => [d.id, d]));
    const edgeLayer = document.createElementNS(svgNS, "g");
    const nodeLayer = document.createElementNS(svgNS, "g");
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);

    const nodeEdgeMap = new Map();
    for (const e of depGraphEdges) {
      const s = nodeById.get(e.source);
      const t = nodeById.get(e.target);
      if (!s || !t) continue;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("class", "graph-edge");
      line.setAttribute("x1", s.x); line.setAttribute("y1", s.y);
      line.setAttribute("x2", t.x); line.setAttribute("y2", t.y);
      line.dataset.sCat = s.category;
      line.dataset.tCat = t.category;
      edgeLayer.appendChild(line);
      const rec = { line: line, s: s, t: t };
      if (!nodeEdgeMap.has(s.id)) nodeEdgeMap.set(s.id, []);
      if (!nodeEdgeMap.has(t.id)) nodeEdgeMap.set(t.id, []);
      nodeEdgeMap.get(s.id).push(rec);
      nodeEdgeMap.get(t.id).push(rec);
    }

    const tooltip = document.getElementById("graphTooltip");

    function updateEdgesFor(id) {
      (nodeEdgeMap.get(id) || []).forEach((rec) => {
        rec.line.setAttribute("x1", rec.s.x); rec.line.setAttribute("y1", rec.s.y);
        rec.line.setAttribute("x2", rec.t.x); rec.line.setAttribute("y2", rec.t.y);
      });
    }

    for (const d of depGraphNodes) {
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "graph-node");
      g.setAttribute("transform", "translate(" + d.x + "," + d.y + ")");
      g.dataset.category = d.category;
      g.style.opacity = hiddenCategories.has(d.category) ? "0.12" : "1";

      const titleEl = document.createElementNS(svgNS, "title");
      titleEl.textContent = d.file;
      g.appendChild(titleEl);

      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("r", String(radiusOf(d)));
      circle.setAttribute("fill", CATEGORY_META[d.category].color);
      g.appendChild(circle);

      if (d.importance >= 5) {
        const label = document.createElementNS(svgNS, "text");
        label.textContent = d.file.split("/").pop();
        label.setAttribute("x", String(radiusOf(d) + 5));
        label.setAttribute("y", "4");
        g.appendChild(label);
      }

      g.addEventListener("mouseenter", () => {
        (nodeEdgeMap.get(d.id) || []).forEach((rec) => rec.line.setAttribute("stroke", "#ffb454"));
        circle.setAttribute("stroke", "#ffb454");
        tooltip.innerHTML = "";
        const titleDiv = document.createElement("div");
        titleDiv.className = "gt-title";
        titleDiv.textContent = d.file;
        const meta = document.createElement("div");
        meta.className = "gt-meta";
        meta.textContent = (d.route ? "rota: " + d.route + " · " : "") + d.lines + " satır · " + d.inCount + " tarafından kullanılıyor · " + d.outCount + " bağımlılık";
        const purpose = document.createElement("div");
        purpose.style.marginTop = "4px";
        purpose.textContent = d.purpose || "amaç bilgisi yok";
        tooltip.appendChild(titleDiv);
        tooltip.appendChild(meta);
        tooltip.appendChild(purpose);
        tooltip.style.opacity = "1";
      });
      g.addEventListener("mousemove", (ev) => {
        const rect = wrap.getBoundingClientRect();
        tooltip.style.left = (ev.clientX - rect.left + 16) + "px";
        tooltip.style.top = (ev.clientY - rect.top + 16) + "px";
      });
      g.addEventListener("mouseleave", () => {
        (nodeEdgeMap.get(d.id) || []).forEach((rec) => rec.line.removeAttribute("stroke"));
        circle.removeAttribute("stroke");
        tooltip.style.opacity = "0";
      });
      g.addEventListener("click", () => {
        selectNode(d);
      });

      g.addEventListener("mousedown", (ev) => {
        draggedNode = { d: d, g: g, nodeEdgeMap: nodeEdgeMap, width: width, height: height, svg: svg };
        svg.classList.add("dragging");
        ev.stopPropagation();
      });

      nodeLayer.appendChild(g);
    }

    applyCategoryFilter();
  }

  function selectNode(d) {
    document.getElementById("gdpEmpty").style.display = "none";
    const content = document.getElementById("gdpContent");
    content.style.display = "block";

    document.getElementById("gdpFile").textContent = d.file;
    const badge = document.getElementById("gdpLayer");
    badge.textContent = CATEGORY_META[d.category].label;
    badge.style.background = CATEGORY_META[d.category].color;

    const score = computeRisk(d);
    const tier = riskTier(score);
    const riskBadge = document.getElementById("gdpRisk");
    riskBadge.textContent = tier.emoji + " " + tier.label + " (" + score + ")";
    riskBadge.style.background = tier.color;

    const formulaEl = document.getElementById("gdpRiskFormula");
    formulaEl.innerHTML = "";
    const terms = [
      { label: "Dependents (" + d.inCount + " × 3)", value: d.inCount * 3 },
      { label: "Exports (" + d.exports + " × 2)", value: d.exports * 2 },
      { label: "Calls (" + d.callsCount + " × 1)", value: d.callsCount },
      { label: "Lines (" + d.lines + " ÷ 100)", value: Math.round((d.lines / 100) * 10) / 10 },
    ];
    terms.forEach((t) => {
      const row = document.createElement("div");
      row.className = "gdp-risk-row";
      const label = document.createElement("span");
      label.textContent = t.label;
      const contrib = document.createElement("span");
      contrib.className = "contrib";
      contrib.textContent = "+" + t.value;
      row.appendChild(label);
      row.appendChild(contrib);
      formulaEl.appendChild(row);
    });
    const totalRow = document.createElement("div");
    totalRow.className = "gdp-risk-total";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "Toplam Skor";
    const totalVal = document.createElement("span");
    totalVal.className = "contrib";
    totalVal.textContent = String(score);
    totalRow.appendChild(totalLabel);
    totalRow.appendChild(totalVal);
    formulaEl.appendChild(totalRow);

    const reasonsEl = document.getElementById("gdpRiskReasons");
    reasonsEl.innerHTML = "";
    riskReasons(d).forEach((r) => {
      const row = document.createElement("div");
      row.className = "gdp-reason";
      row.textContent = r;
      reasonsEl.appendChild(row);
    });

    const routeEl = document.getElementById("gdpRoute");
    if (d.route) {
      routeEl.textContent = "rota: " + d.route;
      routeEl.style.display = "block";
    } else {
      routeEl.style.display = "none";
    }
    document.getElementById("gdpPurpose").textContent = d.purpose || "amaç bilgisi yok";

    const stats = [
      { num: d.inCount, label: "Dependents" },
      { num: d.outCount, label: "Imports" },
      { num: d.exports, label: "Exports" },
      { num: d.functions, label: "Functions" },
      { num: d.hooks, label: "Hooks" },
      { num: d.components, label: "Components" },
      { num: d.lines, label: "Lines" },
    ];
    const statsEl = document.getElementById("gdpStats");
    statsEl.innerHTML = "";
    stats.forEach((s) => {
      const box = document.createElement("div");
      box.className = "gdp-stat";
      const num = document.createElement("div");
      num.className = "num";
      num.textContent = String(s.num);
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = s.label;
      box.appendChild(num);
      box.appendChild(label);
      statsEl.appendChild(box);
    });

    const entitiesEl = document.getElementById("gdpEntities");
    entitiesEl.innerHTML = "";
    if (d.entities.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gdp-entity";
      empty.textContent = "yok";
      entitiesEl.appendChild(empty);
    } else {
      d.entities.forEach((e) => {
        const row = document.createElement("div");
        row.className = "gdp-entity";
        row.textContent = e.name;
        const type = document.createElement("span");
        type.className = "et";
        type.textContent = "· " + e.type + (e.async ? " · async" : "") + (e.exported ? " · exported" : "");
        row.appendChild(type);
        entitiesEl.appendChild(row);
      });
    }

    const aiSummaryEl = document.getElementById("gdpAiSummary");
    aiSummaryEl.textContent = d.deepSummary || "";
    const aiBtn = document.getElementById("gdpAiBtn");
    aiBtn.disabled = false;
    aiBtn.textContent = d.deepSummary ? "🔄 Yeniden Oluştur" : "🧠 Derin AI Özeti Oluştur";
    aiBtn.onclick = async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = "⏳ gemma4:26b düşünüyor...";
      if (!d.deepSummary) aiSummaryEl.textContent = "İşleniyor...";
      try {
        const refreshParam = d.deepSummary ? "&refresh=1" : "";
        const res = await fetch("/explain?file=" + encodeURIComponent(d.file) + refreshParam);
        const data = await res.json();
        if (data.summary) {
          d.deepSummary = data.summary;
          aiSummaryEl.textContent = data.summary;
        } else {
          aiSummaryEl.textContent = "Özet alınamadı: " + (data.error || "bilinmeyen hata");
        }
      } catch (err) {
        aiSummaryEl.textContent = "İstek başarısız oldu.";
      }
      aiBtn.disabled = false;
      aiBtn.textContent = d.deepSummary ? "🔄 Yeniden Oluştur" : "🧠 Derin AI Özeti Oluştur";
    };

    document.getElementById("gdpOpenReport").onclick = () => {
      openReport("ai-reports/" + d.file + ".md", d.file);
    };
  }

  function applyCategoryFilter() {
    document.querySelectorAll("#graphSvg .graph-node").forEach((g) => {
      g.style.opacity = hiddenCategories.has(g.dataset.category) ? "0.12" : "1";
    });
    document.querySelectorAll("#graphSvg .graph-edge").forEach((line) => {
      const dim = hiddenCategories.has(line.dataset.sCat) || hiddenCategories.has(line.dataset.tCat);
      line.style.opacity = dim ? "0.05" : "";
    });
  }

  function renderLegend() {
    const el = document.getElementById("graphLegend");
    el.innerHTML = "";
    Object.keys(CATEGORY_META).forEach((cat) => {
      const meta = CATEGORY_META[cat];
      const count = depGraphNodes.filter((n) => n.category === cat).length;
      const chip = document.createElement("div");
      chip.className = "legend-chip" + (hiddenCategories.has(cat) ? " off" : "");
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = meta.color;
      chip.appendChild(swatch);
      const text = document.createElement("span");
      text.textContent = meta.label + " (" + count + ")";
      chip.appendChild(text);
      chip.addEventListener("click", () => {
        if (hiddenCategories.has(cat)) hiddenCategories.delete(cat); else hiddenCategories.add(cat);
        applyCategoryFilter();
        renderLegend();
      });
      el.appendChild(chip);
    });
  }

  const graphOverlayEl = document.getElementById("graphOverlay");
  let graphBuilt = false;
  document.getElementById("graphBtn").addEventListener("click", async () => {
    graphOverlayEl.classList.add("open");
    const graph = await loadGraph();
    if (!graphBuilt) {
      const built = buildDepGraph(graph);
      depGraphNodes = built.nodes;
      depGraphEdges = built.edges;
      const wrap = document.querySelector(".graph-canvas-wrap");
      layoutDepGraph(depGraphNodes, depGraphEdges, wrap.clientWidth || 1000, wrap.clientHeight || 640);
      graphBuilt = true;
    }
    renderLegend();
    renderDepGraph();
    document.getElementById("graphMeta").textContent = depGraphNodes.length + " dosya · " + depGraphEdges.length + " bağımlılık";
  });
  document.getElementById("graphClose").addEventListener("click", () => graphOverlayEl.classList.remove("open"));
  graphOverlayEl.addEventListener("click", (e) => { if (e.target === graphOverlayEl) graphOverlayEl.classList.remove("open"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") graphOverlayEl.classList.remove("open"); });
</script>
</body>
</html>`;

function startDashboard() {
  Bun.serve({
    port: DASHBOARD_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/events") {
        let send: (data: string) => void;
        const stream = new ReadableStream({
          start(controller) {
            send = (data: string) => controller.enqueue(new TextEncoder().encode(data));
            listeners.add(send);
            send(`data: ${JSON.stringify(status)}\n\n`);
          },
          cancel() {
            listeners.delete(send);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/status") {
        return Response.json(status);
      }

      if (url.pathname === "/graph") {
        const graphPath = join(REPORTS_DIR, "knowledge_graph.json");
        if (!existsSync(graphPath)) return Response.json({ generatedAt: null, nodes: {} });
        return new Response(readFileSync(graphPath, "utf-8"), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/report") {
        const rel = url.searchParams.get("path") || "";
        const fullPath = join(TARGET_DIR, rel);
        if (!fullPath.startsWith(REPORTS_DIR) || !existsSync(fullPath)) {
          return new Response("Rapor bulunamadı.", { status: 404 });
        }
        return Response.json({ path: rel, content: readFileSync(fullPath, "utf-8") });
      }

      if (url.pathname === "/explain") {
        return handleExplainRequest(url);
      }

      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });
}

startDashboard();
watchLoop();
