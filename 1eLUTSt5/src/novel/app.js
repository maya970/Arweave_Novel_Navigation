import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * @typedef {{
 *   v: number,
 *   kind: 'intro'|'chapter',
 *   recordClass: 'novel-intro'|'novel-chapter',
 *   recordKey: string,
 *   novelId: string,
 *   bookTitle?: string,
 *   author?: string,
 *   chapterIndex: number | null,
 *   chapterTitle?: string,
 *   ownerAddress: string,
 *   contentSha256: string,
 *   mirrorNonce: string,
 *   arweaveTxId?: string
 * }} NovelMetaV2
 * 旧版 v:1 无 recordKey / ownerAddress 等字段，合并时按「低信任」处理。
 */

export const APP_NAME = 'PermawebNovel-Fork';
export const APP_VERSION = '3.4.0';

const ARWEAVE_GATEWAY = (process.env.ARWEAVE_GATEWAY || 'https://arweave.net').replace(/\/+$/, '');
const GRAPHQL_URL = `${ARWEAVE_GATEWAY}/graphql`;
const PERMISSIONS = ['ACCESS_ADDRESS', 'SIGN_TRANSACTION', 'DISPATCH'];

const META_PREFIX = 'NOVEL_META_JSON:';
const META_SEP = '\n---\n';

const rootEl = document.getElementById('novel-root');
const statusEl = document.getElementById('global-status');
const connectBtn = document.getElementById('connect-wallet-btn');

const state = {
  walletAddress: '',
  connecting: false,
  publishing: false,
  libraryCache: null
};

let arweaveClientPromise = null;

/** 小说列表「刷新」代数：防止并行 paint 乱序覆盖 */
let libraryListLoadGeneration = 0;

/** 章节目录页刷新代数 */
let tocLoadGeneration = 0;

marked.use({ gfm: true, breaks: true });

function shortAddress(address) {
  if (!address) return '未知';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeNovelId(id) {
  return String(id ?? '').trim();
}

function novelIdsEqual(a, b) {
  return normalizeNovelId(a) === normalizeNovelId(b);
}

/** @param {any} h hydrate 后的章节节点 */
function chapterIndexFromHydrated(h) {
  const m = h.meta?.chapterIndex;
  if (m != null && Number.isFinite(Number(m))) return Number(m);
  const t = h.tags?.get?.('Chapter-Index');
  const n = Number.parseInt(String(t ?? ''), 10);
  return Number.isFinite(n) ? n : NaN;
}

function chapterTitleFromHydrated(h) {
  return String(h.meta?.chapterTitle || h.tags?.get?.('Title') || '').trim();
}

/** 交易发送者：GraphQL owner 或 Publisher 标签 */
function txOwnerAddress(h) {
  return String(h.owner || h.tags?.get?.('Publisher') || '').trim();
}

/**
 * @param {any} h
 * @param {string} novelId
 */
function hydratedChapterToRow(h, novelId) {
  const nid = h.meta?.novelId || h.tags.get('Novel-Id');
  if (!novelIdsEqual(nid, novelId)) return null;
  const chapterIndex = chapterIndexFromHydrated(h);
  if (!Number.isFinite(chapterIndex) || chapterIndex < 1) return null;
  return {
    chapterIndex,
    chapterTitle: chapterTitleFromHydrated(h),
    meta: h.meta,
    body: h.body,
    txId: h.id,
    chainOnly: true
  };
}

function setStatus(message, type = 'neutral') {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.remove('ok', 'error');
  if (type === 'ok') statusEl.classList.add('ok');
  if (type === 'error') statusEl.classList.add('error');
}

function updateWalletUi() {
  if (!connectBtn) return;
  if (state.connecting) {
    connectBtn.classList.remove('connected');
    connectBtn.textContent = '连接中…';
    return;
  }
  if (state.walletAddress) {
    connectBtn.classList.add('connected');
    connectBtn.textContent = shortAddress(state.walletAddress);
  } else {
    connectBtn.classList.remove('connected');
    connectBtn.textContent = '连接钱包';
  }
}

/**
 * @returns {{ name: string, novelId?: string, txId?: string, mirrorKey?: string, uploadTab?: string }}
 */
function parseHashRoute() {
  const raw = (location.hash || '#/').replace(/^#/, '') || '/';
  const path = raw.split('?')[0];

  if (path === '/books' || path === '/library') {
    return { name: 'library' };
  }

  if (path === '/feed' || path === '/recent-chapters' || path === '/updates') {
    return { name: 'chapterFeed' };
  }

  if (path === '/about' || path === '/features' || path === '/help') {
    return { name: 'about' };
  }

  const novelAboutMatch = path.match(/^\/novel\/(.+)\/about$/);
  if (novelAboutMatch) {
    return { name: 'novelAbout', novelId: decodeURIComponent(novelAboutMatch[1]) };
  }

  if (path.startsWith('/novel/')) {
    return { name: 'toc', novelId: decodeURIComponent(path.slice(7)) };
  }

  if (path.startsWith('/read/')) {
    const rest = path.slice(6);
    if (rest === 'local' || rest.startsWith('local/')) {
      const key = rest.startsWith('local/') ? decodeURIComponent(rest.slice(6)) : '';
      return { name: 'readLocal', mirrorKey: key };
    }
    return { name: 'read', txId: decodeURIComponent(rest) };
  }

  if (path.startsWith('/chapter/')) {
    return { name: 'read', txId: decodeURIComponent(path.slice(9)) };
  }

  if (path === '/upload' || path === '/upload/') {
    return { name: 'upload', uploadTab: 'new' };
  }
  if (path === '/upload/new') {
    return { name: 'upload', uploadTab: 'new' };
  }
  if (path === '/upload/chapter') {
    return { name: 'upload', uploadTab: 'chapter' };
  }

  if (path === '/publish/intro') {
    return { name: 'upload', uploadTab: 'new' };
  }
  if (path === '/publish/chapter') {
    return { name: 'upload', uploadTab: 'chapter' };
  }

  return { name: 'library' };
}

function navigate() {
  window.scrollTo(0, 0);
  const route = parseHashRoute();
  if (route.name === 'library') return renderLibrary();
  if (route.name === 'about') return renderAboutPage();
  if (route.name === 'chapterFeed') return renderChapterFeed();
  if (route.name === 'novelAbout' && route.novelId) return renderNovelAbout(route.novelId);
  if (route.name === 'toc' && route.novelId) return renderToc(route.novelId);
  if (route.name === 'read' && route.txId) return renderReader(route.txId);
  if (route.name === 'readLocal') return renderReaderLocal(route.mirrorKey || '');
  if (route.name === 'upload') return renderUploadPage(route.uploadTab || 'new');
  return renderLibrary();
}

/** @param {string} raw */
export function parseStoredPayload(raw) {
  const text = String(raw || '');
  const idx = text.indexOf(META_SEP);
  if (idx === -1) return { meta: null, body: text.trim() };
  const head = text.slice(0, idx).trim();
  const body = text.slice(idx + META_SEP.length).trim();
  if (head.startsWith(META_PREFIX)) {
    try {
      const meta = JSON.parse(head.slice(META_PREFIX.length));
      return { meta, body };
    } catch {
      return { meta: null, body: text.trim() };
    }
  }
  return { meta: null, body: text.trim() };
}

/** @param {NovelMeta} meta @param {string} body */
function serializeStoredPayload(meta, body) {
  return `${META_PREFIX}${JSON.stringify(meta)}${META_SEP}${body}`;
}

async function verifyArweaveTx(txId) {
  const response = await fetch(`${ARWEAVE_GATEWAY}/${txId}`, { method: 'HEAD', cache: 'no-store' });
  return { ok: response.ok, status: response.status };
}

// ——— GraphQL / Arweave ———

function toTagMap(tags) {
  const map = new Map();
  for (const tag of tags || []) {
    map.set(tag.name, tag.value);
  }
  return map;
}

async function queryGraphQL(query, variables) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw new Error(`GraphQL 请求失败：${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || 'GraphQL 错误');
  return payload.data;
}

async function fetchTransactionData(txId) {
  const response = await fetch(`${ARWEAVE_GATEWAY}/${txId}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`无法拉取交易正文 ${txId}`);
  return response.text();
}

/** @param {string} text */
async function sha256Utf8Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function buildRecordKeyIntro(novelId) {
  return `intro:${novelId}`;
}

function buildRecordKeyChapter(novelId, chapterIndex) {
  return `chapter:${novelId}:${chapterIndex}`;
}

const feedQuery = `
  query NovelFeed($first: Int!, $after: String, $tags: [TagFilter!]) {
    transactions(first: $first, after: $after, sort: HEIGHT_DESC, tags: $tags) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          owner { address }
          block { timestamp height }
          tags { name value }
        }
      }
    }
  }
`;

/**
 * 查询链上列表时只按 App-Name + Record-Type（及章节时的 Novel-Id）过滤。
 * 不要加 App-Version：旧交易保留上传时的版本号，发新版后仍须出现在书库中。
 */
function baseNovelTags(recordType, novelIdForChapter = null) {
  const tags = [
    { name: 'App-Name', values: [APP_NAME] },
    { name: 'Record-Type', values: [recordType] }
  ];
  if (novelIdForChapter) {
    tags.push({ name: 'Novel-Id', values: [novelIdForChapter] });
  }
  return tags;
}

async function loadTransactionsByTags(tags, first = 80) {
  const data = await queryGraphQL(feedQuery, { first, after: null, tags });
  return data.transactions.edges.map((e) => e.node);
}

/**
 * 各小说最近一笔「章节」交易的区块时间（仅统计与该书**最新简介**发布者一致的章节）。
 */
async function fetchLatestChapterTimestampByNovel(first = 200) {
  const tags = baseNovelTags('novel-chapter');
  const data = await queryGraphQL(feedQuery, { first, after: null, tags });
  const nodes = data.transactions.edges.map((e) => e.node);
  const hydrated = await hydrateNovelNodes(nodes, 6);
  const novelIds = [
    ...new Set(
      hydrated
        .map((h) => normalizeNovelId(h.meta?.novelId || h.tags.get('Novel-Id') || ''))
        .filter(Boolean)
    )
  ];
  /** @type {Map<string, any>} */
  const introByNovel = new Map();
  await Promise.all(
    novelIds.map(async (id) => {
      const intro = await fetchLatestIntroForNovel(id);
      if (intro) introByNovel.set(id, intro);
    })
  );
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const h of hydrated) {
    const nid = normalizeNovelId(h.meta?.novelId || h.tags.get('Novel-Id') || '');
    if (!nid) continue;
    const intro = introByNovel.get(nid);
    if (!intro) continue;
    const introOwner = txOwnerAddress(intro);
    if (!introOwner || txOwnerAddress(h) !== introOwner) continue;
    const ts = h.timestamp || 0;
    const prev = map.get(nid) || 0;
    if (ts > prev) map.set(nid, ts);
  }
  return map;
}

