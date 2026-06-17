// BritThump — server.js
// Zero npm dependencies — uses only Node's built-in modules (Node 18+ for global fetch).
// Posts are stored in a Supabase Postgres table; images in Supabase Storage.
// This keeps the app itself free to host (no disk needed) while still being
// a single, simple file.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Set these in your hosting environment's variables.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SUPABASE_URL = process.env.SUPABASE_URL || ''; // e.g. https://abcxyz.supabase.co
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || ''; // service_role / sb_secret key — server-side only, never sent to the browser
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'article-images';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.warn('WARNING: SUPABASE_URL and/or SUPABASE_SECRET_KEY are not set. The site will not be able to read or save posts until these are configured.');
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    ...extra,
  };
}

// --- Helpers ---

// --- Storage layer: Supabase Postgres table "posts" via the auto-generated REST API ---
// Table schema (see README for the exact SQL to run once in the Supabase SQL editor):
//   id text primary key, slug text unique, title text, kicker text, dek text,
//   author text, body text, header_image text, mid_image text, created_at timestamptz

async function readPosts() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?select=*&order=created_at.desc`, {
      headers: supabaseHeaders(),
    });
    if (!res.ok) {
      console.error('readPosts failed:', res.status, await res.text());
      return [];
    }
    const rows = await res.json();
    return rows.map(rowToPost);
  } catch (e) {
    console.error('readPosts error:', e);
    return [];
  }
}

function rowToPost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kicker: row.kicker,
    dek: row.dek,
    author: row.author,
    body: row.body,
    headerImage: row.header_image,
    midImage: row.mid_image,
    createdAt: row.created_at,
  };
}

function postToRow(post) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    kicker: post.kicker,
    dek: post.dek,
    author: post.author,
    body: post.body,
    header_image: post.headerImage,
    mid_image: post.midImage,
    created_at: post.createdAt,
  };
}

async function insertPost(post) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(postToRow(post)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to save post: ${res.status} ${text}`);
  }
}

async function deletePostById(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to delete post: ${res.status} ${text}`);
  }
}

async function findPostById(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rowToPost(rows[0]) : null;
}

async function updatePost(id, updates) {
  const row = postToRow(updates);
  delete row.id; // never change the primary key on update
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update post: ${res.status} ${text}`);
  }
}

async function findPostBySlug(slug) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?slug=eq.${encodeURIComponent(slug)}&select=*`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rowToPost(rows[0]) : null;
}

async function slugExists(slug) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?slug=eq.${encodeURIComponent(slug)}&select=slug`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'post';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Convert plain text (paragraphs separated by blank lines) into safe <p> tags.
function textToParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendNotFound(res) {
  sendHtml(res, 404, renderLayout('Not found', `
    <div class="wrap">
      <p class="kicker">404 — DISPATCH LOST IN TRANSIT</p>
      <h1>This story didn't make the print run.</h1>
      <p><a href="/">Back to the front page</a></p>
    </div>
  `, { ogDescription: "This story didn't make the print run." }));
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendNotFound(res);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// --- Cookie-based admin auth (simple, single-password) ---

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

const SESSION_SECRET = crypto.randomBytes(32).toString('hex'); // regenerated each server start
function makeSessionToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('admin-session').digest('hex');
}
const VALID_SESSION_TOKEN = makeSessionToken();

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid leaking length via timing.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return !!cookies.session && safeCompare(cookies.session, VALID_SESSION_TOKEN);
}

// --- Multipart form parsing (for image uploads), no dependencies ---

