/**
 * GBA-DL PRO — Serveur local v4 (CORRIGÉ)
 *
 * PRÉREQUIS :
 *   1. Node.js  → https://nodejs.org
 *   2. yt-dlp.exe dans le même dossier que server.js
 *      → https://github.com/yt-dlp/yt-dlp/releases  (télécharger yt-dlp.exe)
 *
 * LANCEMENT : node server.js
 * Le navigateur s'ouvre automatiquement sur http://127.0.0.1:7331
 */

const http   = require('http');
const { execFile, exec } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const PORT             = 7331;
const CONFIG_FILE      = path.join(os.homedir(), '.gbadl_config.json');

// ── Config persistante (dossier de téléchargement) ────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch(e) { console.error('Erreur saveConfig:', e.message); }
}

let appConfig     = loadConfig();
let DOWNLOAD_DIR  = appConfig.downloadDir || path.join(os.homedir(), 'Downloads', 'GameboyDL');
const HISTORY_FILE = () => path.join(DOWNLOAD_DIR, '.history.json');
const CONVERT_DIR  = () => path.join(DOWNLOAD_DIR, '.converting');

// Cookies : cherche cookies.txt dans le même dossier que server.js
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

function ensureDirs() {
  for (const dir of [DOWNLOAD_DIR, CONVERT_DIR()]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
ensureDirs();

// ── Détecter yt-dlp ──────────────────────────────────────
function getYtDlpBin() {
  const candidates = [
    path.join(__dirname, 'yt-dlp.exe'),
    path.join(__dirname, 'yt-dlp'),
    path.join(__dirname, 'yt-dlp_arm64.exe'),
    path.join(__dirname, 'yt-dlp_x86.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
}
const YT_DLP = getYtDlpBin();
console.log(`  yt-dlp → ${YT_DLP}`);

// ── Détecter les dépendances ─────────────────────────────
let hasFfmpeg = false;
let hasPydub  = false;
let hasPython = false;

exec('ffmpeg -version', err => {
  hasFfmpeg = !err;
  console.log(hasFfmpeg ? '  → ffmpeg détecté ✓' : '  → ffmpeg non trouvé');
});

function detectPydub() {
  const cmds = ['python3', 'python', 'py'];
  cmds.forEach(cmd => {
    exec(`${cmd} -c "import pydub; print('ok')"`, { timeout: 5000 }, (err, stdout) => {
      if (!err && stdout.trim() === 'ok' && !hasPydub) {
        hasPydub = true;
        hasPython = cmd;
        console.log(`  → pydub détecté via ${cmd} ✓`);
      }
    });
  });
}
detectPydub();

exec(`"${YT_DLP}" --version`, (err, stdout) => {
  if (!err) console.log(`  → yt-dlp version : ${stdout.trim()}`);
  else console.error('  ✗ yt-dlp introuvable ! Place yt-dlp.exe dans le même dossier que server.js');
});

// ── Historique ───────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8')); } catch { return []; }
}
function saveHistory(h) {
  try { fs.writeFileSync(HISTORY_FILE(), JSON.stringify(h, null, 2)); } catch(e) { console.error('Erreur save history:', e.message); }
}
function addHistory(entry) {
  const h = loadHistory();
  h.unshift(entry);
  if (h.length > 500) h.pop();
  saveHistory(h);
}

// ── Convertir en MP3 via pydub ───────────────────────────
function convertToPydubMp3(inputFile, outputFile) {
  return new Promise((resolve, reject) => {
    if (!hasPydub) return reject(new Error('E005: pydub non installé'));
    const script = `
from pydub import AudioSegment
import sys
try:
    audio = AudioSegment.from_file(sys.argv[1])
    audio.export(sys.argv[2], format='mp3', bitrate='320k')
    print('ok')
except Exception as e:
    print('error:' + str(e), file=sys.stderr)
    sys.exit(1)
`;
    const tmpScript = path.join(CONVERT_DIR(), 'conv_' + Date.now() + '.py');
    fs.writeFileSync(tmpScript, script);
    exec(`${hasPython} "${tmpScript}" "${inputFile}" "${outputFile}"`, { timeout: 120000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) return reject(new Error('E005: Conversion pydub échouée — ' + (stderr || err.message)));
      resolve(outputFile);
    });
  });
}

// ── Construire les args yt-dlp ───────────────────────────
function buildArgs(videoUrl, format) {
  const out = path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s');

  // Cookies optionnels — si cookies.txt présent, on l'utilise pour éviter le rate-limit YouTube
  const cookieArgs = fs.existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];

  // Args de base — robustes, sans player_skip qui casse YouTube
  const base = [
    videoUrl,
    '--no-playlist',
    '-o', out,
    '--progress-template', '%(progress._percent_str)s|||%(progress.speed_str)s|||%(progress._eta_str)s',
    '--no-check-certificates',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--extractor-retries', '5',
    '--fragment-retries', '5',
    '--retry-sleep', '2',
    '--socket-timeout', '30',
    '--no-abort-on-error',
    ...cookieArgs,
  ];

  switch (format) {
    case 'mp3':
      if (hasFfmpeg) {
        // --embed-thumbnail intègre la cover art dans le fichier MP3
        return [...base, '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                '--embed-thumbnail', '--add-metadata',
                '--postprocessor-args', 'ffmpeg:-id3v2_version 3'];
      }
      return [...base, '-f', 'bestaudio[ext=m4a]/bestaudio/best', '--no-post-overwrites'];

    case 'm4a':
      if (hasFfmpeg) {
        return [...base, '-f', 'bestaudio[ext=m4a]/bestaudio/best',
                '--embed-thumbnail', '--add-metadata'];
      }
      return [...base, '-f', 'bestaudio[ext=m4a]/bestaudio/best'];

    case 'wav':
      if (hasFfmpeg) return [...base, '-x', '--audio-format', 'wav'];
      return [...base, '-f', 'bestaudio[ext=m4a]/bestaudio/best'];

    case 'best':
      if (hasFfmpeg) return [...base, '-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4'];
      return [...base, '-f', 'best[ext=mp4]/best'];

    case '720':
      if (hasFfmpeg) return [...base, '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]', '--merge-output-format', 'mp4'];
      return [...base, '-f', 'best[height<=720][ext=mp4]/best[height<=720]'];

    case '480':
      if (hasFfmpeg) return [...base, '-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]', '--merge-output-format', 'mp4'];
      return [...base, '-f', 'best[height<=480][ext=mp4]/best[height<=480]'];

    default: // mp4 / 1080p
      if (hasFfmpeg) return [...base, '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '--merge-output-format', 'mp4'];
      return [...base, '-f', 'best[height<=1080][ext=mp4]/best'];
  }
}

// ── Helpers HTTP ─────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ── Jobs ─────────────────────────────────────────────────
const jobs = {};

// ── Serveur HTTP ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const route  = urlObj.pathname;
  const query  = urlObj.searchParams;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── GET / → servir index.html ────────────────────────
  if ((route === '/' || route === '/index.html') && req.method === 'GET') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2 style="font-family:sans-serif;color:#0f0;background:#000;padding:40px">
        ✅ Serveur GBA-DL actif !<br><br>
        <small style="color:#888">Place index.html dans le même dossier que server.js</small>
      </h2>`);
    }
    return;
  }

  // ── GET /status ─────────────────────────────────────
  if (route === '/status' && req.method === 'GET') {
    exec(`"${YT_DLP}" --version`, (err, stdout) => {
      sendJson(res, 200, {
        ok:         true,
        ytdlp:      !err,
        version:    stdout ? stdout.trim() : null,
        ffmpeg:     hasFfmpeg,
        pydub:      hasPydub,
        python:     hasPython || null,
        dir:        DOWNLOAD_DIR,
        cookies:    fs.existsSync(COOKIES_FILE),
        cookiesPath: COOKIES_FILE,
      });
    });
    return;
  }

  // ── GET /config ──────────────────────────────────────
  if (route === '/config' && req.method === 'GET') {
    sendJson(res, 200, { downloadDir: DOWNLOAD_DIR, cookies: fs.existsSync(COOKIES_FILE), cookiesPath: COOKIES_FILE });
    return;
  }

  // ── POST /config ─────────────────────────────────────
  // Body: { downloadDir: "C:\\Users\\..." }
  if (route === '/config' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { downloadDir } = JSON.parse(body);
        if (!downloadDir || typeof downloadDir !== 'string') return sendJson(res, 400, { error: 'downloadDir manquant' });
        // Créer le dossier si besoin
        if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
        DOWNLOAD_DIR = downloadDir;
        appConfig.downloadDir = downloadDir;
        saveConfig(appConfig);
        ensureDirs();
        console.log(`  📁 Dossier changé → ${DOWNLOAD_DIR}`);
        sendJson(res, 200, { ok: true, downloadDir: DOWNLOAD_DIR });
      } catch(e) { sendJson(res, 400, { error: 'JSON invalide ou dossier inaccessible: ' + e.message }); }
    });
    return;
  }

  // ── GET /info?url= ──────────────────────────────────
  if (route === '/info' && req.method === 'GET') {
    const vu = query.get('url');
    if (!vu) return sendJson(res, 400, { error: 'E002: url manquante' });

    const args = [
      '--print', '%(title)s|||%(duration_string)s|||%(uploader)s|||%(thumbnail)s|||%(view_count)s',
      '--no-playlist',
      '--socket-timeout', '20',
      '--no-check-certificates',
      vu
    ];

    execFile(YT_DLP, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toLowerCase();
        let code = 'E013';
        if (msg.includes('private') || msg.includes('removed')) code = 'E004';
        else if (msg.includes('region') || msg.includes('not available')) code = 'E010';
        else if (msg.includes('age')) code = 'E011';
        return sendJson(res, 500, { error: `${code}: impossible de lire les infos — ${(stderr || err.message).slice(0, 150)}` });
      }
      const p = stdout.trim().split('|||');
      sendJson(res, 200, { title: p[0] || '???', duration: p[1] || '??', uploader: p[2] || '?', thumbnail: p[3] || null, views: p[4] || null });
    });
    return;
  }

  // ── POST /download ──────────────────────────────────
  if (route === '/download' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { return sendJson(res, 400, { error: 'E014: JSON invalide' }); }

      const { url: vu, format = 'mp4', title = '' } = payload;
      if (!vu) return sendJson(res, 400, { error: 'E002: url manquante' });
      // Accepter les URLs classiques ET les requêtes ytsearch:
      const isYtSearch = vu.startsWith('ytsearch');
      if (!isYtSearch) {
        try { new URL(vu); } catch { return sendJson(res, 400, { error: 'E002: URL malformée' }); }
      }

      const jobId = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      jobs[jobId] = { status: 'running', progress: 0, log: [], file: null, error: null, title, format, speed: null, eta: null };
      sendJson(res, 200, { jobId });

      const args = buildArgs(vu, format);
      console.log(`\n  [${jobId}] Démarrage: ${format} — ${vu.slice(0, 70)}`);

      let lastFile   = null;
      let stderrFull = '';
      let proc;

      try {
        proc = execFile(YT_DLP, args, { maxBuffer: 100 * 1024 * 1024 });
      } catch(e) {
        jobs[jobId].status = 'error';
        jobs[jobId].error  = 'E007: yt-dlp introuvable — ' + e.message;
        return;
      }

      proc.stdout.on('data', data => {
        data.toString().split('\n').forEach(line => {
          line = line.trim();
          if (!line) return;
          if (line.includes('|||')) {
            const pts = line.split('|||');
            const pct = parseFloat(pts[0]);
            if (!isNaN(pct)) jobs[jobId].progress = Math.round(pct);
            if (pts[1]) jobs[jobId].speed = pts[1].trim();
            if (pts[2]) jobs[jobId].eta   = pts[2].trim();
            jobs[jobId].log.push(`${pts[0].trim()} | ${(pts[1]||'').trim()}`);
          } else {
            const dm = line.match(/Destination:\s*(.+)/);
            if (dm) lastFile = dm[1].trim();
            const mr = line.match(/Merging formats into "(.+)"/);
            if (mr) lastFile = mr[1].trim();
            if (/\[(download|ffmpeg|ExtractAudio|VideoConvertor)\]/.test(line)) {
              jobs[jobId].log.push(line.replace(/\[.*?\]/, '').trim().slice(0, 90));
            }
          }
          if (jobs[jobId].log.length > 80) jobs[jobId].log.shift();
        });
      });

      proc.stderr.on('data', d => {
        const text = d.toString();
        stderrFull += text;
        text.split('\n').forEach(l => {
          l = l.trim();
          if (!l) return;
          if (l.includes('WARNING:')) jobs[jobId].log.push('⚠ ' + l.replace(/WARNING:/i, '').trim().slice(0, 90));
          else if (l.includes('ERROR:'))   jobs[jobId].log.push('! ' + l.replace(/ERROR:/i, '').trim().slice(0, 90));
        });
      });

      proc.on('close', async code => {
        if (code === 0) {
          if (!lastFile) {
            try {
              const files = fs.readdirSync(DOWNLOAD_DIR)
                .filter(f => !f.startsWith('.') && !f.endsWith('.py') && !f.endsWith('.part'))
                .map(f => ({ f, t: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtimeMs }))
                .sort((a, b) => b.t - a.t);
              if (files.length) lastFile = path.join(DOWNLOAD_DIR, files[0].f);
            } catch {}
          }

          if (format === 'mp3' && !hasFfmpeg && hasPydub && lastFile) {
            const ext = path.extname(lastFile).toLowerCase();
            if (ext !== '.mp3') {
              jobs[jobId].log.push('🔄 Conversion MP3 via pydub...');
              const mp3File = lastFile.replace(/\.[^.]+$/, '.mp3');
              try {
                await convertToPydubMp3(lastFile, mp3File);
                try { fs.unlinkSync(lastFile); } catch {}
                lastFile = mp3File;
                jobs[jobId].log.push('✓ Conversion MP3 terminée !');
              } catch(e) {
                jobs[jobId].log.push('! ' + e.message);
              }
            }
          }

          jobs[jobId].status   = 'done';
          jobs[jobId].progress = 100;
          jobs[jobId].file     = lastFile;
          jobs[jobId].log.push('✓ Téléchargement terminé !');

          const size = lastFile ? (() => { try { return fs.statSync(lastFile).size; } catch { return 0; } })() : 0;
          addHistory({ id: jobId, date: new Date().toISOString(), url: vu, title: title || path.basename(lastFile || '???'), format, file: lastFile, size });
          console.log(`  [${jobId}] ✓ Terminé — ${lastFile ? path.basename(lastFile) : 'inconnu'}`);

        } else {
          const errFull = (stderrFull + ' ' + jobs[jobId].log.join(' ')).toLowerCase();
          let errMsg = `Erreur yt-dlp (code ${code})`;

          if (errFull.includes('private') || errFull.includes('removed'))     errMsg = 'E004: Vidéo privée ou supprimée';
          else if (errFull.includes('not available in your country'))          errMsg = 'E010: Vidéo non disponible dans ta région';
          else if (errFull.includes('age') && errFull.includes('restrict'))   errMsg = 'E011: Restriction d\'âge';
          else if (errFull.includes('rate') || errFull.includes('too many'))  errMsg = 'E012: Rate limit — attends quelques minutes';
          else if (errFull.includes('disk') || errFull.includes('space'))     errMsg = 'E006: Disque plein';
          else if (errFull.includes('timeout'))                                errMsg = 'E009: Timeout — réessaie';
          else if (errFull.includes('no video formats'))                       errMsg = 'Aucun format — mets à jour yt-dlp : .\\yt-dlp.exe -U';
          else if (code === 2)                                                 errMsg = 'Extraction échouée — mets à jour yt-dlp : .\\yt-dlp.exe -U';

          jobs[jobId].status = 'error';
          jobs[jobId].error  = errMsg;
          jobs[jobId].log.push('! ' + errMsg);
          if (stderrFull) jobs[jobId].log.push('Détail: ' + stderrFull.slice(-300).trim());
          console.log(`  [${jobId}] ✗ Code ${code} — ${errMsg}`);
          if (stderrFull) console.log(`  stderr: ${stderrFull.slice(-400)}`);
        }
      });

      proc.on('error', e => {
        jobs[jobId].status = 'error';
        jobs[jobId].error  = 'E007: impossible de lancer yt-dlp — ' + e.message;
      });
    });
    return;
  }

  // ── GET /poll/:jobId ────────────────────────────────
  if (route.startsWith('/poll/') && req.method === 'GET') {
    const j = jobs[route.slice(6)];
    if (!j) return sendJson(res, 404, { error: 'E015: job introuvable' });
    sendJson(res, 200, j);
    return;
  }

  // ── GET /history ────────────────────────────────────
  if (route === '/history' && req.method === 'GET') {
    sendJson(res, 200, loadHistory());
    return;
  }

  // ── DELETE /history/:id ─────────────────────────────
  if (route.startsWith('/history/') && req.method === 'DELETE') {
    saveHistory(loadHistory().filter(e => e.id !== route.slice(9)));
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── GET /files ──────────────────────────────────────
  if (route === '/files' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(DOWNLOAD_DIR)
        .filter(f => !f.startsWith('.') && !f.endsWith('.py') && !f.endsWith('.part'))
        .map(f => {
          const fp = path.join(DOWNLOAD_DIR, f);
          try { const s = fs.statSync(fp); if (!s.isFile()) return null; return { name: f, size: s.size, mtime: s.mtimeMs }; }
          catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      sendJson(res, 200, files);
    } catch(e) { sendJson(res, 500, { error: 'E006: ' + e.message }); }
    return;
  }

  // ── GET /stream/:filename ────────────────────────────
  if (route.startsWith('/stream/') && req.method === 'GET') {
    const filename = decodeURIComponent(route.slice(8));
    const filepath = path.resolve(DOWNLOAD_DIR, filename);
    if (!filepath.startsWith(path.resolve(DOWNLOAD_DIR))) return sendJson(res, 403, { error: 'E999: accès refusé' });
    if (!fs.existsSync(filepath)) return sendJson(res, 404, { error: 'E015: fichier introuvable' });

    const stat = fs.statSync(filepath);
    const ext  = path.extname(filename).toLowerCase();
    const mime = { '.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.ogg':'audio/ogg','.aac':'audio/aac','.mp4':'video/mp4','.webm':'video/webm','.mkv':'video/x-matroska','.flac':'audio/flac' }[ext] || 'application/octet-stream';

    cors(res);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const [s, e2] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(s, 10), end = e2 ? parseInt(e2, 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
      fs.createReadStream(filepath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filepath).pipe(res);
    }
    return;
  }

  sendJson(res, 404, { error: 'Route inconnue: ' + route });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  ██████╗ ██████╗  █████╗       ██████╗ ██╗     ██████╗ ██████╗  ██████╗');
  console.log('  ██╔════╝ ██╔══██╗██╔══██╗     ██╔══██╗██║     ██╔══██╗██╔══██╗██╔═══██╗');
  console.log('  ██║  ███╗██████╔╝███████║     ██║  ██║██║     ██████╔╝██████╔╝██║   ██║');
  console.log('  ██║   ██║██╔══██╗██╔══██║     ██║  ██║██║     ██╔═══╝ ██╔══██╗██║   ██║');
  console.log('  ╚██████╔╝██████╔╝██║  ██║     ██████╔╝███████╗██║     ██║  ██║╚██████╔╝');
  console.log('   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝     ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝\n');
  console.log(`  ✅ Serveur actif → http://127.0.0.1:${PORT}`);
  console.log(`  📁 Dossier       → ${DOWNLOAD_DIR}\n`);
  // Ouvrir le navigateur automatiquement sur Windows
  exec(`start http://127.0.0.1:${PORT}`, () => {});
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} déjà utilisé — ferme l'autre instance et relance.\n`);
  } else {
    console.error('  ✗ Erreur serveur:', err.message);
  }
  process.exit(1);
});

process.on('uncaughtException', err => {
  console.error('  ✗ Erreur non gérée:', err.message);
});