/**
 * @param {any[]} nodes
 * @param {number} [concurrency] 1=串行；瀑布流等场景可用 6～10 并行拉正文（注意网关限流）
 */
async function hydrateNovelNodes(nodes, concurrency = 1) {
  const runOne = async (node) => {
    try {
      const raw = await fetchTransactionData(node.id);
      const { meta, body } = parseStoredPayload(raw);
      const tagMap = toTagMap(node.tags);
      const recordType = tagMap.get('Record-Type') || meta?.kind || '';
      return {
        id: node.id,
        owner: node.owner?.address,
        timestamp: node.block?.timestamp || 0,
        recordType,
        meta,
        body,
        tags: tagMap
      };
    } catch {
      return null;
    }
  };
  if (!nodes.length) return [];
  if (concurrency <= 1) {
    const out = [];
    for (const node of nodes) {
      const r = await runOne(node);
      if (r) out.push(r);
    }
    return out;
  }
  const out = [];
  for (let i = 0; i < nodes.length; i += concurrency) {
    const batch = nodes.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((n) => runOne(n)));
    for (const r of results) if (r) out.push(r);
  }
  return out;
}

/** @param {string} novelId */
async function fetchLatestIntroForNovel(novelId) {
  const nid = normalizeNovelId(novelId);
  const nodes = await loadTransactionsByTags(baseNovelTags('novel-intro'), 180);
  const hydrated = await hydrateNovelNodes(nodes, 6);
  const matches = hydrated.filter((h) =>
    novelIdsEqual(h.meta?.novelId || h.tags.get('Novel-Id'), nid)
  );
  matches.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return matches[0] || null;
}

/**
 * 与最新简介发布者一致、按章号去重（同章仅保留区块时间最新的一笔）后的有序章节行。
 * @param {string} novelId
 */
async function listCreatorChaptersOrdered(novelId) {
  const nid = normalizeNovelId(novelId);
  const intro = await fetchLatestIntroForNovel(nid);
  if (!intro) return { intro: null, chapters: [], introOwner: '' };
  const introOwner = txOwnerAddress(intro);
  if (!introOwner) return { intro, chapters: [], introOwner: '' };

  let nodes = [];
  try {
    nodes = await loadTransactionsByTags(baseNovelTags('novel-chapter', nid), 280);
  } catch {
    nodes = [];
  }
  const hydrated = await hydrateNovelNodes(nodes, 8);
  /** @type {Map<number, { row: any, ts: number }>} */
  const byIndex = new Map();
  for (const h of hydrated) {
    const row = hydratedChapterToRow(h, nid);
    if (!row) continue;
    if (txOwnerAddress(h) !== introOwner) continue;
    const ts = h.timestamp || 0;
    const prev = byIndex.get(row.chapterIndex);
    if (!prev || ts > prev.ts) byIndex.set(row.chapterIndex, { row, ts });
  }
  const chapters = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v.row);
  return { intro, chapters, introOwner };
}

async function getWalletApi() {
  if (window.arweaveWallet) return window.arweaveWallet;
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('arweaveWalletLoaded', onLoaded);
      reject(new Error('未检测到 ArConnect/Wander，请安装并解锁扩展。'));
    }, 8000);
    function onLoaded() {
      window.clearTimeout(timeout);
      resolve();
    }
    window.addEventListener('arweaveWalletLoaded', onLoaded, { once: true });
  });
  if (!window.arweaveWallet) throw new Error('钱包未注入页面。');
  return window.arweaveWallet;
}

async function ensureWalletPermissions(wallet) {
  let current = [];
  if (typeof wallet.getPermissions === 'function') {
    try {
      current = await wallet.getPermissions();
    } catch {
      current = [];
    }
  }
  const missing = PERMISSIONS.filter((p) => !current.includes(p));
  if (missing.length) await wallet.connect(PERMISSIONS, { name: 'Permaweb 小说' });
}

function arweaveGatewayConfig() {
  const gatewayUrl = new URL(ARWEAVE_GATEWAY);
  return {
    host: gatewayUrl.hostname,
    port: gatewayUrl.port ? Number.parseInt(gatewayUrl.port, 10) : gatewayUrl.protocol === 'https:' ? 443 : 80,
    protocol: gatewayUrl.protocol.replace(':', '')
  };
}