function parseMultipart(req, callback) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!match) return callback(new Error('No boundary found'), null);
  const boundary = '--' + (match[1] || match[2]);

  const MAX_BYTES = 15 * 1024 * 1024; // 15MB total request cap (two images + text, comfortable for phone photos)
  let totalBytes = 0;
  let tooLarge = false;

  const chunks = [];
  req.on('data', chunk => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BYTES) {
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return callback(new Error('Upload too large (15MB limit)'), null);
    try {
      const buffer = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(boundary);
      const parts = [];
      let start = buffer.indexOf(boundaryBuf);
      while (start !== -1) {
        const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
        if (next === -1) break;
        const partBuf = buffer.slice(start + boundaryBuf.length, next);
        parts.push(partBuf);
        start = next;
      }

      const fields = {};
      const files = {};

      for (let part of parts) {
        // Strip leading CRLF and trailing CRLF
        if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
        if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
        if (part.length === 0) continue;
        if (part.toString() === '--' || part.toString().startsWith('--')) continue;

        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headerStr = part.slice(0, headerEnd).toString('utf8');
        const body = part.slice(headerEnd + 4);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]*)"/);
        const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

        if (!nameMatch) continue;
        const fieldName = nameMatch[1];

        if (filenameMatch && filenameMatch[1]) {
          files[fieldName] = {
            filename: filenameMatch[1],
            contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
            data: body,
          };
        } else if (filenameMatch && !filenameMatch[1]) {
          // Empty file input, skip
        } else {
          fields[fieldName] = body.toString('utf8');
        }
      }

      callback(null, { fields, files });
    } catch (e) {
      callback(e, null);
    }
  });
  req.on('error', err => callback(err, null));
}

async function saveUploadedFile(file) {
  if (!file || !file.data || file.data.length === 0) return null;
  const ext = path.extname(file.filename) || guessExtFromMime(file.contentType);
  const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext.toLowerCase()) ? ext.toLowerCase() : '.jpg';
  const id = crypto.randomBytes(8).toString('hex');
  const outName = `${id}${safeExt}`;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${outName}`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': file.contentType || 'application/octet-stream' }),
    body: file.data,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Image upload failed: ${res.status} ${text}`);
  }

  // Public bucket convention — see Supabase Storage docs for "Serving assets".
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${outName}`;
}

function guessExtFromMime(mime) {
  if (!mime) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

function parseBodyUrlEncoded(req, callback) {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    const params = new url.URLSearchParams(body);
    const fields = {};
    for (const [k, v] of params) fields[k] = v;
    callback(null, { fields, files: {} });
  });
}

// --- Templates ---

const SITE_URL = process.env.SITE_URL || 'https://britthump.onrender.com';
const DEFAULT_OG_DESCRIPTION = 'The Truthiest News Around.';
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-default.png`;

