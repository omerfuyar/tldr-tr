#!/usr/bin/env node
// tldr-tr: find, rank and machine-translate tldr pages into Turkish, ready for human review.
// Lints like upstream CI (scripts/test-tldr-lint.sh ignores TLDR003,004,015,104 for Turkish).
// Zero dependencies. Needs Node 18+ (built-in fetch).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TOOL_DIR = __dirname;
const CACHE_DIR = path.join(TOOL_DIR, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'translations.json');
const STATE_FILE = path.join(CACHE_DIR, 'state.json');
const GLOSSARY_FILE = path.join(TOOL_DIR, 'glossary.tsv');
const NOTES_FILE = path.join(TOOL_DIR, 'review-notes.md');
const PLACEHOLDERS_FILE = path.join(TOOL_DIR, 'placeholders.tsv');

const LANG = 'tr';
const PLATFORM_WEIGHT = { common: 1, linux: 0.9, osx: 0.7, windows: 0.7, android: 0.5 };
const DEFAULT_PLATFORM_WEIGHT = 0.4;

// Official wording from contributing-guides/translation-templates.
const TEMPLATE = {
  moreInfo: (url) => `Daha fazla bilgi için: <${url}>.`,
  seeAlso: (list) => `Ayrıca bakınız: ${list}.`,
  alias: (cmd) => `Bu komut ${cmd} için bir takma addır.`,
  subcommands: (cmds) => `${cmds} gibi bazı alt komutların kendi kullanım dokümantasyonu vardır.`,
  notePrefix: 'Not: ',
  interactive: '[Etkileşimli]',
};
const TEMPLATE_DESCRIPTIONS = {
  'Display help': 'Yardımı görüntüle',
  'Display version': 'Sürümü görüntüle',
  'View documentation for the original command': 'Asıl komutun dokümantasyonunu görüntüleyin',
};
const TEMPLATE_PLACEHOLDER_WORDS = {
  file: 'dosya',
  directory: 'dizin',
  file_or_directory: 'dosya_veya_dizin',
  package: 'paket',
  username: 'kullanıcı_adı',
  password: 'şifre',
  command: 'komut',
  port: 'port',
  value: 'değer',
};

// ---------- small helpers ----------

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) args[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
    else args[k] = true;
  }
  return args;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

function listPages(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const platform of fs.readdirSync(dir)) {
    const pdir = path.join(dir, platform);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const f of fs.readdirSync(pdir)) if (f.endsWith('.md')) out.push(`${platform}/${f.slice(0, -3)}`);
  }
  return out;
}

const trLower = (s) => s.toLocaleLowerCase('tr');
const codeSpans = (s) => (s.match(/`[^`]*`/g) || []).slice().sort();
const stripColon = (s) => s.replace(/:\s*$/, '');

// Splits text into [{code:boolean, text}] by backticks.
function splitCode(s) {
  return s.split(/(`[^`]*`)/).filter(Boolean).map((t) => ({ code: t.startsWith('`') && t.endsWith('`') && t.length > 1, text: t }));
}

// "[c]reate a [f]ile" -> "create a file" (only outside inline code).
function stripMnemonics(s) {
  return splitCode(s).map((p) => (p.code ? p.text : p.text.replace(/\[([A-Za-z0-9]+)\]/g, '$1'))).join('');
}

// ---------- page model ----------

function parsePage(text) {
  const page = { title: '', header: [], examples: [] };
  let cur = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('# ')) page.title = line.slice(2);
    else if (line.startsWith('> ')) page.header.push(line.slice(2));
    else if (line.startsWith('- ')) { cur = { desc: line.slice(2), cmd: null }; page.examples.push(cur); }
    else if (line.startsWith('`') && cur && cur.cmd === null) cur.cmd = line.slice(1, -1);
  }
  return page;
}