/**
 * esbuild 打包后 `import('arweave')` 可能是 default 套 default，或仅暴露可 `new` 的类；浏览器版还会在 globalThis 上挂 Arweave。
 * @param {any} mod
 */
function instantiateArweaveFromModule(mod) {
  const cfg = arweaveGatewayConfig();
  const candidates = [
    mod,
    mod?.default,
    mod?.default?.default,
    mod?.Arweave,
    mod?.default?.Arweave,
    typeof globalThis !== 'undefined' ? globalThis.Arweave : null
  ].filter(Boolean);

  for (const item of candidates) {
    if (item && typeof item.init === 'function') {
      return item.init(cfg);
    }
  }

  for (const item of candidates) {
    if (typeof item === 'function' && typeof item.prototype?.createTransaction === 'function') {
      return new item(cfg);
    }
  }

  throw new Error(
    '无法初始化 Arweave SDK（与当前打包格式不兼容）。请强制刷新页面（Ctrl+F5）或换用 Chrome/Edge 最新版。'
  );
}

async function getArweaveClient() {
  try {
    if (!arweaveClientPromise) {
      arweaveClientPromise = import('arweave').then((mod) => instantiateArweaveFromModule(mod));
    }
    return await arweaveClientPromise;
  } catch (err) {
    arweaveClientPromise = null;
    throw err;
  }
}

/**
 * @param {string} dataStr
 * @param {Record<string, string>} extraTags
 */
async function signAndDispatchTransaction(dataStr, extraTags) {
  if (!state.walletAddress) throw new Error('请先连接钱包。');
  const wallet = await getWalletApi();
  await ensureWalletPermissions(wallet);
  const arweave = await getArweaveClient();
  const transaction = await arweave.createTransaction({ data: dataStr });
  transaction.addTag('Content-Type', 'text/plain; charset=utf-8');
  transaction.addTag('App-Name', APP_NAME);
  transaction.addTag('App-Version', APP_VERSION);
  for (const [k, v] of Object.entries(extraTags)) {
    if (v) transaction.addTag(k, v);
  }
  transaction.addTag('Unix-Time', String(Math.floor(Date.now() / 1000)));

  let txId = '';
  if (typeof wallet.dispatch === 'function') {
    const dispatchResult = await wallet.dispatch(transaction);
    txId = dispatchResult?.id || transaction.id;
  } else if (typeof wallet.sign === 'function') {
    await wallet.sign(transaction);
    txId = transaction.id;
    if (!txId) throw new Error('签名后未返回交易 ID。');
    const postResponse = await arweave.transactions.post(transaction);
    if (postResponse.status >= 300 || postResponse.status < 200) {
      throw new Error(`网关拒绝交易：HTTP ${postResponse.status}`);
    }
  } else {
    throw new Error('钱包不支持 sign / dispatch。');
  }

  if (!txId) throw new Error('未获得交易 ID。');
  const verification = await verifyArweaveTx(txId);
  return { txId, verification };
}

function renderMarkdownBody(text) {
  const html = marked.parse(String(text || ''));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// ——— Merge: prefer Arweave when tx resolvable ———

/**
 * 仅从链上解析正文（无镜像回退）。
 * @param {NovelMeta | null} meta
 * @param {string | undefined} txId
 */
async function preferSource(meta, txId) {
  const id = txId || meta?.arweaveTxId;
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
    return { ok: false, txId: null, body: null, meta };
  }
  const v = await verifyArweaveTx(id);
  if (!v.ok) return { ok: false, txId: id, body: null, meta };
  try {
    const raw = await fetchTransactionData(id);
    const parsed = parseStoredPayload(raw);
    return { ok: true, txId: id, body: parsed.body, meta: parsed.meta || meta };
  } catch {
    return { ok: false, txId: id, body: null, meta };
  }
}

// ——— Views ———

function matchesIntroSearch(item, qLower) {
  if (!qLower) return true;
  const title = (item.meta?.bookTitle || '').toLowerCase();
  const author = (item.meta?.author || '').toLowerCase();
  const nid = (item.meta?.novelId || item.tags?.get?.('Novel-Id') || '').toLowerCase();
  return title.includes(qLower) || author.includes(qLower) || nid.includes(qLower);
}

/**
 * @param {Map<string, any>} byNovel
 * @param {any[]} chainIntros hydrated intro nodes
 * @param {string} qLower
 */
function mergeChainIntrosIntoMap(byNovel, chainIntros, qLower) {
  for (const item of chainIntros) {
    if (!matchesIntroSearch(item, qLower)) continue;
    const novelId = item.meta?.novelId || item.tags.get('Novel-Id');
    if (!novelId) continue;
    const prev = byNovel.get(novelId);
    if (prev?.chain) {
      const pt = prev.chain.timestamp || 0;
      const it = item.timestamp || 0;
      if (it < pt) continue;
    }
    byNovel.set(novelId, {
      novelId,
      bookTitle: item.meta?.bookTitle || prev?.bookTitle || '',
      chain: item
    });
  }
}

/** @param {Map<string, any>} byNovel @param {Map<string, number>} chapterLatestByNovel */
function buildSortedLibraryRows(byNovel, chapterLatestByNovel) {
  return [...byNovel.values()]
    .map((r) => ({
      ...r,
      activityTs: Math.max(r.chain?.timestamp || 0, chapterLatestByNovel.get(r.novelId) || 0)
    }))
    .sort((a, b) => {
      if (b.activityTs !== a.activityTs) return b.activityTs - a.activityTs;
      return String(a.novelId).localeCompare(String(b.novelId));
    });
}

/** @param {any} r row from buildSortedLibraryRows */
async function buildLibraryCardHtml(r) {
  const chainTxId = r.chain?.id || null;
  const meta = r.chain?.meta;
  const pref = await preferSource(meta, chainTxId);

  const title = escapeHtml(r.bookTitle || meta?.bookTitle || r.novelId);
  let badge = '';
  if (r.chain) {
    badge = pref.ok
      ? '<span class="novel-badge novel-badge-ok">链上</span>'
      : '<span class="novel-badge novel-badge-warn">链上确认中</span>';
  } else {
    badge = '<span class="novel-badge novel-badge-warn">无链上简介</span>';
  }

  const previewSource = pref.body || r.chain?.body || '';
  const preview = escapeHtml((previewSource || '').replace(/\s+/g, ' ').slice(0, 120));
  const actTs = r.activityTs || 0;
  const activityLine = actTs
    ? `<p class="novel-muted novel-activity">最近链上活动：${escapeHtml(
        new Date(actTs * 1000).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
      )}</p>`
    : '';
  const displayTxId = chainTxId || meta?.arweaveTxId;
  const txLine =
    displayTxId && pref.ok
      ? `<div class="novel-muted novel-tx"><a href="${ARWEAVE_GATEWAY}/${escapeHtml(displayTxId)}" target="_blank" rel="noopener">Arweave ${escapeHtml(displayTxId)}</a></div>`
      : displayTxId
        ? `<div class="novel-muted novel-tx">链上交易：${escapeHtml(displayTxId)}（${pref.ok ? '已可读' : '确认中'}）</div>`
        : r.chain
          ? ''
          : '<div class="novel-muted novel-tx">暂无链上交易 ID</div>';
  return `
          <article class="novel-book-card">
            <div class="novel-book-head">
              <h3><a href="#/novel/${encodeURIComponent(r.novelId)}/about">${title}</a></h3>
              ${badge}
            </div>
            <p class="novel-muted" style="font-size:0.78rem;margin:0.2rem 0 0">点击书名进入<strong>简介页</strong></p>
            ${activityLine}
            <p class="novel-preview">${preview || '（无简介预览）'}</p>
            ${txLine}
            <div class="novel-page-actions" style="margin-top:0.5rem">
              <a class="novel-link" href="#/novel/${encodeURIComponent(r.novelId)}">章节目录 →</a>
            </div>
          </article>
        `;
}

