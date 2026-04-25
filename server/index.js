import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';
import ffmpegStatic from 'ffmpeg-static';
import helmet from 'helmet';
import morgan from 'morgan';
import sanitizeFilename from 'sanitize-filename';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundledYtDlpPath = path.resolve(
  __dirname,
  process.platform === 'win32' ? './bin/yt-dlp.exe' : './bin/yt-dlp',
);

const app = express();
const port = Number(process.env.PORT) || 3001;
const ytDlpPath = process.env.YTDLP_PATH || ((await pathExists(bundledYtDlpPath)) ? bundledYtDlpPath : 'yt-dlp');
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
const downloadTimeoutMs = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 25 * 60 * 1000;
const metadataTimeoutMs = Number(process.env.METADATA_TIMEOUT_MS) || 90 * 1000;
const instagramCookiePathEnvKeys = ['INSTAGRAM_COOKIES_PATH', 'YTDLP_COOKIES_PATH'];
const instagramInlineCookieEnvKeys = ['INSTAGRAM_COOKIES', 'YTDLP_COOKIES'];
const instagramBase64CookieEnvKeys = ['INSTAGRAM_COOKIES_BASE64', 'YTDLP_COOKIES_BASE64'];
const defaultInstagramCookieFilePath = path.join(__dirname, 'instagram-cookies.txt');
const instagramDesktopUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const instagramCookieFilePromise = resolveInstagramCookieFile();

const supportedHosts = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
];

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      directives: {
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'DX Downloader API',
    ok: true,
    endpoints: {
      health: '/api/health',
      info: '/api/info',
      download: '/api/download',
    },
  });
});

app.post('/api/info', async (req, res, next) => {
  try {
    const url = normalizeUrl(req.body?.url);
    assertSupportedUrl(url);

    const info = await fetchVideoInfo(url);

    res.json(info);
  } catch (error) {
    next(error);
  }
});

app.get('/api/download', async (req, res, next) => {
  try {
    const url = normalizeUrl(req.query?.url);
    const mode = normalizeMode(req.query?.mode);
    const quality = normalizeQuality(req.query?.quality);

    assertSupportedUrl(url);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frameflow-'));
    const outputTemplate = path.join(tempDir, '%(title).120B [%(id)s].%(ext)s');
    const authArgs = await buildSiteAuthArgs(url);
    const args = buildDownloadArgs({ url, mode, quality, outputTemplate, authArgs });

    await runYtDlp(args, downloadTimeoutMs, {
      url,
      authenticated: authArgs.includes('--cookies'),
    });

    const downloadedFile = await findDownloadedFile(tempDir);
    const stats = await fs.stat(downloadedFile);
    const filename = buildDownloadName(downloadedFile);
    let cleanedUp = false;

    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      await fs.rm(tempDir, { recursive: true, force: true });
    };

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', buildContentDisposition(filename));

    const fileStream = createReadStream(downloadedFile);
    fileStream.on('error', async (error) => {
      await cleanup().catch(() => {});
      next(error);
    });

    res.on('finish', () => {
      cleanup().catch(() => {});
    });

    res.on('close', () => {
      cleanup().catch(() => {});
    });

    fileStream.pipe(res);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'Unexpected error while processing the request.';

  if (res.headersSent) {
    return;
  }

  const statusCode = resolveStatusCode(message);
  res.status(statusCode).json({ message });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`DX server listening on port ${port}`);
  void logInstagramAccessMode();
});

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A valid YouTube or Instagram link is required.');
  }

  return value.trim();
}

function normalizeMode(value) {
  if (value === 'audio' || value === 'video') {
    return value;
  }

  return 'video';
}

function normalizeQuality(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return 'best';
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === 'best') {
    return 'best';
  }

  const parsedHeight = Number.parseInt(normalized, 10);

  if (Number.isFinite(parsedHeight) && parsedHeight > 0) {
    return String(parsedHeight);
  }

  return 'best';
}