function renderPage(page) {
  let s = `# ${page.title}\n\n`;
  s += page.header.map((h) => `> ${h}\n`).join('');
  for (const ex of page.examples) s += `\n- ${ex.desc}\n\n\`${ex.cmd}\`\n`;
  return s;
}

// Placeholders other than option placeholders like {{[-a|--all]}}.
function placeholders(cmd) {
  return [...cmd.matchAll(/\{\{(.*?)\}\}/g)].map((m) => m[1]).filter((p) => !p.startsWith('['));
}
const normalizeCmd = (cmd) => (cmd || '').replace(/\{\{(?!\[)(.*?)\}\}/g, '{{}}').trim();

// Looser keys for pairing an old Turkish example with the current English one:
// exact, then ignoring spaces, then also treating {{[-a|--all]}} as -a.
function matchKeys(cmd) {
  const n = normalizeCmd(cmd);
  const noSpace = n.replace(/\s+/g, '');
  const noOpts = n.replace(/\{\{\[(.*?)\|.*?\]\}\}/g, '$1').replace(/\s+/g, '');
  return [n, noSpace, noOpts];
}

// Removes and returns the example in pool that best matches cmd, or null.
function takeMatch(pool, cmd) {
  const want = matchKeys(cmd);
  for (let level = 0; level < want.length; level++) {
    const i = pool.findIndex((t) => matchKeys(t.cmd)[level] === want[level]);
    if (i >= 0) return pool.splice(i, 1)[0];
  }
  return null;
}

// ---------- learning from existing Turkish pages ----------

// Parses a placeholder token: path/to/file1.txt -> {prefix:'path/to/', word:'file', num:'1', ext:'.txt'}
function parseToken(tok, tr) {
  const re = tr
    ? /^(yol\/)?([\p{L}_]+?)(\d*)((?:\.[\p{L}\d]+)*)$/u
    : /^(path\/to\/)?([A-Za-z_]+?)(\d*)((?:\.[A-Za-z0-9]+)*)$/;
  const m = tok.match(re);
  return m && { prefix: m[1] || '', word: m[2], num: m[3], ext: m[4] };
}

function tally(map, key, val) {
  map[key] = map[key] || {};
  map[key][val] = (map[key][val] || 0) + 1;
}
const best = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

// Builds placeholder-word and description dictionaries from aligned en/tr examples.
function learn(repo) {
  const words = {};
  const descs = {};
  for (const id of listPages(path.join(repo, `pages.${LANG}`))) {
    const enFile = path.join(repo, 'pages', `${id}.md`);
    if (!fs.existsSync(enFile)) continue;
    const en = parsePage(fs.readFileSync(enFile, 'utf8'));
    const tr = parsePage(fs.readFileSync(path.join(repo, `pages.${LANG}`, `${id}.md`), 'utf8'));
    const pool = [...tr.examples];
    for (const ex of en.examples) {
      const t = takeMatch(pool, ex.cmd);
      if (!t) continue;
      tally(descs, stripColon(stripMnemonics(ex.desc)), stripColon(t.desc));
      const ep = placeholders(ex.cmd);
      const tp = placeholders(t.cmd);
      ep.forEach((p, k) => {
        const et = p.split(' ');
        const tt = (tp[k] || '').split(' ');
        if (et.length !== tt.length) return;
        et.forEach((e, j) => {
          const a = parseToken(e, false);
          const b = parseToken(tt[j].replace(/_+(\d*)$/, '$1'), true);
          if (a && b && a.num === b.num && a.ext === b.ext && a.word !== b.word) tally(words, a.word, trLower(b.word));
        });
      });
    }
  }
  // A word must be seen twice: some old pages were written without Turkish letters.
  const wordMap = {};
  for (const [k, v] of Object.entries(words)) {
    const top = best(v);
    if (v[top] >= 2) wordMap[k] = top;
  }
  Object.assign(wordMap, TEMPLATE_PLACEHOLDER_WORDS, readTsv(PLACEHOLDERS_FILE));
  const descMap = {};
  for (const [k, v] of Object.entries(descs)) descMap[k] = best(v);
  Object.assign(descMap, TEMPLATE_DESCRIPTIONS);
  return { wordMap, descMap };
}

// ---------- status & ranking ----------

function pageStatus(repo, id) {
  const trFile = path.join(repo, `pages.${LANG}`, `${id}.md`);
  if (!fs.existsSync(trFile)) return 'missing';
  const en = parsePage(fs.readFileSync(path.join(repo, 'pages', `${id}.md`), 'utf8'));
  const tr = parsePage(fs.readFileSync(trFile, 'utf8'));
  const a = en.examples.map((e) => normalizeCmd(e.cmd)).sort().join('\n');
  const b = tr.examples.map((e) => normalizeCmd(e.cmd)).sort().join('\n');
  return a === b ? 'ok' : 'outdated';
}

function rank(repo, opts) {
  const langDirs = fs.readdirSync(repo).filter((d) => /^pages\.[a-z]{2}/.test(d) && d !== `pages.${LANG}` && d !== 'pages.en');
  const langSets = langDirs.map((d) => new Set(listPages(path.join(repo, d))));
  const rows = [];
  for (const id of listPages(path.join(repo, 'pages'))) {
    const [platform] = id.split('/');
    if (opts.platform && !opts.platform.split(',').includes(platform)) continue;
    const status = pageStatus(repo, id);
    if (status === 'ok') continue;
    if (opts.status && opts.status !== 'all' && opts.status !== status) continue;
    const text = fs.readFileSync(path.join(repo, 'pages', `${id}.md`), 'utf8');
    // Pure alias pages are filled in from templates alone, so they cost nothing to translate.
    const isAlias = /^> This command is an alias of `[^`]+`\.$/m.test(text) && (text.match(/^- /gm) || []).length === 1
      && text.split('\n').filter((l) => l.startsWith('> ')).every((l) => /^> (This command is an alias of `[^`]+`|More information: <.+>)\.$/.test(l));
    if (opts.type === 'alias' && !isAlias) continue;
    if (opts.type === 'normal' && isAlias) continue;
    const langs = langSets.filter((s) => s.has(id)).length;
    const score = +((langs + 1) * (PLATFORM_WEIGHT[platform] ?? DEFAULT_PLATFORM_WEIGHT)).toFixed(1);
    rows.push({ id, status, type: isAlias ? 'alias' : 'normal', langs, score });
  }
  rows.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  return { rows, totalLangs: langDirs.length };
}