/** @param {string} novelId */
async function renderNovelAbout(novelId) {
  if (!rootEl) return;
  rootEl.innerHTML = `<section class="novel-card"><p class="novel-muted">正在加载简介…</p></section>`;
  setStatus('加载简介…', 'neutral');
  try {
    const intro = await fetchLatestIntroForNovel(novelId);
    if (!intro) {
      rootEl.innerHTML = `
        <section class="novel-card">
          <p class="novel-crumb"><a href="#/">小说列表</a> · <a href="#/feed">最近章节</a></p>
          <h2 class="novel-h2">小说简介</h2>
          <p class="novel-muted">链上暂无该小说的简介记录（ID：<code>${escapeHtml(novelId)}</code>）。</p>
          <div class="novel-page-actions">
            <a class="novel-btn novel-btn-secondary" href="#/novel/${encodeURIComponent(novelId)}">章节目录</a>
            <a class="novel-btn" href="#/upload">上传作品</a>
          </div>
        </section>`;
      setStatus('未找到链上简介。', 'neutral');
      return;
    }
    const bookTitle = intro.meta?.bookTitle || '未命名作品';
    const author = intro.meta?.author || '';
    const bodyHtml = renderMarkdownBody(intro.body || '');
    rootEl.innerHTML = `
      <article class="novel-card novel-reader">
        <p class="novel-crumb"><a href="#/">小说列表</a> · <a href="#/feed">最近章节</a> · <a href="#/novel/${encodeURIComponent(novelId)}">章节目录</a></p>
        <h2 class="novel-h2">${escapeHtml(bookTitle)}</h2>
        ${author ? `<p class="novel-muted">作者：${escapeHtml(author)}</p>` : ''}
        <p class="novel-muted">小说 ID：<code>${escapeHtml(novelId)}</code></p>
        <p class="novel-muted"><a href="${ARWEAVE_GATEWAY}/${escapeHtml(intro.id)}" target="_blank" rel="noopener">链上简介交易 ${escapeHtml(intro.id)}</a></p>
        <div class="novel-page-actions">
          <a class="novel-btn novel-btn-secondary" href="#/novel/${encodeURIComponent(novelId)}">进入章节目录</a>
          <a class="novel-btn" href="#/upload/chapter">为本作上传章节</a>
        </div>
        <div class="novel-prose">${bodyHtml}</div>
      </article>`;
    setStatus('简介已加载。', 'ok');
  } catch (e) {
    rootEl.innerHTML = `<section class="novel-card"><p class="novel-muted">${escapeHtml(e.message || '加载失败')}</p><p><a href="#/">返回小说列表</a></p></section>`;
    setStatus(e.message || '加载失败', 'error');
  }
}

function renderAboutPage() {
  if (!rootEl) return;
  setStatus('', 'neutral');
  rootEl.innerHTML = `
    <section class="novel-card novel-about">
      <p class="novel-crumb"><a href="#/">小说列表</a> · <a href="#/about">功能说明</a></p>
      <h1 class="novel-h2" style="margin-top:0">功能说明 · Features</h1>
      <p class="novel-muted novel-about-jump"><a href="#about-zh">中文</a> · <a href="#about-en">English</a></p>

      <article id="about-zh" class="novel-about-block" lang="zh-CN">
        <h2 class="novel-about-h3">中文</h2>
        <p class="novel-muted">本应用是部署在 Arweave（Permaweb）上的连载阅读与投稿端，适合作为参赛作品展示「链上存证 + 可读体验」。</p>
        <ul class="novel-about-list">
          <li><strong>永久存储</strong>：作品简介与每一章均为独立链上交易，由钱包签名发布，数据归属与时间点可公开验证。</li>
          <li><strong>小说列表</strong>：仅从链上加载简介；按最近链上活动排序，支持书名 / 作者 / 小说 ID 搜索。</li>
          <li><strong>阅读动线</strong>：书名 → 简介页 → 章节目录 → 章节正文；亦可使用「最近章节」浏览新近更新。</li>
          <li><strong>上传作品</strong>：可「创建新小说」（先上链简介，获得小说 ID）或「向已有小说追加章节」。正文支持 Markdown。</li>
          <li><strong>章节与目录</strong>：目录与上下章仅展示<strong>与最新简介同一发布者</strong>的章节；同章号多笔上链时只显示<strong>区块时间最新</strong>的一笔。小说 ID 须与简介一致。</li>
        </ul>
      </article>

      <article id="about-en" class="novel-about-block" lang="en">
        <h2 class="novel-about-h3">English</h2>
        <p class="novel-muted">A Permaweb serial-fiction reader and publishing UI on Arweave—suitable for competition entries that highlight on-chain persistence and readable UX.</p>
        <ul class="novel-about-list">
          <li><strong>Permanent storage</strong>: Each intro and chapter is its own signed transaction; provenance and timing are publicly verifiable.</li>
          <li><strong>Library</strong>: Loads intros from Arweave only. Sorting uses recent on-chain activity; search by title, author, or novel ID.</li>
          <li><strong>Reading flow</strong>: Title → about page → table of contents → chapter body. <strong>Recent chapters</strong> lists latest updates.</li>
          <li><strong>Publishing</strong>: Create a new work (intro on-chain first, get a novel ID) or append chapters to an existing ID. Markdown is supported.</li>
          <li><strong>Chapters &amp; TOC</strong>: TOC and prev/next only include chapters from the <strong>same wallet as the latest intro</strong>. If multiple txs share one chapter index, the <strong>newest block time</strong> wins. Chapter uploads must use the same novel ID as the intro.</li>
        </ul>
      </article>

      <p class="novel-muted" style="margin-top:1.25rem"><a href="#/">返回小说列表</a> · <a href="#/upload">上传作品</a></p>
    </section>
  `;
}