function assertSupportedUrl(input) {
  let parsed;

  try {
    parsed = new URL(input);
  } catch {
    throw new Error('That link does not look like a valid URL.');
  }

  const host = parsed.hostname.toLowerCase();

  if (!supportedHosts.some((supportedHost) => host === supportedHost || host.endsWith(`.${supportedHost}`))) {
    throw new Error('Only public YouTube and Instagram video links are supported in this build.');
  }
}

async function fetchVideoInfo(url) {
  const authArgs = await buildSiteAuthArgs(url);
  const { stdout } = await runYtDlp(
    [...authArgs, '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', url],
    metadataTimeoutMs,
    { url, authenticated: authArgs.includes('--cookies') },
  );

  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed.entries) ? parsed.entries[0] : parsed;

  if (!entry) {
    throw new Error('No downloadable media details were returned for that link.');
  }

  return {
    url: entry.webpage_url || url,
    title: entry.title || 'Untitled video',
    thumbnail: entry.thumbnail || '',
    description: truncate(entry.description || '', 220),
    uploader: entry.uploader || entry.channel || entry.uploader_id || '',
    duration: entry.duration || null,
    uploadDate: formatUploadDate(entry.upload_date),
    viewCount: entry.view_count || null,
    platform: detectPlatform(entry.webpage_url || url, entry.extractor_key || entry.extractor),
    previewUrl: resolvePreviewUrl(entry),
    previewMimeType: resolvePreviewMimeType(entry),
    previewWidth: resolvePreviewWidth(entry),
    previewHeight: resolvePreviewHeight(entry),
    videoOptions: buildVideoOptions(entry),
  };
}

function buildDownloadArgs({ url, mode, quality, outputTemplate, authArgs = [] }) {
  const baseArgs = [
    ...authArgs,
    '--no-playlist',
    '--no-progress',
    '--newline',
    '--no-warnings',
    '--restrict-filenames',
    '--ffmpeg-location',
    ffmpegPath,
    '-o',
    outputTemplate,
  ];

  if (mode === 'audio') {
    return [
      ...baseArgs,
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      url,
    ];
  }

  return [
    ...baseArgs,
    '-f',
    buildVideoFormatSelector(quality),
    '--merge-output-format',
    'mp4',
    url,
  ];
}

async function runYtDlp(args, timeoutMs, context = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Unable to start yt-dlp: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      if (timedOut) {
        reject(new Error('Processing timed out while preparing the file.'));
        return;
      }

      reject(new Error(cleanYtError(stderr || stdout, context)));
    });
  });
}

async function buildSiteAuthArgs(url) {
  if (!isInstagramUrl(url)) {
    return [];
  }

  const args = [
    '--add-header',
    `User-Agent:${instagramDesktopUserAgent}`,
    '--add-header',
    'Referer:https://www.instagram.com/',
    '--add-header',
    'Origin:https://www.instagram.com',
  ];
  const cookieFilePath = await instagramCookieFilePromise;

  if (cookieFilePath) {
    args.push('--cookies', cookieFilePath);
  }

  return args;
}

async function resolveInstagramCookieFile() {
  const configuredPath = readEnvSetting(instagramCookiePathEnvKeys);

  if (configuredPath) {
    const resolvedPath = path.resolve(configuredPath.value);

    if (!(await pathExists(resolvedPath))) {
      throw new Error(`Instagram cookies path from ${configuredPath.key} was not found on the server.`);
    }

    return resolvedPath;
  }

  if (await pathExists(defaultInstagramCookieFilePath)) {
    return defaultInstagramCookieFilePath;
  }

  const encodedCookies = readEnvSetting(instagramBase64CookieEnvKeys);
  const inlineCookies = readEnvSetting(instagramInlineCookieEnvKeys);
  const source = encodedCookies || inlineCookies;

  if (!source) {
    return '';
  }

  const content = encodedCookies
    ? Buffer.from(source.value, 'base64').toString('utf8')
    : source.value;
  const normalized = normalizeCookieFileContent(content);

  if (!normalized) {
    throw new Error(`Instagram cookies from ${source.key} were empty.`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dx-instagram-cookies-'));
  const cookieFilePath = path.join(tempDir, 'instagram-cookies.txt');
  await fs.writeFile(cookieFilePath, normalized, 'utf8');

  return cookieFilePath;
}

function normalizeCookieFileContent(content) {
  const normalized = content.replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('#')) {
    return `${normalized}\n`;
  }

  return `# Netscape HTTP Cookie File\n${normalized}\n`;
}

function readEnvSetting(keys) {
  for (const key of keys) {
    const value = process.env[key];

    if (typeof value === 'string' && value.trim()) {
      return {
        key,
        value: value.trim(),
      };
    }
  }

  return null;
}

function isInstagramUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return false;
  }
}