// ---------- translation providers ----------

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
// Wraps inline code so the engine leaves it alone, and turns it back afterwards.
function protect(s, open, close) {
  return splitCode(s).map((p) => (p.code ? `${open}${escapeXml(p.text.slice(1, -1))}${close}` : escapeXml(p.text))).join('');
}
function unprotect(s, openRe, closeRe) {
  return unescapeXml(s.replace(new RegExp(`${openRe}([\\s\\S]*?)${closeRe}`, 'g'), '`$1`'));
}

function readPairs(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t').map((x) => x.trim()))
    .filter((p) => p.length === 2 && p[0] && p[1]);
}
const readGlossary = () => readPairs(GLOSSARY_FILE);
const readTsv = (file) => Object.fromEntries(readPairs(file));

async function httpJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const providers = {
  // Free: 500k chars/month. Key from https://www.deepl.com/pro-api
  deepl: {
    async translate(texts, kind, state) {
      const key = process.env.DEEPL_API_KEY || die('set DEEPL_API_KEY');
      const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
      const headers = { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' };
      const glossaryId = await deeplGlossary(host, headers, state);
      const out = [];
      for (const part of chunk(texts, 50)) {
        const body = {
          text: part.map((t) => protect(t, '<x>', '</x>')),
          source_lang: 'EN',
          target_lang: 'TR',
          tag_handling: 'xml',
          ignore_tags: ['x'],
          ...(glossaryId ? { glossary_id: glossaryId } : {}),
          ...(kind === 'description' ? { context: 'Short descriptions of command-line examples in a cheat sheet for terminal commands.' } : {}),
        };
        const res = await httpJson(`${host}/v2/translate`, { method: 'POST', headers, body: JSON.stringify(body) });
        out.push(...res.translations.map((t) => unprotect(t.text, '<x>', '</x>')));
      }
      return out;
    },
  },

  // Free tier (F0): 2M chars/month. Create a "Translator" resource in the Azure portal.
  azure: {
    async translate(texts) {
      const key = process.env.AZURE_TRANSLATOR_KEY || die('set AZURE_TRANSLATOR_KEY');
      const region = process.env.AZURE_TRANSLATOR_REGION || die('set AZURE_TRANSLATOR_REGION (e.g. westeurope)');
      const url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=tr&textType=html';
      const headers = { 'Ocp-Apim-Subscription-Key': key, 'Ocp-Apim-Subscription-Region': region, 'Content-Type': 'application/json' };
      const open = '<span class="notranslate">';
      const out = [];
      for (const part of chunk(texts, 100)) {
        const res = await httpJson(url, { method: 'POST', headers, body: JSON.stringify(part.map((t) => ({ Text: protect(t, open, '</span>') }))) });
        out.push(...res.map((r) => unprotect(r.translations[0].text, '<span class="notranslate">', '</span>')));
      }
      return out;
    },
  },

  // Any OpenAI-compatible chat API: Gemini, DeepSeek, OpenRouter, Groq, local Ollama, ...
  llm: {
    async translate(texts, kind) {
      const base = (process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
      const key = process.env.LLM_API_KEY || '';
      const model = process.env.LLM_MODEL || die('set LLM_MODEL (e.g. a current Gemini Flash model name)');
      const glossary = readGlossary().map(([en, tr]) => `${en} = ${tr}`).join('\n');
      const system = kind === 'placeholder'
        ? 'Translate each English noun phrase to a short Turkish noun phrase in lowercase. These are argument placeholders in shell command examples (e.g. "branch name" -> "dal adı"). Return JSON {"translations": [...]} with the same number of items, in order.'
        : [
          'You translate English tldr-pages (command-line cheat sheet) lines into Turkish.',
          'Rules:',
          '- Use the informal imperative (e.g. "Dosyaları listele", not "Dosyaları listeleyin").',
          '- Keep everything inside backticks exactly as is. Do not add or remove backticks.',
          '- Keep it short and natural. Do not translate command names, options, or file names.',
          '- Keep a trailing colon if the input has one.',
          glossary ? `- Use this terminology:\n${glossary}` : '',
          'Return JSON {"translations": [...]} with the same number of items, in order.',
        ].join('\n');
      const out = [];
      for (const part of chunk(texts, 40)) {
        const res = await httpJson(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ items: part }) }],
          }),
        });
        const raw = res.choices[0].message.content.replace(/^```(?:json)?\s*|\s*```$/g, '');
        const list = JSON.parse(raw).translations;
        if (!Array.isArray(list) || list.length !== part.length) throw new Error(`LLM returned ${list && list.length} items for ${part.length}`);
        out.push(...list.map(String));
      }
      return out;
    },
  },

  // No API: deterministic parts are filled in, the rest stays English for you to translate by hand.
  none: { async translate(texts) { return texts.map(() => null); } },

  // For testing the pipeline without an API.
  mock: { async translate(texts, kind) { return texts.map((t) => (kind === 'placeholder' ? `tr ${t}` : `[TR] ${t}`)); } },
};