async function renderLibrary() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <section class="novel-card">
      <h2 class="novel-h2">小说列表</h2>
      <p class="novel-nav-inline novel-muted" style="margin:-0.25rem 0 0.5rem">
        <a href="#/feed">最近章节</a> · <a href="#/about">功能说明（中英）</a>
      </p>
      <p class="novel-muted">
        数据仅从 <strong>Arweave 链上</strong>拉取。列表按最近链上活动排序；章节时间仅统计与该书<strong>最新简介发布者</strong>一致的章节。可用搜索框按书名、作者或小说 ID 筛选。
      </p>
      <div class="novel-row">
        <input type="search" id="lib-search" class="novel-input" placeholder="搜索书名、作者或小说 ID（留空则显示按更新时间排序的全部）" />
        <button type="button" id="lib-refresh" class="novel-btn">刷新列表</button>
      </div>
      <div id="lib-list" class="novel-list"></div>
    </section>
  `;

  const searchInput = rootEl.querySelector('#lib-search');
  const btnRefresh = rootEl.querySelector('#lib-refresh');
  const listEl = rootEl.querySelector('#lib-list');

  async function runMerge() {
    const gen = ++libraryListLoadGeneration;
    const shouldAbort = () => gen !== libraryListLoadGeneration;

    const q = searchInput.value.trim();
    const qLower = q.toLowerCase();

    const byNovel = new Map();
    let chainState = 'pending';
    let chapterState = 'pending';
    /** @type {Map<string, number>} */
    let chapterLatestByNovel = new Map();

    async function paint() {
      if (shouldAbort()) return;
      const waitingFirst = byNovel.size === 0 && chainState === 'pending';
      if (waitingFirst) {
        listEl.innerHTML =
          '<p class="novel-muted" id="lib-waiting">正在从 <strong>Arweave</strong> 加载简介与章节活动时间…</p>';
        const parts = [];
        if (chainState === 'pending') parts.push('链上简介');
        if (chapterState === 'pending') parts.push('章节时间同步中');
        setStatus((parts.length ? parts.join(' · ') : '加载中') + '…', 'neutral');
        return;
      }

      const rows = buildSortedLibraryRows(byNovel, chapterLatestByNovel);
      state.libraryCache = byNovel;
      const cards = await Promise.all(rows.map((r) => buildLibraryCardHtml(r)));
      if (shouldAbort()) return;

      listEl.innerHTML = rows.length
        ? cards.join('')
        : '<p class="novel-muted">暂无小说。请连接钱包发布简介，或调整搜索关键词。</p>';

      let msg = `共 ${rows.length} 部`;
      if (chainState === 'pending') msg += ' · 链上仍加载中…';
      else if (chainState === 'err') msg += ' · 链上失败';
      if (chapterState === 'pending') msg += ' · 章节时间同步中（稍后自动重排）…';

      const stKind =
        chainState === 'err' && rows.length === 0 ? 'error' : rows.length > 0 || chainState === 'ok' ? 'ok' : 'neutral';
      setStatus(msg, stKind);
    }

    void paint();

    (async () => {
      try {
        const nodes = await loadTransactionsByTags(baseNovelTags('novel-intro'), 200);
        if (shouldAbort()) return;
        const hydrated = await hydrateNovelNodes(nodes);
        if (shouldAbort()) return;
        mergeChainIntrosIntoMap(byNovel, hydrated, qLower);
        chainState = 'ok';
      } catch {
        chainState = 'err';
      }
      await paint();
    })();

    (async () => {
      try {
        chapterLatestByNovel = await fetchLatestChapterTimestampByNovel(220);
      } catch {
        chapterLatestByNovel = new Map();
      }
      if (shouldAbort()) return;
      chapterState = 'ok';
      await paint();
    })();
  }

  btnRefresh.addEventListener('click', () => runMerge().catch((e) => setStatus(e.message, 'error')));
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') runMerge().catch((e) => setStatus(e.message, 'error'));
  });
  await runMerge().catch((e) => setStatus(e.message, 'error'));
}

/** @param {string} body @param {number} max */
function textPreviewFromChapterBody(body, max = 160) {
  const t = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>\[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, max);
}

/** 全站最近 novel-chapter 交易，瀑布流展示 */
async function renderChapterFeed() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <section class="novel-card">
      <p class="novel-crumb"><a href="#/">小说列表</a> · <a href="#/feed">最近章节</a> · <a href="#/about">功能说明</a></p>
      <h2 class="novel-h2">最近更新章节</h2>
      <p class="novel-muted">
        展示最近在链上发布的章节，按时间倒序。仅包含与该书<strong>最新简介发布者</strong>钱包一致的章节；同一部作品同一章号只显示<strong>区块时间最新</strong>的一笔。点击卡片阅读或进入目录。
      </p>
      <div class="novel-row">
        <button type="button" id="feed-refresh" class="novel-btn">刷新</button>
      </div>
      <div id="feed-masonry" class="novel-feed-masonry" aria-busy="true"></div>
    </section>
  `;

  const wrap = rootEl.querySelector('#feed-masonry');
  const btn = rootEl.querySelector('#feed-refresh');

  async function loadFeed() {
    setStatus('正在加载最近章节…', 'neutral');
    wrap.innerHTML = '<p class="novel-muted">正在拉取链上章节…</p>';
    try {
      const nodes = await loadTransactionsByTags(baseNovelTags('novel-chapter'), 120);
      const hydrated = await hydrateNovelNodes(nodes, 8);
      const chapters = hydrated.filter(
        (h) =>
          h.recordType === 'novel-chapter' ||
          h.meta?.recordClass === 'novel-chapter' ||
          h.meta?.kind === 'chapter'
      );

      const novelIds = [
        ...new Set(
          chapters
            .map((h) => normalizeNovelId(h.meta?.novelId || h.tags.get('Novel-Id') || ''))
            .filter(Boolean)
        )
      ];
      /** @type {Map<string, any>} */
      const introByNovel = new Map();
      await Promise.all(
        novelIds.map(async (id) => {
          const intro = await fetchLatestIntroForNovel(id);
          if (intro) introByNovel.set(id, intro);
        })
      );

      const creatorChapters = chapters.filter((h) => {
        const nid = normalizeNovelId(h.meta?.novelId || h.tags.get('Novel-Id') || '');
        const intro = introByNovel.get(nid);
        if (!intro) return false;
        const io = txOwnerAddress(intro);
        return !!io && txOwnerAddress(h) === io;
      });

      /** @type {Map<string, any>} */
      const bestByKey = new Map();
      for (const h of creatorChapters) {
        const novelId = h.meta?.novelId || h.tags.get('Novel-Id');
        const chIdx = h.meta?.chapterIndex ?? Number.parseInt(h.tags.get('Chapter-Index') || '', 10);
        if (!novelId || !Number.isFinite(chIdx) || chIdx < 1) continue;
        const key = `${novelId}:${chIdx}`;
        const prev = bestByKey.get(key);
        const ts = h.timestamp || 0;
        if (!prev || ts > (prev.timestamp || 0)) bestByKey.set(key, h);
      }

      const rows = [...bestByKey.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      const cards = rows.map((h) => {
        const novelId = h.meta?.novelId || h.tags.get('Novel-Id') || '';
        const chIdx = h.meta?.chapterIndex ?? Number.parseInt(h.tags.get('Chapter-Index') || '', 10);
        const chapterTitle =
          h.meta?.chapterTitle || h.tags.get('Title') || `第 ${chIdx} 章`;
        const ts = h.timestamp || 0;
        const timeStr = ts
          ? new Date(ts * 1000).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
          : '时间未知';
        const preview = textPreviewFromChapterBody(h.body || '');
        const txId = h.id;
        const cacheRow =
          state.libraryCache instanceof Map ? state.libraryCache.get(novelId) : null;
        const bookTitleHint =
          (cacheRow && (cacheRow.bookTitle || cacheRow.chain?.meta?.bookTitle)) || '';
        return `
          <article class="novel-feed-card">
            <div class="novel-feed-card-head">
              <span class="novel-feed-time">${escapeHtml(timeStr)}</span>
              <span class="novel-badge novel-badge-ok">第 ${chIdx} 章</span>
            </div>
            ${
              bookTitleHint
                ? `<p class="novel-feed-book">《${escapeHtml(bookTitleHint)}》</p>`
                : ''
            }
            <h3 class="novel-feed-title"><a href="#/read/${encodeURIComponent(txId)}">${escapeHtml(chapterTitle)}</a></h3>
            <p class="novel-muted novel-feed-id">小说 ID：<code>${escapeHtml(novelId)}</code></p>
            <p class="novel-feed-preview">${escapeHtml(preview || '（无正文预览）')}</p>
            <div class="novel-feed-actions">
              <a class="novel-link" href="#/read/${encodeURIComponent(txId)}">阅读本章</a>
              <a class="novel-link" href="#/novel/${encodeURIComponent(novelId)}">本书全部章节</a>
              <a class="novel-link" href="${ARWEAVE_GATEWAY}/${encodeURIComponent(txId)}" target="_blank" rel="noopener">链上交易</a>
            </div>
          </article>
        `;
      });

      wrap.innerHTML = cards.length
        ? cards.join('')
        : '<p class="novel-muted">暂无章节记录。请先在 <a href="#/upload/chapter">上传章节</a> 发布，并等待索引。</p>';
      wrap.setAttribute('aria-busy', 'false');
      setStatus(`最近章节 ${rows.length} 条（已按小说+章号去重）。`, 'ok');
    } catch (e) {
      wrap.innerHTML = `<p class="novel-muted">${escapeHtml(e.message || '加载失败')}</p>`;
      wrap.setAttribute('aria-busy', 'false');
      setStatus(e.message || '加载失败', 'error');
    }
  }

  btn.addEventListener('click', () => loadFeed().catch((e) => setStatus(e.message, 'error')));
  await loadFeed().catch((e) => setStatus(e.message, 'error'));
}

