import { createServer } from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const root = resolve(import.meta.dirname, '..');
const distDir = resolve(root, 'dist');
const databasePath = resolve(process.env.DATABASE_PATH || resolve(root, 'data/heart-memories.sqlite'));
const maxPhotos = 999;
const maxImageBytes = 25 * 1024 * 1024;
const sessionTtl = 30 * 24 * 60 * 60;
const recoveryAttempts = new Map();
const secureCookie = process.env.COOKIE_SECURE === 'true' ||
  (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');

await mkdir(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
// ponytail: 单机家庭相册用 SQLite 即可；需要多实例写入或高并发时再迁移到 PostgreSQL。
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_salt BLOB NOT NULL,
    password_hash BLOB NOT NULL,
    photo_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    thumbnail TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    image BLOB NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((column) => column.name === 'first_meeting_date')) {
  db.exec('ALTER TABLE users ADD COLUMN first_meeting_date TEXT');
}
if (!userColumns.some((column) => column.name === 'person_one_name')) {
  db.exec("ALTER TABLE users ADD COLUMN person_one_name TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.some((column) => column.name === 'person_two_name')) {
  db.exec("ALTER TABLE users ADD COLUMN person_two_name TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.some((column) => column.name === 'phone_number')) {
  db.exec('ALTER TABLE users ADD COLUMN phone_number TEXT');
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_unique ON users(phone_number) WHERE phone_number IS NOT NULL AND phone_number <> ''");
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function readBody(request, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        request.off('data', onData);
        request.resume();
        reject(new HttpError(413, '单张照片不能超过 25 MB'));
      } else {
        chunks.push(chunk);
      }
    };
    request.on('data', onData);
    request.on('end', () => {
      if (!rejected) resolveBody(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

async function readJson(request, limit = 16 * 1024) {
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, '请求数据格式无效');
  }
}

function parseMultipart(contentType, body) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match?.[1] ?? match?.[2]?.trim();
  if (!boundary || boundary.length > 200) throw new HttpError(400, '上传数据格式无效');

  const marker = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  const fields = new Map();
  let cursor = body.indexOf(marker);
  if (cursor !== 0) throw new HttpError(400, '上传数据格式无效');

  while (cursor >= 0) {
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString() === '--') break;
    if (body.subarray(cursor, cursor + 2).toString() !== '\r\n') throw new HttpError(400, '上传数据格式无效');
    cursor += 2;
    const headerEnd = body.indexOf(separator, cursor);
    const nextPart = body.indexOf(delimiter, headerEnd + separator.length);
    if (headerEnd < 0 || nextPart < 0) throw new HttpError(400, '上传数据格式无效');
    const headers = body.toString('latin1', cursor, headerEnd);
    const fieldName = headers.match(/content-disposition:[^\r\n]*\bname="([^"]+)"/i)?.[1];
    if (!fieldName) throw new HttpError(400, '上传数据格式无效');
    fields.set(fieldName, body.subarray(headerEnd + separator.length, nextPart));
    cursor = nextPart + 2;
  }
  return fields;
}

function fieldText(fields, name) {
  return fields.get(name)?.toString('utf8') ?? '';
}

function detectImageMime(image) {
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return 'image/jpeg';
  if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(response, token) {
  response.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionTtl}${secureCookie ? '; Secure' : ''}`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', `session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`);
}

function getCookie(request, name) {
  return (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

function getSessionUser(request) {
  const token = getCookie(request, 'session');
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  return db.prepare(`
    SELECT users.id, users.username, sessions.token_hash
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), Date.now()) ?? null;
}

function requireUser(request) {
  const user = getSessionUser(request);
  if (!user) throw new HttpError(401, '请先登录');
  return user;
}

async function createSession(response, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, Date.now() + sessionTtl * 1000);
  setSessionCookie(response, token);
}