async function deeplGlossary(host, headers, state) {
  const entries = readGlossary();
  if (!entries.length) return null;
  const tsv = entries.map((e) => e.join('\t')).join('\n');
  const hash = crypto.createHash('sha1').update(host + tsv).digest('hex');
  if (state.deeplGlossary && state.deeplGlossary.hash === hash) return state.deeplGlossary.id;
  if (state.deeplGlossary) {
    await fetch(`${host}/v2/glossaries/${state.deeplGlossary.id}`, { method: 'DELETE', headers }).catch(() => {});
  }
  const res = await httpJson(`${host}/v2/glossaries`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'tldr-tr', source_lang: 'en', target_lang: 'tr', entries: tsv, entries_format: 'tsv' }),
  });
  state.deeplGlossary = { id: res.glossary_id, hash };
  writeJson(STATE_FILE, state);
  console.log(`created DeepL glossary with ${entries.length} entries`);
  return res.glossary_id;
}

// Machine translation often gives the polite "-(y)In" imperative. Convert the final verb to the
// informal form used by most Turkish pages: "listeleyin" -> "listele", "kontrol edin" -> "kontrol et".
const IRREGULAR = { edin: 'et', gidin: 'git', deyin: 'de', yiyin: 'ye' };
const NOT_VERBS = new Set(['için', 'gibi', 'önce', 'sonra', 'birin', 'bin', 'din', 'kin', 'yin']);
function toInformal(desc) {
  const m = desc.match(/^(.*?)([\p{L}]+)(:?)$/u);
  if (!m) return desc;
  const [, head, word, colon] = m;
  if (NOT_VERBS.has(word)) return desc;
  if (IRREGULAR[word]) return head + IRREGULAR[word] + colon;
  const v = word.match(/^(.+?)(?:y[ıiuü]n|[ıiuü]n)$/u);
  if (!v || v[1].length < 2) return desc;
  return head + v[1] + colon;
}