async function renderToc(novelIdRaw) {
  if (!rootEl) return;
  const novelId = normalizeNovelId(novelIdRaw);
  rootEl.innerHTML = `
    <section class="novel-card">
      <p class="novel-crumb"><a href="#/">小说列表</a> · <a href="#/feed">最近章节</a> · <a href="#/about">功能说明</a> · <a href="#/novel/${encodeURIComponent(novelId)}/about">简介</a></p>
      <div id="toc-book-banner" class="novel-toc-banner">
        <p class="novel-muted">正在加载本书信息与章节…</p>
      </div>
      <h2 class="novel-h2">章节目录</h2>
      <p class="novel-muted">小说 ID：<code>${escapeHtml(novelId)}</code> · 仅列出与<strong>最新简介发布者</strong>钱包一致的章节；同章号多笔上链时只显示<strong>区块时间最新</strong>的一笔。数据来自 Arweave。</p>
      <div class="novel-row">
        <button type="button" id="toc-refresh" class="novel-btn">刷新章节列表</button>
      </div>
      <ol id="toc-chapters" class="novel-toc"></ol>
    </section>
  `;

  const listEl = rootEl.querySelector('#toc-chapters');
  const bannerEl = rootEl.querySelector('#toc-book-banner');
  const refresh = rootEl.querySelector('#toc-refresh');

  async function paintBanner(intro) {
    if (!intro) {
      bannerEl.innerHTML = `
        <p class="novel-muted">链上暂无本书简介。无法绑定作品创建者，目录将不列出章节。</p>
        <p class="novel-muted">小说 ID：<code>${escapeHtml(novelId)}</code> · <a href="#/upload">去上传简介</a> 或确认 ID 与创建作品时一致。</p>`;
      return;
    }
    const bookTitle = intro.meta?.bookTitle || '未命名作品';
    const author = intro.meta?.author || '';
    const preview = textPreviewFromChapterBody(intro.body || '', 240);
    bannerEl.innerHTML = `
      <h2 class="novel-toc-book-title">${escapeHtml(bookTitle)}</h2>
      ${author ? `<p class="novel-muted">作者：${escapeHtml(author)}</p>` : ''}
      <p class="novel-toc-intro-preview">${escapeHtml(preview || '（无简介预览）')}</p>
      <p class="novel-toc-banner-actions"><a class="novel-link" href="#/novel/${encodeURIComponent(novelId)}/about">查看完整简介</a></p>
    `;
  }

  /**
   * @param {any[]} chapters listCreatorChaptersOrdered 返回的行（已按创建者过滤、章号去重）
   */
  async function renderCreatorChapterList(chapters) {
    const sorted = [...chapters].sort((a, b) => a.chapterIndex - b.chapterIndex);
    const itemsHtml = await Promise.all(
      sorted.map(async (c) => {
        const pref = await preferSource(c.meta, c.txId);
        const readTx = c.txId;
        const label = escapeHtml(`第 ${c.chapterIndex} 章 ${c.chapterTitle || ''}`.trim());
        const mode = pref.ok
          ? '<span class="novel-badge novel-badge-ok">链上</span>'
          : '<span class="novel-badge novel-badge-warn">链上确认中</span>';
        if (!readTx || !/^[A-Za-z0-9_-]{43}$/.test(readTx)) {
          return `<li class="novel-toc-li">${mode} ${label} <span class="novel-muted">（无效交易 ID）</span></li>`;
        }
        return `<li class="novel-toc-li">${mode} <a href="#/read/${encodeURIComponent(readTx)}">${label}</a></li>`;
      })
    );

    listEl.innerHTML =
      itemsHtml.join('') || '<li class="novel-muted">暂无章节。去「上传章节」发布，或等待索引。</li>';

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      const myTx = c.txId;
      if (!myTx || !/^[A-Za-z0-9_-]{43}$/.test(myTx)) continue;
      const prevTx =
        i > 0 && sorted[i - 1].txId && /^[A-Za-z0-9_-]{43}$/.test(sorted[i - 1].txId)
          ? sorted[i - 1].txId
          : '';
      const nextTx =
        i < sorted.length - 1 &&
        sorted[i + 1].txId &&
        /^[A-Za-z0-9_-]{43}$/.test(sorted[i + 1].txId)
          ? sorted[i + 1].txId
          : '';
      sessionStorage.setItem(`novelNav:${myTx}`, JSON.stringify({ novelId, prevTx, nextTx }));
    }

    return sorted.length;
  }

  async function loadToc() {
    const gen = ++tocLoadGeneration;
    const valid = () => gen === tocLoadGeneration;

    listEl.innerHTML = '<li class="novel-muted">正在从链上加载…</li>';
    setStatus('加载章节目录…', 'neutral');

    try {
      const { intro, chapters, introOwner } = await listCreatorChaptersOrdered(novelId);
      if (!valid()) return;
      await paintBanner(intro);
      if (!intro || !introOwner) {
        listEl.innerHTML =
          '<li class="novel-muted">暂无可用目录：需要链上存在本书简介且能识别发布者。请先上传简介后刷新。</li>';
        setStatus('未找到简介或发布者，目录为空。', 'neutral');
        return;
      }
      const n = await renderCreatorChapterList(chapters);
      if (!valid()) return;
      setStatus(
        `本书共 ${n} 个章节（仅展示与简介发布者一致的章节，同章号取最新区块时间）。`,
        n ? 'ok' : 'neutral'
      );
    } catch (e) {
      if (!valid()) return;
      listEl.innerHTML = `<li class="novel-muted">${escapeHtml(e.message || '加载失败')}</li>`;
      setStatus(e.message || '加载失败', 'error');
    }
  }

  refresh.addEventListener('click', () => loadToc().catch((e) => setStatus(e.message, 'error')));
  await loadToc().catch((e) => setStatus(e.message, 'error'));
}