async function passwordDigest(password, salt) {
  return scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function normalizeUsername(value) {
  if (typeof value !== 'string') throw new HttpError(400, '请输入账号');
  const username = value.normalize('NFKC').trim();
  const length = Array.from(username).length;
  if (length < 3 || length > 64 || !/^[\p{L}\p{N}._@+-]+$/u.test(username)) {
    throw new HttpError(400, '账号需为 3 至 64 位字母、数字或 . _ @ + -');
  }
  return { username, key: username.toLowerCase() };
}

function normalizePhone(value) {
  if (typeof value !== 'string') throw new HttpError(400, '请输入手机号');
  const phone = value.replace(/[\s()-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(phone)) throw new HttpError(400, '手机号格式无效');
  return phone.replace(/^\+/, '');
}

function maskPhone(phone) {
  if (!phone) return null;
  const start = Math.max(1, Math.floor((phone.length - 5) / 2));
  return phone.slice(0, start) + '*****' + phone.slice(start + 5);
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw new HttpError(400, '姓名格式无效');
  const name = value.normalize('NFC').trim();
  if (Array.from(name).length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, '姓名最多 40 个字符');
  }
  return name;
}

function limitRecoveryAttempts(request, username, action, maximum) {
  const now = Date.now();
  const key = action + ':' + (request.socket.remoteAddress ?? 'unknown') + ':' + username;
  const attempt = recoveryAttempts.get(key);
  if (attempt && attempt.expiresAt > now && attempt.count >= maximum) {
    throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
  }
  if (!attempt || attempt.expiresAt <= now) {
    recoveryAttempts.set(key, { count: 1, expiresAt: now + 15 * 60 * 1000 });
  } else {
    attempt.count += 1;
  }
  if (recoveryAttempts.size > 1000) {
    for (const [attemptKey, value] of recoveryAttempts) {
      if (value.expiresAt <= now) recoveryAttempts.delete(attemptKey);
    }
  }
}

function validatePassword(value, registration = false) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024) {
    throw new HttpError(400, '密码格式无效');
  }
  const length = Array.from(value).length;
  if (registration && length < 8) throw new HttpError(400, '密码至少需要 8 位');
  if (registration && length > 128) throw new HttpError(400, '密码不能超过 128 位');
  if (!value) throw new HttpError(400, '请输入密码');
  return value;
}