async function logInstagramAccessMode() {
  try {
    const cookieFilePath = await instagramCookieFilePromise;

    if (cookieFilePath) {
      console.log('Instagram authenticated requests are enabled.');
      return;
    }

    console.warn('Instagram guest mode is enabled. Some reels may require server cookies.');
  } catch (error) {
    console.warn(
      `Instagram cookies could not be initialized: ${error instanceof Error ? error.message : 'Unknown error.'}`,
    );
  }
}

async function findDownloadedFile(tempDir) {
  const files = await fs.readdir(tempDir);
  const outputFile = files.find((file) => !file.endsWith('.part') && !file.endsWith('.ytdl'));

  if (!outputFile) {
    throw new Error('The file was prepared, but no output artifact was found.');
  }

  return path.join(tempDir, outputFile);
}

function buildDownloadName(filePath) {
  const parsed = path.parse(filePath);
  const cleanBase = sanitizeFilename(parsed.name).trim() || 'dx-download';
  const cleanExt = parsed.ext || '';

  return `${cleanBase}${cleanExt}`;
}

function buildContentDisposition(filename) {
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '').replace(/"/g, '');
  return `attachment; filename="${asciiName || 'dx-download'}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function detectPlatform(url, extractor) {
  const normalizedUrl = (url || '').toLowerCase();
  const normalizedExtractor = (extractor || '').toLowerCase();

  if (normalizedUrl.includes('instagram.com') || normalizedExtractor.includes('instagram')) {
    return 'Instagram';
  }

  return 'YouTube';
}

function formatUploadDate(value) {
  if (!value || typeof value !== 'string' || value.length !== 8) {
    return '';
  }

  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function cleanYtError(message, context = {}) {
  const normalizedMessage = message.toLowerCase();

  if (
    isInstagramUrl(context.url || '') &&
    (
      normalizedMessage.includes('login required') ||
      normalizedMessage.includes('rate-limit') ||
      normalizedMessage.includes('--cookies-from-browser') ||
      normalizedMessage.includes('--cookies') ||
      normalizedMessage.includes('requested content is not available')
    )
  ) {
    return context.authenticated
      ? 'Instagram rejected this reel even with the configured server session. Refresh the Instagram cookies on the server and try again.'
      : 'Instagram blocked guest access for this reel. Add valid Instagram cookies on the server and try again.';
  }

  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const usefulLine = lines.find((line) => line.toLowerCase().includes('error')) || lines.at(-1);

  return usefulLine || 'yt-dlp was unable to process that link.';
}

function resolvePreviewUrl(entry) {
  const preferredFormat = pickPreviewFormat(entry);

  if (preferredFormat?.url) {
    return preferredFormat.url;
  }

  if (typeof entry.url === 'string' && entry.url.startsWith('http')) {
    return entry.url;
  }

  return '';
}

function resolvePreviewMimeType(entry) {
  const preferredFormat = pickPreviewFormat(entry);
  const extension = preferredFormat?.ext || entry.ext;

  if (!extension) {
    return 'video/mp4';
  }

  if (extension === 'webm') {
    return 'video/webm';
  }

  if (extension === 'mov') {
    return 'video/quicktime';
  }

  return 'video/mp4';
}

function resolvePreviewWidth(entry) {
  const preferredFormat = pickPreviewFormat(entry);
  return preferredFormat?.width || entry.width || null;
}

function resolvePreviewHeight(entry) {
  const preferredFormat = pickPreviewFormat(entry);
  return preferredFormat?.height || entry.height || null;
}

function pickPreviewFormat(entry) {
  const candidates = [];

  if (Array.isArray(entry.requested_downloads)) {
    candidates.push(...entry.requested_downloads);
  }

  if (Array.isArray(entry.formats)) {
    candidates.push(...entry.formats);
  }

  if (!candidates.length) {
    return null;
  }

  const directVideoFormats = candidates.filter((format) => {
    if (!format || typeof format.url !== 'string' || !format.url.startsWith('http')) {
      return false;
    }

    const hasVideo = format.vcodec && format.vcodec !== 'none';
    const isPlayableContainer = format.ext === 'mp4' || format.ext === 'webm' || format.ext === 'mov';

    return hasVideo && isPlayableContainer;
  });

  if (!directVideoFormats.length) {
    return null;
  }

  const scored = directVideoFormats
    .map((format) => ({
      format,
      score: scorePreviewFormat(format),
    }))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.format || null;
}

function scorePreviewFormat(format) {
  let score = 0;

  if (format.ext === 'mp4') {
    score += 50;
  } else if (format.ext === 'webm') {
    score += 30;
  }

  if (format.acodec && format.acodec !== 'none') {
    score += 40;
  }

  const height = Number(format.height) || 0;

  if (height > 0) {
    const distanceFrom720 = Math.abs(720 - height);
    score += Math.max(0, 40 - Math.floor(distanceFrom720 / 24));
  }

  if (format.protocol === 'https') {
    score += 15;
  }

  if (Number(format.filesize_approx) > 0 && Number(format.filesize_approx) < 12 * 1024 * 1024) {
    score += 10;
  }

  return score;
}

function buildVideoOptions(entry) {
  const heights = collectVideoHeights(entry);

  if (!heights.length) {
    return [];
  }

  const maxHeight = heights[0];
  const midHeight = heights[Math.floor(heights.length / 2)];
  const lowHeight = heights[heights.length - 1];
  const options = [];

  options.push(createVideoOption('max', 'Max', maxHeight));

  if (midHeight !== maxHeight && midHeight !== lowHeight) {
    options.push(createVideoOption('mid', 'Mid', midHeight));
  }

  if (lowHeight !== maxHeight) {
    options.push(createVideoOption('low', 'Low', lowHeight));
  }

  return options;
}

function createVideoOption(key, label, height) {
  return {
    key,
    label,
    quality: String(height.qualityHeight),
    height: height.displayHeight,
    displayLabel: `${label} ${height.displayHeight}p`,
  };
}

function collectVideoHeights(entry) {
  const candidates = Array.isArray(entry.formats) ? entry.formats : [];
  const uniqueHeights = new Map();

  for (const format of candidates) {
    if (!format) {
      continue;
    }

    const hasVideo = format.vcodec && format.vcodec !== 'none';
    const qualityHeight = Number(format.height) || 0;

    if (!hasVideo || qualityHeight <= 0) {
      continue;
    }

    const width = Number(format.width) || qualityHeight;
    const displayHeight = Math.min(width, qualityHeight) || qualityHeight;
    const existing = uniqueHeights.get(displayHeight);

    if (!existing || qualityHeight > existing.qualityHeight) {
      uniqueHeights.set(displayHeight, {
        displayHeight,
        qualityHeight,
      });
    }
  }

  return [...uniqueHeights.values()].sort(
    (left, right) => right.displayHeight - left.displayHeight,
  );
}

function buildVideoFormatSelector(quality) {
  if (quality === 'best') {
    return 'bv*+ba/b';
  }

  const parsedHeight = Number.parseInt(quality, 10);

  if (!Number.isFinite(parsedHeight) || parsedHeight <= 0) {
    return 'bv*+ba/b';
  }

  return `bv*[height<=${parsedHeight}]+ba/b[height<=${parsedHeight}]/b[height<=${parsedHeight}]`;
}

function truncate(value, length) {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length).trim()}...`;
}

function resolveStatusCode(message) {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('valid url') ||
    normalized.includes('supported') ||
    normalized.includes('required') ||
    normalized.includes('does not look')
  ) {
    return 400;
  }

  if (normalized.includes('timed out')) {
    return 504;
  }

  if (normalized.includes('instagram blocked guest access')) {
    return 503;
  }

  return 500;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