async function renderReader(txId) {
  if (!rootEl) return;
  setStatus('加载正文…', 'neutral');

  let bodyHtml = '';
  let title = '章节';
  /** @type {any} */
  let meta = null;
  try {
    const raw = await fetchTransactionData(txId);
    const parsed = parseStoredPayload(raw);
    meta = parsed.meta;
    const body = parsed.body;
    title = meta?.chapterTitle ? `第 ${meta.chapterIndex ?? ''} 章 ${meta.chapterTitle}` : txId;
    bodyHtml = renderMarkdownBody(body);
  } catch (e) {
    setStatus(e.message || '无法从 Arweave 读取该交易正文。', 'error');
    rootEl.innerHTML = `<section class="novel-card"><p class="novel-muted">${escapeHtml(e.message || '读取失败')}</p><p><a href="#/">返回小说列表</a></p></section>`;
    return;
  }

  let prevTx = '';
  let nextTx = '';
  const nid = meta?.novelId ? normalizeNovelId(meta.novelId) : '';
  if (nid) {
    try {
      const { chapters } = await listCreatorChaptersOrdered(nid);
      const ix = chapters.findIndex((c) => c.txId === txId);
      if (ix >= 0) {
        prevTx = ix > 0 ? chapters[ix - 1].txId : '';
        nextTx = ix < chapters.length - 1 ? chapters[ix + 1].txId : '';
      }
    } catch {
      /* ignore */
    }
  }
  if (!prevTx && !nextTx) {
    try {
      const navRaw = sessionStorage.getItem(`novelNav:${txId}`);
      const n = navRaw ? JSON.parse(navRaw) : {};
      prevTx = n.prevTx || '';
      nextTx = n.nextTx || '';
    } catch {
      /* ignore */
    }
  }

  const parts = ['<a href="#/">小说列表</a>'];
  if (meta?.novelId) {
    parts.push(`<a href="#/novel/${encodeURIComponent(meta.novelId)}/about">简介</a>`);
    parts.push(`<a href="#/novel/${encodeURIComponent(meta.novelId)}">章节目录</a>`);
  }

  rootEl.innerHTML = `
    <article class="novel-card novel-reader">
      <p class="novel-crumb" id="reader-crumb">${parts.join(' · ')}</p>
      <h2 class="novel-h2">章节阅读 · ${escapeHtml(title)}</h2>
      <p class="novel-muted"><a href="${ARWEAVE_GATEWAY}/${escapeHtml(txId)}" target="_blank" rel="noopener">链上章节交易 ${escapeHtml(txId)}</a> · 也可使用 <a href="#/chapter/${encodeURIComponent(txId)}">#/chapter/…</a> 访问本页</p>
      <div class="novel-chapter-nav">
        ${prevTx ? `<a class="novel-btn novel-btn-secondary" href="#/read/${encodeURIComponent(prevTx)}">← 上一章</a>` : '<span class="novel-muted">上一章</span>'}
        ${nextTx ? `<a class="novel-btn novel-btn-secondary" href="#/read/${encodeURIComponent(nextTx)}">下一章 →</a>` : '<span class="novel-muted">下一章</span>'}
      </div>
      <div class="novel-prose">${bodyHtml}</div>
    </article>
  `;
  setStatus('已从 Arweave 加载正文。', 'ok');
}

/** @param {HTMLElement} rootEl */
function bindUploadProgress(rootEl) {
  const wrap = rootEl.querySelector('#upload-progress-wrap');
  const bar = rootEl.querySelector('#upload-progress-bar');
  const text = rootEl.querySelector('#upload-progress-text');
  let hideTimer = 0;
  function hide() {
    if (!wrap) return;
    wrap.classList.add('hidden');
    if (bar) bar.style.width = '0%';
    if (text) text.textContent = '';
  }
  return {
    show() {
      if (!wrap) return;
      window.clearTimeout(hideTimer);
      wrap.classList.remove('hidden');
      if (bar) bar.style.width = '0%';
      if (text) text.textContent = '';
    },
    /** @param {number} pct @param {string} msg */
    set(pct, msg) {
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      if (text && msg) text.textContent = msg;
    },
    hide,
    hideSoon(ms = 800) {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, ms);
    }
  };
}

function renderReaderLocal(_mirrorKey) {
  if (!rootEl) return;
  setStatus('', 'neutral');
  rootEl.innerHTML = `
    <section class="novel-card">
      <p class="novel-crumb"><a href="#/">小说列表</a></p>
      <h2 class="novel-h2">仅链上阅读</h2>
      <p class="novel-muted">本站已取消镜像 / 本地缓存阅读。请使用章节目录或「最近章节」中的链接，通过 <code>#/read/&lt;交易ID&gt;</code> 直接阅读链上正文。</p>
      <p><a href="#/">返回小说列表</a> · <a href="#/feed">最近章节</a></p>
    </section>
  `;
}