async function handleApi(request, response, url) {
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/auth/me') {
    const user = getSessionUser(request);
    return sendJson(response, 200, { user: user ? { id: user.id, username: user.username } : null });
  }

  if (request.method === 'POST' && pathname === '/api/auth/recovery-info') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const { key } = normalizeUsername(input.username);
    limitRecoveryAttempts(request, key, 'lookup', 10);
    const account = db.prepare('SELECT phone_number FROM users WHERE username_key = ?').get(key);
    if (!account?.phone_number) throw new HttpError(404, '账号未绑定手机号，无法通过手机号找回');
    return sendJson(response, 200, { phoneMasked: maskPhone(account.phone_number) });
  }

  if (request.method === 'POST' && pathname === '/api/auth/reset-password') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const { key } = normalizeUsername(input.username);
    const phone = normalizePhone(input.phone);
    const password = validatePassword(input.password, true);
    limitRecoveryAttempts(request, key, 'reset', 5);
    const account = db.prepare('SELECT id, phone_number FROM users WHERE username_key = ?').get(key);
    if (!account || account.phone_number !== phone) throw new HttpError(401, '账号或手机号不匹配');
    const salt = randomBytes(16);
    const passwordHash = await passwordDigest(password, salt);
    db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
      .run(salt, passwordHash, account.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(account.id);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const { username, key } = normalizeUsername(input.username);
    const password = validatePassword(input.password, pathname.endsWith('/register'));

    if (pathname.endsWith('/register')) {
      const phone = normalizePhone(input.phone);
      if (db.prepare('SELECT 1 FROM users WHERE username_key = ?').get(key)) {
        throw new HttpError(409, '这个账号已经注册');
      }
      if (db.prepare('SELECT 1 FROM users WHERE phone_number = ?').get(phone)) {
        throw new HttpError(409, '这个手机号已经绑定其他账号');
      }
      const id = randomUUID();
      const salt = randomBytes(16);
      const passwordHash = await passwordDigest(password, salt);
      try {
        db.prepare('INSERT INTO users (id, username, username_key, password_salt, password_hash, phone_number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, username, key, salt, passwordHash, phone, Date.now());
      } catch (error) {
        if (String(error).includes('UNIQUE')) throw new HttpError(409, '账号或手机号已经注册');
        throw error;
      }
      await createSession(response, id);
      return sendJson(response, 201, { user: { id, username } });
    }

    const user = db.prepare('SELECT id, username, password_salt, password_hash FROM users WHERE username_key = ?').get(key);
    const salt = user ? Buffer.from(user.password_salt) : Buffer.alloc(16);
    const actual = Buffer.from(await passwordDigest(password, salt));
    const expected = user ? Buffer.from(user.password_hash) : Buffer.alloc(64);
    if (!user || !timingSafeEqual(actual, expected)) throw new HttpError(401, '账号或密码错误');
    await createSession(response, user.id);
    return sendJson(response, 200, { user: { id: user.id, username: user.username } });
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const token = getCookie(request, 'session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    clearSessionCookie(response);
    return sendJson(response, 200, { ok: true });
  }

  const user = requireUser(request);
  if (request.method === 'PATCH' && pathname === '/api/auth/password') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const currentPassword = validatePassword(input.currentPassword);
    const nextPassword = validatePassword(input.newPassword, true);
    const account = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(user.id);
    const actual = Buffer.from(await passwordDigest(currentPassword, Buffer.from(account.password_salt)));
    if (!timingSafeEqual(actual, Buffer.from(account.password_hash))) throw new HttpError(401, '当前密码不正确');
    const salt = randomBytes(16);
    const passwordHash = await passwordDigest(nextPassword, salt);
    db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
      .run(salt, passwordHash, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, user.token_hash);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'PATCH' && pathname === '/api/account-settings/phone') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const phone = normalizePhone(input.phone);
    const currentPassword = validatePassword(input.currentPassword);
    const account = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(user.id);
    const actual = Buffer.from(await passwordDigest(currentPassword, Buffer.from(account.password_salt)));
    if (!timingSafeEqual(actual, Buffer.from(account.password_hash))) throw new HttpError(401, '当前密码不正确');
    try {
      db.prepare('UPDATE users SET phone_number = ? WHERE id = ?').run(phone, user.id);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new HttpError(409, '这个手机号已经绑定其他账号');
      throw error;
    }
    return sendJson(response, 200, { phoneMasked: maskPhone(phone) });
  }

  if (request.method === 'GET' && pathname === '/api/account-settings') {
    const settings = db.prepare('SELECT first_meeting_date AS firstMeetingDate, person_one_name AS personOneName, person_two_name AS personTwoName, phone_number AS phoneNumber FROM users WHERE id = ?').get(user.id);
    return sendJson(response, 200, {
      firstMeetingDate: settings.firstMeetingDate,
      personOneName: settings.personOneName,
      personTwoName: settings.personTwoName,
      phoneMasked: maskPhone(settings.phoneNumber),
    });
  }

  if (request.method === 'PATCH' && pathname === '/api/account-settings') {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求数据格式无效');
    const current = db.prepare('SELECT first_meeting_date AS firstMeetingDate, person_one_name AS personOneName, person_two_name AS personTwoName FROM users WHERE id = ?').get(user.id);
    const dateInput = Object.hasOwn(input, 'firstMeetingDate') ? input.firstMeetingDate : current.firstMeetingDate;
    const firstMeetingDate = dateInput === '' ? null : dateInput;
    const personOneName = Object.hasOwn(input, 'personOneName') ? normalizeDisplayName(input.personOneName) : current.personOneName;
    const personTwoName = Object.hasOwn(input, 'personTwoName') ? normalizeDisplayName(input.personTwoName) : current.personTwoName;
    if (firstMeetingDate !== null) {
      if (typeof firstMeetingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(firstMeetingDate)) {
        throw new HttpError(400, '相识日期格式无效');
      }
      const [year, month, day] = firstMeetingDate.split('-').map(Number);
      const parsedDate = new Date(Date.UTC(year, month - 1, day));
      if (year < 1000 || parsedDate.getUTCFullYear() !== year || parsedDate.getUTCMonth() !== month - 1 || parsedDate.getUTCDate() !== day) {
        throw new HttpError(400, '相识日期无效');
      }
    }
    db.prepare('UPDATE users SET first_meeting_date = ?, person_one_name = ?, person_two_name = ? WHERE id = ?')
      .run(firstMeetingDate, personOneName, personTwoName, user.id);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/photos') {
    const revision = db.prepare('SELECT photo_revision FROM users WHERE id = ?').get(user.id).photo_revision;
    const etag = `"${user.id}-${revision}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304);
      return response.end();
    }
    const photos = db.prepare(`
      SELECT id, name, width, height, thumbnail, size, created_at AS createdAt
      FROM photos WHERE user_id = ? ORDER BY created_at, rowid
    `).all(user.id).map((photo) => ({
      ...photo,
      aspectRatio: photo.width / photo.height,
      dataUrl: `/api/photos/${encodeURIComponent(photo.id)}/image`,
    }));
    return sendJson(response, 200, { photos, revision }, { ETag: etag });
  }

  if (request.method === 'POST' && pathname === '/api/photos') {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new HttpError(415, '上传数据格式无效');
    const fields = parseMultipart(contentType, await readBody(request, maxImageBytes + 1024 * 1024));
    const image = fields.get('image');
    const mimeType = image && detectImageMime(image);
    if (!image?.length || !mimeType) throw new HttpError(400, '仅支持有效的 JPG、PNG 或 WebP 图片');

    const id = fieldText(fields, 'id');
    const name = fieldText(fields, 'name').normalize('NFC').slice(0, 255);
    const width = Number(fieldText(fields, 'width'));
    const height = Number(fieldText(fields, 'height'));
    const createdAt = Number(fieldText(fields, 'createdAt'));
    const thumbnail = fieldText(fields, 'thumbnail');
    if (!id || id.length > 100 || !name || name.includes('\0')) throw new HttpError(400, '照片信息无效');
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 100_000_000) {
      throw new HttpError(400, '照片尺寸无效');
    }
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new HttpError(400, '照片时间无效');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(thumbnail) || thumbnail.length > 512 * 1024) {
      throw new HttpError(400, '照片缩略图无效');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const count = db.prepare('SELECT COUNT(*) AS count FROM photos WHERE user_id = ?').get(user.id).count;
      if (count >= maxPhotos) throw new HttpError(409, `相册最多保存 ${maxPhotos} 张照片`);
      db.prepare(`
        INSERT INTO photos (user_id, id, name, width, height, thumbnail, mime_type, image, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, id, name, width, height, thumbnail, mimeType, image, image.length, createdAt);
      db.prepare('UPDATE users SET photo_revision = photo_revision + 1 WHERE id = ?').run(user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error).includes('UNIQUE')) throw new HttpError(409, '这张照片已经存在');
      throw error;
    }
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === 'DELETE' && pathname === '/api/photos') {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('DELETE FROM photos WHERE user_id = ?').run(user.id);
      if (result.changes > 0) db.prepare('UPDATE users SET photo_revision = photo_revision + 1 WHERE id = ?').run(user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return sendJson(response, 200, { ok: true });
  }

  const imageMatch = pathname.match(/^\/api\/photos\/([^/]+)\/image$/);
  if (request.method === 'GET' && imageMatch) {
    let id;
    try { id = decodeURIComponent(imageMatch[1]); } catch { throw new HttpError(400, '照片编号无效'); }
    const photo = db.prepare('SELECT mime_type, image FROM photos WHERE user_id = ? AND id = ?').get(user.id, id);
    if (!photo) throw new HttpError(404, '没有找到这张照片');
    const image = Buffer.from(photo.image);
    response.writeHead(200, {
      'Content-Type': photo.mime_type,
      'Content-Length': image.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return response.end(image);
  }

  const photoMatch = pathname.match(/^\/api\/photos\/([^/]+)$/);
  if (request.method === 'DELETE' && photoMatch) {
    let id;
    try { id = decodeURIComponent(photoMatch[1]); } catch { throw new HttpError(400, '照片编号无效'); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('DELETE FROM photos WHERE user_id = ? AND id = ?').run(user.id, id);
      if (result.changes === 0) throw new HttpError(404, '没有找到这张照片');
      db.prepare('UPDATE users SET photo_revision = photo_revision + 1 WHERE id = ?').run(user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return sendJson(response, 200, { ok: true });
  }

  throw new HttpError(404, '没有找到这个接口');
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, '不支持这个请求方法');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, '页面路径无效'); }
  let filePath = resolve(distDir, `.${decoded}`);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${sep}`)) throw new HttpError(404, '没有找到页面');
  try {
    if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html');
    await stat(filePath);
  } catch {
    filePath = resolve(distDir, 'index.html');
  }
  let body;
  try { body = await readFile(filePath); } catch { throw new HttpError(503, '网页尚未构建，请先运行 npm run build'); }
  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await serveStatic(request, response, url.pathname);
  } catch (error) {
    if (response.headersSent) return response.destroy();
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(response, status, { error: error instanceof HttpError ? error.message : '服务器暂时无法处理请求' });
  }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => console.log(`Heart Memories 已启动：http://${host}:${port}`));