// ---------- page translation ----------

class Translator {
  constructor(repo, providerName, opts) {
    this.repo = repo;
    this.providerName = providerName;
    this.provider = providers[providerName] || die(`unknown provider "${providerName}"`);
    this.opts = opts;
    this.cache = readJson(CACHE_FILE, {});
    this.state = readJson(STATE_FILE, {});
    Object.assign(this, learn(repo));
    this.queue = { description: new Map(), placeholder: new Map() };
    this.charsSent = 0;
  }

  cacheKey(kind, text) { return `${this.providerName}|${kind}|${text}`; }

  // Returns a function that yields the translation once flush() ran.
  request(kind, text, notes) {
    const key = this.cacheKey(kind, text);
    if (!(key in this.cache)) this.queue[kind].set(text, key);
    return () => {
      const t = this.cache[key];
      if (t == null) { notes.push(`not translated (left in English): "${text}"`); return text; }
      return t;
    };
  }

  async flush() {
    for (const kind of ['description', 'placeholder']) {
      const texts = [...this.queue[kind].keys()];
      if (!texts.length) continue;
      this.charsSent += texts.reduce((n, t) => n + t.length, 0);
      const result = await this.provider.translate(texts, kind, this.state);
      texts.forEach((t, i) => {
        if (result[i] != null) this.cache[this.cacheKey(kind, t)] = result[i];
      });
      this.queue[kind].clear();
      if (this.providerName !== 'mock' && this.providerName !== 'none') writeJson(CACHE_FILE, this.cache);
    }
  }

  // ---- descriptions ----

  description(enDesc, notes) {
    let text = stripColon(stripMnemonics(enDesc)).trim();
    let prefix = '';
    if (text.startsWith('[Interactive] ')) { prefix = `${TEMPLATE.interactive} `; text = text.slice(14); }
    const known = this.descMap[text];
    if (known) return () => `${prefix}${known}:`;
    const get = this.request('description', text, notes);
    return () => {
      let t = get().trim().replace(/\s*[.:]$/, '');
      if (codeSpans(t).join() !== codeSpans(text).join()) notes.push(`inline code changed, check: "${t}"`);
      if (this.opts.informal !== false) {
        const informal = toInformal(t);
        if (informal !== t) t = informal;
      }
      return `${prefix}${t}:`;
    };
  }