/** @param {'new'|'chapter'} initialTab */
function renderUploadPage(initialTab) {
  if (!rootEl) return;
  const novelIdNew = crypto.randomUUID();
  const tab = initialTab === 'chapter' ? 'chapter' : 'new';

  rootEl.innerHTML = `
    <section class="novel-card">
      <h2 class="novel-h2">上传作品</h2>
      <p class="novel-muted">
        在此<strong>创建新小说</strong>（先上链简介）或<strong>向已有小说追加章节</strong>。内容<strong>仅写入 Arweave</strong>。完整说明见 <a href="#/about">功能说明（中英）</a>。
      </p>
      <div id="upload-progress-wrap" class="novel-progress-wrap hidden" aria-live="polite">
        <div class="novel-progress-track">
          <div id="upload-progress-bar" class="novel-progress-bar"></div>
        </div>
        <p id="upload-progress-text" class="novel-progress-text"></p>
      </div>
      <div class="novel-upload-tabs" role="tablist">
        <button type="button" class="novel-upload-tab" data-utab="new" role="tab">创建新小说</button>
        <button type="button" class="novel-upload-tab" data-utab="chapter" role="tab">上传章节到已有小说</button>
      </div>
      <div id="upload-pane-new" class="upload-pane">
        <label class="novel-label">小说 ID（自动生成，请妥善保存）</label>
        <p class="novel-muted"><code id="upload-new-novel-id">${escapeHtml(novelIdNew)}</code></p>
        <label class="novel-label">书名</label>
        <input class="novel-input" id="un-title" type="text" placeholder="书名" />
        <label class="novel-label">作者（可选）</label>
        <input class="novel-input" id="un-author" type="text" placeholder="笔名" />
        <label class="novel-label">简介正文（Markdown）</label>
        <textarea class="novel-textarea" id="un-body" rows="8" placeholder="作品简介…"></textarea>
        <button type="button" id="un-submit-intro" class="novel-btn">提交简介上链</button>
      </div>
      <div id="upload-pane-chapter" class="upload-pane hidden">
        <label class="novel-label">小说 ID（与简介页一致）</label>
        <input class="novel-input" id="uc-novel" type="text" placeholder="粘贴 novelId（UUID）" />
        <label class="novel-label">章节序号（从 1 开始）</label>
        <input class="novel-input" id="uc-index" type="number" min="1" step="1" value="1" />
        <label class="novel-label">章节标题</label>
        <input class="novel-input" id="uc-ctitle" type="text" placeholder="例如：初入仙门" />
        <label class="novel-label">正文（Markdown）</label>
        <textarea class="novel-textarea" id="uc-body" rows="14" placeholder="本章正文…"></textarea>
        <button type="button" id="uc-submit" class="novel-btn">提交章节上链</button>
      </div>
      <p class="novel-muted">页面导航：<a href="#/">小说列表</a> · <a href="#/feed">最近章节</a> · <a href="#/about">功能说明</a> · 简介 <code>#/novel/&lt;ID&gt;/about</code> · 目录 <code>#/novel/&lt;ID&gt;</code> · 阅读 <code>#/read/&lt;txId&gt;</code></p>
    </section>
  `;

  const tabNew = rootEl.querySelector('[data-utab="new"]');
  const tabCh = rootEl.querySelector('[data-utab="chapter"]');
  const paneNew = rootEl.querySelector('#upload-pane-new');
  const paneCh = rootEl.querySelector('#upload-pane-chapter');

  function setTab(t) {
    const isNew = t === 'new';
    tabNew.classList.toggle('active', isNew);
    tabCh.classList.toggle('active', !isNew);
    paneNew.classList.toggle('hidden', !isNew);
    paneCh.classList.toggle('hidden', isNew);
  }
  setTab(tab);

  tabNew.addEventListener('click', () => {
    setTab('new');
    if (location.hash.startsWith('#/upload')) {
      history.replaceState(null, '', '#/upload/new');
    }
  });
  tabCh.addEventListener('click', () => {
    setTab('chapter');
    if (location.hash.startsWith('#/upload')) {
      history.replaceState(null, '', '#/upload/chapter');
    }
  });

  rootEl.querySelector('#un-submit-intro').addEventListener('click', async () => {
    if (state.publishing) return;
    if (!state.walletAddress) {
      setStatus('请先连接钱包。', 'error');
      return;
    }
    const bookTitle = rootEl.querySelector('#un-title').value.trim();
    const author = rootEl.querySelector('#un-author').value.trim();
    const body = rootEl.querySelector('#un-body').value.trim();
    if (!bookTitle || !body) {
      setStatus('请填写书名与简介正文。', 'error');
      return;
    }
    state.publishing = true;
    const btnIntro = rootEl.querySelector('#un-submit-intro');
    const btnCh = rootEl.querySelector('#uc-submit');
    btnIntro.disabled = true;
    btnCh.disabled = true;
    const prog = bindUploadProgress(rootEl);
    setStatus('上链进行中…', 'neutral');
    try {
      prog.show();
      prog.set(6, '准备元数据…');
      const mirrorNonce = crypto.randomUUID();
      prog.set(14, '计算正文 SHA-256…');
      const contentSha256 = await sha256Utf8Hex(body);
      const recordKey = buildRecordKeyIntro(novelIdNew);
      /** @type {NovelMetaV2} */
      const meta = {
        v: 2,
        kind: 'intro',
        recordClass: 'novel-intro',
        recordKey,
        novelId: novelIdNew,
        bookTitle,
        author,
        chapterIndex: null,
        ownerAddress: state.walletAddress,
        contentSha256,
        mirrorNonce,
        arweaveTxId: ''
      };
      const payload = serializeStoredPayload(meta, body);
      prog.set(32, '构建链上交易…');
      prog.set(44, '请在钱包中确认签名 / 支付矿工费…');
      const { txId, verification } = await signAndDispatchTransaction(payload, {
        'Record-Type': 'novel-intro',
        'Novel-Id': novelIdNew,
        Title: bookTitle.slice(0, 200),
        'Content-Sha256': contentSha256,
        Publisher: state.walletAddress,
        'Record-Key': recordKey,
        'Mirror-Nonce': mirrorNonce
      });
      prog.set(72, `链上已提交 ${txId.slice(0, 10)}…，正在校验网关…`);
      prog.set(100, '链上已完成');
      setStatus(
        `已上链：${txId}（HTTP ${verification.status}）。请保存小说 ID：${novelIdNew}。可通过 GraphQL 按标签检索。`,
        'ok'
      );
      prog.hideSoon(1000);
    } catch (e) {
      setStatus(e.message || '发布失败', 'error');
      prog.hideSoon(600);
    } finally {
      state.publishing = false;
      btnIntro.disabled = false;
      btnCh.disabled = false;
    }
  });

  rootEl.querySelector('#uc-submit').addEventListener('click', async () => {
    if (state.publishing) return;
    if (!state.walletAddress) {
      setStatus('请先连接钱包。', 'error');
      return;
    }
    const novelId = rootEl.querySelector('#uc-novel').value.trim();
    const chapterIndex = Number.parseInt(rootEl.querySelector('#uc-index').value, 10);
    const chapterTitle = rootEl.querySelector('#uc-ctitle').value.trim();
    const body = rootEl.querySelector('#uc-body').value.trim();
    if (!novelId || !chapterTitle || !body || !Number.isFinite(chapterIndex) || chapterIndex < 1) {
      setStatus('请填写小说 ID、章节序号、章节标题与正文。', 'error');
      return;
    }
    state.publishing = true;
    const btnIntro2 = rootEl.querySelector('#un-submit-intro');
    const btnCh2 = rootEl.querySelector('#uc-submit');
    btnIntro2.disabled = true;
    btnCh2.disabled = true;
    const prog = bindUploadProgress(rootEl);
    setStatus('章节上传进行中…', 'neutral');
    try {
      prog.show();
      prog.set(6, '准备章节元数据…');
      const mirrorNonce = crypto.randomUUID();
      prog.set(14, '计算正文 SHA-256…');
      const contentSha256 = await sha256Utf8Hex(body);
      const recordKey = buildRecordKeyChapter(novelId, chapterIndex);
      /** @type {NovelMetaV2} */
      const meta = {
        v: 2,
        kind: 'chapter',
        recordClass: 'novel-chapter',
        recordKey,
        novelId,
        chapterIndex,
        chapterTitle,
        ownerAddress: state.walletAddress,
        contentSha256,
        mirrorNonce,
        arweaveTxId: ''
      };
      const payload = serializeStoredPayload(meta, body);
      prog.set(32, '构建链上交易…');
      prog.set(44, '请在钱包中确认签名 / 支付矿工费…');
      const { txId, verification } = await signAndDispatchTransaction(payload, {
        'Record-Type': 'novel-chapter',
        'Novel-Id': novelId,
        'Chapter-Index': String(chapterIndex),
        Title: chapterTitle.slice(0, 200),
        'Content-Sha256': contentSha256,
        Publisher: state.walletAddress,
        'Record-Key': recordKey,
        'Mirror-Nonce': mirrorNonce
      });
      prog.set(72, `链上已提交 ${txId.slice(0, 10)}…`);
      prog.set(100, '链上已完成');
      setStatus(
        `章节已上链：${txId}（HTTP ${verification.status}）。阅读 #/read/${txId} · 目录 #/novel/${novelId} · 最近章节 #/feed`,
        'ok'
      );
      prog.hideSoon(1000);
    } catch (e) {
      setStatus(e.message || '发布失败', 'error');
      prog.hideSoon(600);
    } finally {
      state.publishing = false;
      btnIntro2.disabled = false;
      btnCh2.disabled = false;
    }
  });

  setStatus('选择「创建新小说」或「上传章节」，通过钱包签名上链。', 'neutral');
}

async function connectWallet() {
  if (state.connecting || !connectBtn) return;
  state.connecting = true;
  connectBtn.disabled = true;
  updateWalletUi();
  try {
    const wallet = await getWalletApi();
    await ensureWalletPermissions(wallet);
    state.walletAddress = await wallet.getActiveAddress();
    setStatus('钱包已连接。', 'ok');
  } catch (e) {
    setStatus(e.message || '连接失败', 'error');
  } finally {
    state.connecting = false;
    connectBtn.disabled = false;
    updateWalletUi();
  }
}

function bindShell() {
  connectBtn?.addEventListener('click', connectWallet);
  window.addEventListener('hashchange', navigate);
  document.querySelectorAll('[data-route]').forEach((a) => {
    a.addEventListener('click', () => {
      window.setTimeout(navigate, 0);
    });
  });
}

export async function bootstrapNovelApp() {
  updateWalletUi();
  bindShell();
  navigate();
}