function renderLayout(title, bodyHtml, options = {}) {
  const {
    extraHead = '',
    ogDescription = DEFAULT_OG_DESCRIPTION,
    ogImage = DEFAULT_OG_IMAGE,
    ogUrl = SITE_URL,
    ogType = 'website',
  } = options;

  const fullTitle = `${escapeHtml(title)} — BritThump`;
  const safeDescription = escapeHtml(ogDescription);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${fullTitle}</title>
<meta name="description" content="${safeDescription}">

<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${safeDescription}">
<meta property="og:image" content="${ogImage}">
<meta property="og:url" content="${ogUrl}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="BritThump">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${safeDescription}">
<meta name="twitter:image" content="${ogImage}">

<link rel="stylesheet" href="/style.css">
${extraHead}
</head>
<body>
<header class="masthead">
  <div class="wrap masthead-inner">
    <div class="masthead-strip">
      <span>${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}</span>
      <span class="masthead-divider">·</span>
      <span>UNITED KINGDOM</span>
    </div>
    <a href="/" class="masthead-title"><img src="/logo.png" alt="BritThump" class="masthead-logo"></a>
    <div class="masthead-tagline">The Truthiest News Around</div>
  </div>
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>BritThump publishes the stories that matter then sorts of plays around with them a bit. Unflinching journalism that follows your down the street and smacks you over the head with an air fryer filled with crisps. Your rancid, shameful window to the world.</p>
    <p><a href="/admin">Admin</a></p>
  </div>
</footer>
</body>
</html>`;
}

function renderHomepage(posts) {
  if (posts.length === 0) {
    return renderLayout('Home', `
      <div class="wrap empty-state">
        <p class="kicker">A QUIET DAY IN THE NEWSROOM</p>
        <h1>Nothing's been filed yet.</h1>
        <p>Once a story is published, it'll appear here for the nation to misread as fact.</p>
      </div>
    `);
  }

  const [lead, ...rest] = posts;

  const leadHtml = `
    <article class="lead-story">
      <a href="/article/${lead.slug}" class="lead-link">
        ${lead.headerImage ? `<img class="lead-image" src="${lead.headerImage}" alt="">` : ''}
        <p class="kicker">${escapeHtml(lead.kicker || 'TOP STORY')}</p>
        <h1 class="lead-headline">${escapeHtml(lead.title)}</h1>
        <p class="byline">By ${escapeHtml(lead.author || 'Staff Reporter')} · ${formatDate(lead.createdAt)}</p>
        <p class="lead-dek">${escapeHtml(lead.dek || '')}</p>
      </a>
    </article>
  `;

  const gridHtml = rest.map(post => `
    <article class="grid-story">
      <a href="/article/${post.slug}" class="grid-link">
        ${post.headerImage ? `<img class="grid-image" src="${post.headerImage}" alt="">` : ''}
        <p class="kicker">${escapeHtml(post.kicker || 'IN THE NEWS')}</p>
        <h2 class="grid-headline">${escapeHtml(post.title)}</h2>
        <p class="byline">By ${escapeHtml(post.author || 'Staff Reporter')} · ${formatDate(post.createdAt)}</p>
      </a>
    </article>
  `).join('\n');

  return renderLayout('Home', `
    <div class="wrap">
      ${leadHtml}
      <hr class="rule">
      <div class="story-grid">
        ${gridHtml}
      </div>
    </div>
  `, { ogImage: `${SITE_URL}/og-default.png` });
}

function renderArticle(post) {
  if (!post) return null;
  const paragraphs = textToParagraphs(post.body || '');
  // Match each whole <p>...</p> block so we never cut a tag in half.
  const paraArr = paragraphs.match(/<p>[\s\S]*?<\/p>/g) || [paragraphs];
  let bodyWithMidImage = paragraphs;

  if (post.midImage && paraArr.length > 1) {
    const splitPoint = Math.ceil(paraArr.length / 2);
    const before = paraArr.slice(0, splitPoint).join('\n');
    const after = paraArr.slice(splitPoint).join('\n');
    bodyWithMidImage = `${before}\n<figure class="mid-image"><img src="${post.midImage}" alt=""></figure>\n${after}`;
  } else if (post.midImage) {
    bodyWithMidImage = `${paragraphs}\n<figure class="mid-image"><img src="${post.midImage}" alt=""></figure>`;
  }

  return renderLayout(post.title, `
    <article class="wrap article-page">
      <p class="kicker">${escapeHtml(post.kicker || 'TOP STORY')}</p>
      <h1 class="article-headline">${escapeHtml(post.title)}</h1>
      <p class="article-dek">${escapeHtml(post.dek || '')}</p>
      <p class="byline">By ${escapeHtml(post.author || 'Staff Reporter')} · ${formatDate(post.createdAt)}</p>
      ${post.headerImage ? `<img class="article-header-image" src="${post.headerImage}" alt="">` : ''}
      <div class="article-body">
        ${bodyWithMidImage}
      </div>
      <hr class="rule">
      <p><a href="/">&larr; Back to the front page</a></p>
    </article>
  `, {
    ogDescription: post.dek || DEFAULT_OG_DESCRIPTION,
    ogImage: post.headerImage || DEFAULT_OG_IMAGE,
    ogUrl: `${SITE_URL}/article/${post.slug}`,
    ogType: 'article',
  });
}

function renderLogin(error) {
  return renderLayout('Admin login', `
    <div class="wrap admin-wrap">
      <p class="kicker">STAFF ONLY</p>
      <h1>Admin login</h1>
      ${error ? `<p class="error-msg">${escapeHtml(error)}</p>` : ''}
      <form method="POST" action="/admin/login" class="admin-form">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus required>
        <button type="submit" class="btn-primary">Log in</button>
      </form>
    </div>
  `);
}

function renderAdmin(posts, message, errorMessage) {
  const postRows = posts.map(post => `
    <li class="admin-post-row">
      <a href="/article/${post.slug}" target="_blank" class="admin-post-title">${escapeHtml(post.title)}</a>
      <span class="admin-post-date">${formatDate(post.createdAt)}</span>
      <a href="/admin/edit/${post.id}" class="btn-edit">Edit</a>
      <form method="POST" action="/admin/delete/${post.id}" class="inline-form" onsubmit="return confirm('Delete this story for good?');">
        <button type="submit" class="btn-delete">Delete</button>
      </form>
    </li>
  `).join('\n');

  return renderLayout('Admin', `
    <div class="wrap admin-wrap">
      <p class="kicker">STAFF ONLY</p>
      <h1>Publish a new story</h1>
      ${message ? `<p class="success-msg">${escapeHtml(message)}</p>` : ''}
      ${errorMessage ? `<p class="error-msg">${escapeHtml(errorMessage)}</p>` : ''}

      <form method="POST" action="/admin/publish" enctype="multipart/form-data" class="admin-form">
        <label for="title">Headline</label>
        <input type="text" id="title" name="title" required placeholder="e.g. Westminster Confirms It Has No Idea Either">

        <label for="kicker">Kicker (small tag above headline, optional)</label>
        <input type="text" id="kicker" name="kicker" placeholder="e.g. EXCLUSIVE / WESTMINSTER / BREAKING">

        <label for="dek">Sub-headline (one line, optional)</label>
        <input type="text" id="dek" name="dek" placeholder="A short line that sets up the joke">

        <label for="author">Byline (optional)</label>
        <input type="text" id="author" name="author" placeholder="Staff Reporter">

        <label for="body">Story text</label>
        <textarea id="body" name="body" rows="14" required placeholder="Paste your Freewrite text here. Leave a blank line between paragraphs."></textarea>

        <label for="headerImage">Header image (optional)</label>
        <input type="file" id="headerImage" name="headerImage" accept="image/*">

        <label for="midImage">Mid-article image (optional)</label>
        <input type="file" id="midImage" name="midImage" accept="image/*">

        <button type="submit" class="btn-primary btn-large">Publish</button>
      </form>

      <hr class="rule">

      <h2>Published stories</h2>
      ${posts.length === 0 ? '<p>Nothing published yet.</p>' : `<ul class="admin-post-list">${postRows}</ul>`}

      <p><a href="/admin/logout">Log out</a></p>
    </div>
  `);
}

function renderEditForm(post, errorMessage) {
  return renderLayout('Edit story', `
    <div class="wrap admin-wrap">
      <p class="kicker">STAFF ONLY</p>
      <h1>Edit story</h1>
      ${errorMessage ? `<p class="error-msg">${escapeHtml(errorMessage)}</p>` : ''}

      <form method="POST" action="/admin/edit/${post.id}" enctype="multipart/form-data" class="admin-form">
        <label for="title">Headline</label>
        <input type="text" id="title" name="title" required value="${escapeHtml(post.title)}">

        <label for="kicker">Kicker (small tag above headline, optional)</label>
        <input type="text" id="kicker" name="kicker" value="${escapeHtml(post.kicker || '')}">

        <label for="dek">Sub-headline (one line, optional)</label>
        <input type="text" id="dek" name="dek" value="${escapeHtml(post.dek || '')}">

        <label for="author">Byline (optional)</label>
        <input type="text" id="author" name="author" value="${escapeHtml(post.author || '')}">

        <label for="body">Story text</label>
        <textarea id="body" name="body" rows="14" required>${escapeHtml(post.body)}</textarea>

        <label for="headerImage">Header image</label>
        ${post.headerImage ? `<p class="current-image-note">Current: <a href="${post.headerImage}" target="_blank">view image</a>. Choose a new file below to replace it, or leave blank to keep it.</p>` : ''}
        <input type="file" id="headerImage" name="headerImage" accept="image/*">

        <label for="midImage">Mid-article image</label>
        ${post.midImage ? `<p class="current-image-note">Current: <a href="${post.midImage}" target="_blank">view image</a>. Choose a new file below to replace it, or leave blank to keep it.</p>` : ''}
        <input type="file" id="midImage" name="midImage" accept="image/*">

        <button type="submit" class="btn-primary btn-large">Save changes</button>
      </form>

      <hr class="rule">

      <p><a href="/admin">&larr; Back without saving</a></p>
    </div>
  `);
}

// --- Route handlers ---

async function handlePublish(req, res) {
  parseMultipart(req, async (err, result) => {
    if (err) {
      const message = err.message.includes('too large')
        ? 'That upload was too large. Each photo should be under about 15MB combined — try a smaller image.'
        : 'Something went wrong reading the form. Please try again.';
      return sendHtml(res, 400, renderAdmin(await readPosts(), null, message));
    }
    const { fields, files } = result;
    const title = (fields.title || '').trim();
    const body = (fields.body || '').trim();

    if (!title || !body) {
      return sendHtml(res, 400, renderAdmin(await readPosts(), null, 'Headline and story text are both required.'));
    }

    try {
      const headerImage = files.headerImage ? await saveUploadedFile(files.headerImage) : null;
      const midImage = files.midImage ? await saveUploadedFile(files.midImage) : null;

      const baseSlug = slugify(title);
      let slug = baseSlug;
      let counter = 2;
      while (await slugExists(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      const newPost = {
        id: crypto.randomBytes(6).toString('hex'),
        slug,
        title,
        kicker: (fields.kicker || '').trim(),
        dek: (fields.dek || '').trim(),
        author: (fields.author || '').trim() || 'Staff Reporter',
        body,
        headerImage,
        midImage,
        createdAt: new Date().toISOString(),
      };

      await insertPost(newPost);
      const posts = await readPosts();
      sendHtml(res, 200, renderAdmin(posts, `Published: "${title}"`));
    } catch (e) {
      console.error('Publish failed:', e);
      const posts = await readPosts();
      sendHtml(res, 500, renderAdmin(posts, null, 'Publishing failed — there may be a connection problem with storage. Your story was not saved; please try again in a moment.'));
    }
  });
}

async function handleEditSubmit(req, res, id) {
  parseMultipart(req, async (err, result) => {
    if (err) {
      const message = err.message.includes('too large')
        ? 'That upload was too large. Each photo should be under about 15MB combined — try a smaller image.'
        : 'Something went wrong reading the form. Please try again.';
      const existing = await findPostById(id);
      if (!existing) return sendNotFound(res);
      return sendHtml(res, 400, renderEditForm(existing, message));
    }

    const existing = await findPostById(id);
    if (!existing) return sendNotFound(res);

    const { fields, files } = result;
    const title = (fields.title || '').trim();
    const body = (fields.body || '').trim();

    if (!title || !body) {
      return sendHtml(res, 400, renderEditForm(existing, 'Headline and story text are both required.'));
    }

    try {
      // Only replace an image if a new file was actually chosen; otherwise keep the existing one.
      const headerImage = (files.headerImage && files.headerImage.data.length > 0)
        ? await saveUploadedFile(files.headerImage)
        : existing.headerImage;
      const midImage = (files.midImage && files.midImage.data.length > 0)
        ? await saveUploadedFile(files.midImage)
        : existing.midImage;

      const updated = {
        ...existing,
        title,
        kicker: (fields.kicker || '').trim(),
        dek: (fields.dek || '').trim(),
        author: (fields.author || '').trim() || 'Staff Reporter',
        body,
        headerImage,
        midImage,
        // slug and createdAt deliberately unchanged, so existing links and publish order both stay stable
      };

      await updatePost(id, updated);
      const posts = await readPosts();
      sendHtml(res, 200, renderAdmin(posts, `Updated: "${title}"`));
    } catch (e) {
      console.error('Edit failed:', e);
      sendHtml(res, 500, renderEditForm(existing, 'Saving failed — there may be a connection problem with storage. Please try again in a moment.'));
    }
  });
}

async function handleDelete(req, res, id) {
  try {
    await deletePostById(id);
  } catch (e) {
    console.error('Delete failed:', e);
  }
  res.writeHead(302, { Location: '/admin' });
  res.end();
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    // Static assets
    if (pathname === '/style.css') {
      return serveStaticFile(res, path.join(ROOT, 'style.css'), 'text/css');
    }

    if (pathname === '/og-default.png') {
      return serveStaticFile(res, path.join(ROOT, 'og-default.png'), 'image/png');
    }

    if (pathname === '/logo.png') {
      return serveStaticFile(res, path.join(ROOT, 'logo.png'), 'image/png');
    }

    // Public homepage
    if (pathname === '/' && req.method === 'GET') {
      const posts = await readPosts();
      return sendHtml(res, 200, renderHomepage(posts));
    }

    // Article page
    if (pathname.startsWith('/article/') && req.method === 'GET') {
      const slug = pathname.replace('/article/', '');
      const post = await findPostBySlug(slug);
      if (!post) return sendNotFound(res);
      return sendHtml(res, 200, renderArticle(post));
    }

    // Admin login page
    if (pathname === '/admin/login' && req.method === 'GET') {
      return sendHtml(res, 200, renderLogin(null));
    }

    if (pathname === '/admin/login' && req.method === 'POST') {
      return parseBodyUrlEncoded(req, (err, result) => {
        const { fields } = result;
        if (safeCompare(fields.password || '', ADMIN_PASSWORD)) {
          res.writeHead(302, {
            Location: '/admin',
            'Set-Cookie': `session=${VALID_SESSION_TOKEN}; HttpOnly; Path=/; Max-Age=2592000`,
          });
          return res.end();
        }
        return sendHtml(res, 401, renderLogin('Incorrect password.'));
      });
    }

    if (pathname === '/admin/logout') {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
      });
      return res.end();
    }

    // Everything else under /admin requires auth
    if (pathname.startsWith('/admin')) {
      if (!isAuthed(req)) {
        res.writeHead(302, { Location: '/admin/login' });
        return res.end();
      }

      if (pathname === '/admin' && req.method === 'GET') {
        const posts = await readPosts();
        return sendHtml(res, 200, renderAdmin(posts, null));
      }

      if (pathname === '/admin/publish' && req.method === 'POST') {
        return handlePublish(req, res);
      }

      if (pathname.startsWith('/admin/edit/') && req.method === 'GET') {
        const id = pathname.replace('/admin/edit/', '');
        const post = await findPostById(id);
        if (!post) return sendNotFound(res);
        return sendHtml(res, 200, renderEditForm(post, null));
      }

      if (pathname.startsWith('/admin/edit/') && req.method === 'POST') {
        const id = pathname.replace('/admin/edit/', '');
        return handleEditSubmit(req, res, id);
      }

      if (pathname.startsWith('/admin/delete/') && req.method === 'POST') {
        const id = pathname.replace('/admin/delete/', '');
        return handleDelete(req, res, id);
      }
    }

    return sendNotFound(res);
  } catch (e) {
    console.error('Unhandled server error:', e);
    return sendHtml(res, 500, renderLayout('Something went wrong', `
      <div class="wrap">
        <p class="kicker">PRESSES JAMMED</p>
        <h1>Something went wrong on our end.</h1>
        <p>Please try again in a moment. If this keeps happening, check that the site's storage connection is configured correctly.</p>
        <p><a href="/">Back to the front page</a></p>
      </div>
    `));
  }
});

server.listen(PORT, () => {
  console.log(`BritThump is running at http://localhost:${PORT}`);
  console.log(`Admin password is currently: ${ADMIN_PASSWORD === 'changeme' ? '"changeme" — set ADMIN_PASSWORD env variable before deploying!' : '(set via environment variable)'}`);
});