  headerLine(line, notes) {
    let m;
    if ((m = line.match(/^More information: <(.+)>\.$/))) return () => TEMPLATE.moreInfo(m[1]);
    if ((m = line.match(/^See also: (.+)\.$/))) return () => TEMPLATE.seeAlso(m[1]);
    if ((m = line.match(/^This command is an alias of (`[^`]+`)\.$/))) return () => TEMPLATE.alias(m[1]);
    if ((m = line.match(/^Some subcommands such as (.+) have their own usage documentation\.$/))) return () => TEMPLATE.subcommands(m[1]);
    const isNote = line.startsWith('Note: ');
    const body = isNote ? line.slice(6) : line;
    const get = this.request('description', body, notes);
    return () => {
      const t = get().trim();
      if (codeSpans(t).join() !== codeSpans(body).join()) notes.push(`inline code changed, check: "${t}"`);
      return (isNote ? TEMPLATE.notePrefix : '') + t;
    };
  }

  // ---- placeholders ----

  placeholder(inner, notes) {
    if (inner.startsWith('[')) return () => inner;
    const parts = inner.split(' ').map((tok) => this.token(tok, notes));
    return () => parts.map((f) => f()).join(' ');
  }

  token(tok, notes) {
    if (tok === '...' || !tok) return () => tok;
    const p = parseToken(tok, false);
    if (!p) return () => tok; // literal value like 8080, https://example.com, *.txt
    const hasPath = p.prefix === 'path/to/';
    if (!hasPath && p.ext) return () => tok; // literal file name like file.txt
    const pre = hasPath ? 'yol/' : '';
    const known = this.wordMap[p.word];
    if (known) return () => `${pre}${known}${p.num}${p.ext}`;
    if (!hasPath && !p.word.includes('_')) {
      notes.push(`kept placeholder \`{{${tok}}}\` in English (single word, may be a literal value)`);
      return () => tok;
    }
    const get = this.request('placeholder', p.word.replace(/_/g, ' '), notes);
    return () => {
      const t = trLower(get()).trim().replace(/[^\p{L}\d]+/gu, '_').replace(/^_|_$/g, '');
      notes.push(`machine-translated placeholder \`${tok}\` -> \`${pre}${t}${p.num}${p.ext}\``);
      return `${pre}${t}${p.num}${p.ext}`;
    };
  }

  command(cmd, notes) {
    const parts = [];
    let last = 0;
    for (const m of cmd.matchAll(/\{\{(.*?)\}\}/g)) {
      const lit = cmd.slice(last, m.index);
      parts.push(() => lit);
      const f = this.placeholder(m[1], notes);
      parts.push(() => `{{${f()}}}`);
      last = m.index + m[0].length;
    }
    const tail = cmd.slice(last);
    parts.push(() => tail);
    return () => parts.map((f) => f()).join('');
  }

  // ---- whole pages ----

  // Returns a function that builds the Turkish page after flush().
  plan(id, status) {
    const notes = [];
    const en = parsePage(fs.readFileSync(path.join(this.repo, 'pages', `${id}.md`), 'utf8'));
    const trFile = path.join(this.repo, `pages.${LANG}`, `${id}.md`);
    const old = status === 'outdated' ? parsePage(fs.readFileSync(trFile, 'utf8')) : null;

    // Header
    let header;
    if (old) {
      const deterministic = /^(More information|See also|This command is an alias of|Some subcommands such as)/;
      const oldDesc = old.header.filter((h) => !/^(Daha fazla bilgi|Ayrıca bakınız|Bu komut .* takma ad|.* alt komutların)/.test(h));
      const enDesc = en.header.filter((h) => !deterministic.test(h));
      const keepOld = oldDesc.length === enDesc.length && oldDesc.length > 0;
      if (keepOld) notes.push('kept the old Turkish page description; compare it with the English one');
      let k = 0;
      header = en.header.map((h) => (deterministic.test(h) || !keepOld ? this.headerLine(h, notes) : ((v) => () => v)(oldDesc[k++])));
    } else {
      header = en.header.map((h) => this.headerLine(h, notes));
    }

    // Examples
    const pool = old ? [...old.examples] : [];
    const examples = en.examples.map((ex) => {
      const t = takeMatch(pool, ex.cmd);
      if (t) {
        // Reuse the human translation, but rebuild the command from the current English one.
        // Old Turkish placeholders are kept unless they miss the "yol/" prefix of path/to/ placeholders.
        const fresh = this.command(ex.cmd, notes);
        return () => {
          const ep = placeholders(ex.cmd);
          const tp = placeholders(t.cmd);
          const fp = placeholders(fresh());
          if (tp.length !== ep.length) return { desc: t.desc, cmd: fresh() };
          let k = 0;
          const cmd = ex.cmd.replace(/\{\{(?!\[)(.*?)\}\}/g, () => {
            const j = k++;
            return ep[j].includes('path/to/') && !tp[j].includes('yol/') ? `{{${fp[j]}}}` : `{{${tp[j]}}}`;
          });
          return { desc: t.desc, cmd };
        };
      }
      if (old) notes.push(`new example: "${ex.desc}"`);
      const d = this.description(ex.desc, notes);
      const c = this.command(ex.cmd, notes);
      return () => ({ desc: d(), cmd: c() });
    });
    for (const t of pool) notes.push(`removed old example (no longer in English page): "${t.desc}"`);

    return () => {
      // Build the text first: building adds review notes.
      const text = renderPage({ title: en.title, header: header.map((f) => f()), examples: examples.map((f) => f()) });
      return { file: trFile, notes: [...new Set(notes)], text };
    };
  }
}

// ---------- commands ----------

function cmdPlan(repo, args) {
  const { rows, totalLangs } = rank(repo, args);
  const limit = args.limit ? +args.limit : 40;
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  console.log(`To do: ${rows.length} pages (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  console.log(`Score = (number of the ${totalLangs} other languages that have the page + 1) x platform weight\n`);
  console.log('score  langs  status    type    page');
  for (const r of rows.slice(0, limit)) {
    console.log(`${String(r.score).padStart(5)}  ${String(r.langs).padStart(5)}  ${r.status.padEnd(8)}  ${r.type.padEnd(6)}  ${r.id}`);
  }
  if (args.out) {
    fs.writeFileSync(args.out, ['score\tlangs\tstatus\ttype\tpage', ...rows.map((r) => `${r.score}\t${r.langs}\t${r.status}\t${r.type}\t${r.id}`)].join('\n') + '\n');
    console.log(`\nfull list written to ${args.out}`);
  }
}

// Prints the placeholder words the tool will use, so they can be copied into placeholders.tsv and fixed.
function cmdTerms(repo) {
  const { wordMap } = learn(repo);
  console.log('# English placeholder word<TAB>Turkish. Copy lines into placeholders.tsv to fix or pin them.');
  for (const [en, tr] of Object.entries(wordMap).sort()) console.log(`${en}\t${tr}`);
}

async function cmdTranslate(repo, args) {
  const providerName = args.provider || process.env.TLDR_TR_PROVIDER || 'none';
  let targets;
  if (args.pages) {
    targets = args.pages.split(',').map((id) => {
      if (!fs.existsSync(path.join(repo, 'pages', `${id}.md`))) die(`no English page ${id}`);
      return { id, status: pageStatus(repo, id) };
    });
  } else {
    targets = rank(repo, args).rows.slice(0, args.limit ? +args.limit : 10);
  }
  if (!targets.length) return console.log('nothing to do');

  const tr = new Translator(repo, providerName, { informal: args.formal ? false : true });
  const builders = targets.map((t) => tr.plan(t.id, t.status === 'ok' ? 'outdated' : t.status));
  await tr.flush();
  const results = builders.map((b) => b());

  const report = [`# Review notes (${new Date().toISOString().slice(0, 10)}, provider: ${providerName})`, ''];
  for (const r of results) {
    const rel = path.relative(repo, r.file);
    if (args['dry-run']) console.log(`----- ${rel}\n${r.text}`);
    else { fs.mkdirSync(path.dirname(r.file), { recursive: true }); fs.writeFileSync(r.file, r.text); }
    report.push(`## ${rel}`, '', ...(r.notes.length ? r.notes.map((n) => `- [ ] ${n}`) : ['- [ ] proofread']), '');
  }
  fs.writeFileSync(NOTES_FILE, report.join('\n'));
  console.log(`${args['dry-run'] ? 'would write' : 'wrote'} ${results.length} page(s); sent ${tr.charsSent} characters to "${providerName}"`);
  console.log(`review checklist: ${NOTES_FILE}`);

  if (!args['dry-run'] && !args['no-lint']) {
    const lint = path.join(repo, 'node_modules', '.bin', 'tldr-lint');
    if (fs.existsSync(lint)) {
      let bad = 0;
      for (const r of results) {
        try { execFileSync(lint, ['--ignore', 'TLDR003,TLDR004,TLDR015,TLDR104', r.file], { stdio: 'pipe' }); } catch (e) {
          bad++;
          console.log(String(e.stdout || e.message).trim());
        }
      }
      console.log(bad ? `tldr-lint: problems in ${bad} page(s), see above` : 'tldr-lint: all pages OK');
    } else console.log('tip: run `npm install` in the repo so the pages get linted automatically');
  }
}

function findRepo(args) {
  const candidates = [args.repo, process.cwd(), path.join(TOOL_DIR, '..', 'tldr'), path.join(TOOL_DIR, '..', 'tldr-tr')].filter(Boolean);
  const repo = candidates.find((d) => fs.existsSync(path.join(d, 'pages')) && fs.existsSync(path.join(d, `pages.${LANG}`)));
  return repo ? path.resolve(repo) : die('cannot find the tldr repo; run inside it or pass --repo <path>');
}

const HELP = `tldr-tr: find, rank and machine-translate tldr pages into Turkish for human review.

Usage:
  node tldr-tr.js plan       [--limit 40] [--status missing|outdated|all] [--type alias|normal]
                             [--platform common,linux] [--out queue.tsv]
  node tldr-tr.js translate  [--provider none|deepl|azure|llm|mock] [--limit 10] [--pages common/tar,linux/ip]
                             [--status ...] [--type ...] [--platform ...] [--dry-run] [--formal] [--no-lint]
  node tldr-tr.js terms      print the placeholder words in use (learned + templates + placeholders.tsv)
Common:
  --repo <path>   path to your tldr clone (default: current directory)

Providers (set the env vars):
  deepl  DEEPL_API_KEY                    (free plan: 500k chars/month)
  azure  AZURE_TRANSLATOR_KEY, AZURE_TRANSLATOR_REGION  (free tier: 2M chars/month)
  llm    LLM_MODEL, LLM_API_KEY, LLM_BASE_URL (any OpenAI-compatible API; default base is Gemini)
  none   no API: fills in templates and known wording, leaves the rest in English for you
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) return console.log(HELP);
  const repo = findRepo(args);
  if (cmd === 'plan') return cmdPlan(repo, args);
  if (cmd === 'translate') return cmdTranslate(repo, args);
  if (cmd === 'terms') return cmdTerms(repo);
  die(`unknown command "${cmd}"\n\n${HELP}`);
}

main().catch((e) => die(e.message));
