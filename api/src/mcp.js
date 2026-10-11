// MCP (Model Context Protocol) server for Recipe Saver
// Exposes the recipe collection to Claude over the Streamable HTTP transport,
// so you can say "save this recipe" or "read my pancake recipe" in a chat.
//
// Endpoint: /mcp/<MCP_TOKEN>  (or /mcp with "Authorization: Bearer <MCP_TOKEN>")

import { generateId } from './auth.js';

const SERVER_INFO = { name: 'recipe-saver', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INSTRUCTIONS = `This server is the user's personal recipe collection (receptsamling).
- When the user asks to save/store a recipe ("spara recept", "spara det här receptet"), call save_recipe with the full ingredient list and every step. If they give a link, call import_recipe_from_url first.
- When the user asks to read/find/show a recipe ("läs recept", "visa receptet", "vad har jag för recept med kyckling"), call search_recipes and then get_recipe.
- Keep ingredients and instructions in the language the user gave them in.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

// Optional recipe fields shared by save_recipe and update_recipe
const RECIPE_FIELDS = {
  description: { type: 'string', description: 'Short description of the dish' },
  servings: { type: 'string', description: 'Number of servings, e.g. "4 portioner"' },
  prepTime: { type: 'string', description: 'Preparation time, e.g. "15 min" or ISO 8601 "PT15M"' },
  cookTime: { type: 'string', description: 'Cooking time, e.g. "30 min"' },
  totalTime: { type: 'string', description: 'Total time, e.g. "45 min"' },
  category: { type: 'string', description: 'Course/category, e.g. "Middag", "Efterrätt", "Bakning"' },
  cuisine: { type: 'string', description: 'Cuisine, e.g. "Svensk", "Italiensk"' },
  url: { type: 'string', description: 'Source web page, if the recipe came from one' },
  source: { type: 'string', description: 'Where the recipe came from, e.g. a website, cookbook or person' },
  image: { type: 'string', description: 'Image URL' },
  author: { type: 'string', description: 'Recipe author' },
};

const STRING_LIST = { type: 'array', items: { type: 'string' } };

const TOOLS = [
  {
    name: 'save_recipe',
    title: 'Save recipe',
    description:
      'Save a recipe to the collection (spara recept). Include every ingredient with amounts and every step of the instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Recipe name' },
        ingredients: { ...STRING_LIST, description: 'One ingredient per item, with amount, e.g. "2 dl mjölk"' },
        instructions: { ...STRING_LIST, description: 'One step per item, in order' },
        ...RECIPE_FIELDS,
      },
      required: ['title', 'ingredients', 'instructions'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'import_recipe_from_url',
    title: 'Import recipe from URL',
    description:
      'Fetch a recipe web page, extract the recipe (schema.org markup) and save it to the collection. If extraction fails, read the page yourself and use save_recipe instead.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) link to the recipe page' },
      },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'search_recipes',
    title: 'Search recipes',
    description:
      'Search the recipe collection by words in the title, description, ingredients, category or cuisine (sök/läs recept). Leave query empty to list the latest recipes. Returns ids for get_recipe.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search words, e.g. "kyckling curry". All words must match.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max number of results (default 20)' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_recipe',
    title: 'Read recipe',
    description:
      'Read a full recipe with ingredients and instructions (läs recept). Give the id from search_recipes, or a title to look it up by name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Recipe id' },
        title: { type: 'string', description: 'Recipe title (or part of it) if the id is unknown' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'update_recipe',
    title: 'Update recipe',
    description: 'Change an existing recipe. Only the fields you pass are changed; lists replace the old list entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Recipe id' },
        title: { type: 'string' },
        ingredients: STRING_LIST,
        instructions: STRING_LIST,
        ...RECIPE_FIELDS,
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_recipe',
    title: 'Delete recipe',
    description: 'Permanently delete a recipe. Only do this when the user explicitly asks.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Recipe id' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

// Thrown from tool handlers for errors Claude should see and can recover from
class ToolError extends Error {}

// Thrown for malformed JSON-RPC requests
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isMcpPath(pathname) {
  return pathname === '/mcp' || pathname.startsWith('/mcp/');
}

export async function handleMcpRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!env.MCP_TOKEN) {
    return jsonResponse({ error: 'MCP is not configured. Set the MCP_TOKEN secret.' }, 503);
  }

  if (!(await isAuthorized(request, env.MCP_TOKEN))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // This server is stateless and never pushes server-initiated messages,
  // so there is no SSE stream to open and no session to delete.
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...CORS_HEADERS, Allow: 'POST' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, 'Parse error'), 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const ctx = { db: env.DB, env };
  const responses = [];

  for (const message of messages) {
    const response = await handleMessage(message, ctx);
    if (response) responses.push(response);
  }

  // Only notifications or client responses: acknowledge without a body
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  return jsonResponse(Array.isArray(body) ? responses : responses[0]);
}

async function isAuthorized(request, expectedToken) {
  const url = new URL(request.url);
  let pathToken = '';
  try {
    pathToken = decodeURIComponent(url.pathname.slice('/mcp/'.length));
  } catch {
    // malformed escape sequence: treat as no token
  }
  const headerToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const candidates = [pathToken, headerToken].filter(Boolean);

  for (const token of candidates) {
    if (await timingSafeEqual(token, expectedToken)) return true;
  }
  return false;
}

async function timingSafeEqual(a, b) {
  // Compare digests so the comparison time doesn't depend on where the strings differ
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

async function handleMessage(message, ctx) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return rpcError(message?.id ?? null, -32600, 'Invalid Request');
  }

  // Notifications (e.g. notifications/initialized) and responses get no reply
  if (message.id === undefined || message.id === null || !message.method) {
    return null;
  }

  try {
    const result = await dispatch(message.method, message.params || {}, ctx);
    return { jsonrpc: '2.0', id: message.id, result };
  } catch (error) {
    if (error instanceof RpcError) {
      return rpcError(message.id, error.code, error.message);
    }
    console.error('MCP error:', error);
    return rpcError(message.id, -32603, error.message || 'Internal error');
  }
}

async function dispatch(method, params, ctx) {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      };
    }

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call':
      return callTool(params.name, params.arguments || {}, ctx);

    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function callTool(name, args, ctx) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    throw new RpcError(-32602, `Unknown tool: ${name}`);
  }

  try {
    const text = await handler(args, ctx);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (!(error instanceof ToolError)) {
      console.error(`MCP tool ${name} failed:`, error);
    }
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}

const TOOL_HANDLERS = {
  async save_recipe(args, { db, env }) {
    const recipe = normalizeInput(args, { requireCore: true });

    if (recipe.url) {
      const existing = await db.prepare('SELECT id, title FROM recipes WHERE url = ?').bind(recipe.url).first();
      if (existing) {
        return `A recipe from this URL is already saved: "${existing.title}" (id: ${existing.id}). Use update_recipe to change it.`;
      }
    }

    const saved = await insertRecipe(db, recipe, await resolveUserId(db, env));
    return `Saved "${saved.title}" (id: ${saved.id}).\n\n${formatRecipe(saved)}`;
  },

  async import_recipe_from_url(args, { db, env }) {
    const url = requireString(args.url, 'url');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolError('url is not a valid link');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ToolError('Only http and https links are supported');
    }

    const existing = await db.prepare('SELECT * FROM recipes WHERE url = ?').bind(parsed.href).first();
    if (existing) {
      return `This recipe is already saved (id: ${existing.id}).\n\n${formatRecipe(rowToRecipe(existing))}`;
    }

    const response = await fetch(parsed.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeSaver/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new ToolError(`Could not fetch the page (HTTP ${response.status}). Read the page yourself and use save_recipe.`);
    }

    const extracted = extractRecipeFromHtml(await response.text());
    if (!extracted || extracted.ingredients.length === 0) {
      throw new ToolError('No recipe markup found on the page. Read the page yourself and use save_recipe.');
    }

    const recipe = {
      ...extracted,
      url: parsed.href,
      source: parsed.hostname.replace(/^www\./, ''),
    };
    const saved = await insertRecipe(db, recipe, await resolveUserId(db, env));
    return `Imported and saved "${saved.title}" (id: ${saved.id}).\n\n${formatRecipe(saved)}`;
  },

  async search_recipes(args, { db }) {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
    const words = typeof args.query === 'string' ? args.query.trim().split(/\s+/).filter(Boolean) : [];

    const conditions = words.map(
      () => '(title LIKE ? OR description LIKE ? OR ingredients LIKE ? OR category LIKE ? OR cuisine LIKE ?)'
    );
    const bindings = words.flatMap((word) => Array(5).fill(`%${word}%`));

    const sql = `
      SELECT id, title, category, cuisine, totalTime, servings, dateAdded FROM recipes
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY dateAdded DESC
      LIMIT ?
    `;
    const { results } = await db.prepare(sql).bind(...bindings, limit).all();

    if (results.length === 0) {
      return words.length ? `No recipes match "${args.query}".` : 'The recipe collection is empty.';
    }

    const heading = words.length
      ? `Found ${results.length} recipe(s) matching "${args.query}":`
      : `Latest ${results.length} recipe(s):`;
    const lines = results.map((row) => {
      const details = [row.category, row.cuisine, formatDuration(row.totalTime), row.servings].filter(Boolean);
      return `- ${row.title} (id: ${row.id})${details.length ? ` — ${details.join(', ')}` : ''}`;
    });
    return `${heading}\n${lines.join('\n')}`;
  },

  async get_recipe(args, { db }) {
    if (args.id) {
      const row = await db.prepare('SELECT * FROM recipes WHERE id = ?').bind(String(args.id)).first();
      if (!row) throw new ToolError(`No recipe with id ${args.id}. Use search_recipes to find it.`);
      return formatRecipe(rowToRecipe(row));
    }

    const title = requireString(args.title, 'id or title');
    const { results } = await db
      .prepare('SELECT * FROM recipes WHERE title LIKE ? ORDER BY (lower(title) = lower(?)) DESC, dateAdded DESC LIMIT 10')
      .bind(`%${title}%`, title)
      .all();

    if (results.length === 0) {
      throw new ToolError(`No recipe titled "${title}". Use search_recipes to search ingredients and categories too.`);
    }
    const exact = results.find((row) => row.title.toLowerCase() === title.toLowerCase());
    if (exact || results.length === 1) {
      return formatRecipe(rowToRecipe(exact || results[0]));
    }
    return `Several recipes match "${title}". Call get_recipe with one of these ids:\n${results
      .map((row) => `- ${row.title} (id: ${row.id})`)
      .join('\n')}`;
  },

  async update_recipe(args, { db }) {
    const id = requireString(args.id, 'id');
    const row = await db.prepare('SELECT * FROM recipes WHERE id = ?').bind(id).first();
    if (!row) throw new ToolError(`No recipe with id ${id}`);

    const changes = normalizeInput(args, { requireCore: false });
    if (Object.keys(changes).length === 0) {
      throw new ToolError('Nothing to update. Pass at least one field to change.');
    }

    const updated = { ...rowToRecipe(row), ...changes, dateModified: new Date().toISOString() };
    await db
      .prepare(`
        UPDATE recipes SET
          title = ?, description = ?, ingredients = ?, instructions = ?,
          prepTime = ?, cookTime = ?, totalTime = ?, servings = ?, category = ?,
          cuisine = ?, image = ?, author = ?, url = ?, source = ?, dateModified = ?
        WHERE id = ?
      `)
      .bind(
        updated.title,
        updated.description || '',
        JSON.stringify(updated.ingredients),
        JSON.stringify(updated.instructions),
        updated.prepTime || '',
        updated.cookTime || '',
        updated.totalTime || '',
        updated.servings || '',
        updated.category || '',
        updated.cuisine || '',
        updated.image || '',
        updated.author || '',
        updated.url || '',
        updated.source || '',
        updated.dateModified,
        id
      )
      .run();

    return `Updated "${updated.title}".\n\n${formatRecipe(updated)}`;
  },

  async delete_recipe(args, { db }) {
    const id = requireString(args.id, 'id');
    const row = await db.prepare('SELECT title FROM recipes WHERE id = ?').bind(id).first();
    if (!row) throw new ToolError(`No recipe with id ${id}`);

    await db.prepare('DELETE FROM recipes WHERE id = ?').bind(id).run();
    return `Deleted "${row.title}".`;
  },
};

// Recipes saved via MCP belong to MCP_USER_ID, or the first user who signed in to the web app
async function resolveUserId(db, env) {
  if (env.MCP_USER_ID) return env.MCP_USER_ID;
  try {
    const user = await db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').first();
    return user ? user.id : null;
  } catch {
    // users table missing (migration 002 not applied)
    return null;
  }
}

async function insertRecipe(db, recipe, userId) {
  const now = new Date().toISOString();
  const saved = { ...recipe, id: generateId(), dateAdded: now, dateModified: now };

  await db
    .prepare(`
      INSERT INTO recipes (
        id, title, description, ingredients, instructions,
        prepTime, cookTime, totalTime, servings, category,
        cuisine, image, author, url, source, dateAdded, dateModified, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      saved.id,
      saved.title,
      saved.description || '',
      JSON.stringify(saved.ingredients),
      JSON.stringify(saved.instructions),
      saved.prepTime || '',
      saved.cookTime || '',
      saved.totalTime || '',
      saved.servings || '',
      saved.category || '',
      saved.cuisine || '',
      saved.image || '',
      saved.author || '',
      saved.url || '',
      saved.source || '',
      saved.dateAdded,
      saved.dateModified,
      userId
    )
    .run();

  return saved;
}

// Pick the known recipe fields out of tool arguments
function normalizeInput(args, { requireCore }) {
  const recipe = {};

  if (requireCore || args.title !== undefined) {
    recipe.title = requireString(args.title, 'title');
  }
  for (const field of ['ingredients', 'instructions']) {
    if (requireCore || args[field] !== undefined) {
      recipe[field] = toStringList(args[field]);
      if (recipe[field].length === 0) throw new ToolError(`${field} must contain at least one item`);
    }
  }
  for (const field of Object.keys(RECIPE_FIELDS)) {
    if (args[field] !== undefined && args[field] !== null) {
      recipe[field] = String(args[field]).trim();
    }
  }

  return recipe;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError(`${name} is required`);
  }
  return value.trim();
}

function toStringList(value) {
  if (typeof value === 'string') {
    // Accept a newline-separated string as well as an array
    value = value.split('\n');
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function rowToRecipe(row) {
  return {
    ...row,
    ingredients: JSON.parse(row.ingredients || '[]'),
    instructions: JSON.parse(row.instructions || '[]'),
  };
}

function formatRecipe(recipe) {
  const lines = [`# ${recipe.title}`];
  if (recipe.description) lines.push('', recipe.description);

  const facts = [
    ['Portioner', recipe.servings],
    ['Förberedelse', formatDuration(recipe.prepTime)],
    ['Tillagning', formatDuration(recipe.cookTime)],
    ['Total tid', formatDuration(recipe.totalTime)],
    ['Kategori', recipe.category],
    ['Kök', recipe.cuisine],
  ].filter(([, value]) => value);
  if (facts.length) {
    lines.push('', ...facts.map(([label, value]) => `- ${label}: ${value}`));
  }

  lines.push('', '## Ingredienser', ...recipe.ingredients.map((item) => `- ${item}`));
  lines.push('', '## Gör så här', ...recipe.instructions.map((step, i) => `${i + 1}. ${step}`));

  const origin = [recipe.author && `Av ${recipe.author}`, recipe.url || recipe.source].filter(Boolean);
  if (origin.length) lines.push('', `Källa: ${origin.join(' — ')}`);
  lines.push('', `id: ${recipe.id}`);

  return lines.join('\n');
}

// "PT1H30M" -> "1 h 30 min"; other strings are returned unchanged
function formatDuration(value) {
  if (!value) return '';
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i.exec(value);
  if (!match) return value;
  const [, days, hours, minutes] = match.map((part) => parseInt(part, 10) || 0);
  const totalHours = days * 24 + hours;
  const parts = [];
  if (totalHours) parts.push(`${totalHours} h`);
  if (minutes) parts.push(`${minutes} min`);
  return parts.join(' ') || value;
}

// --- schema.org Recipe extraction (mirrors plugin/content.js) ---

export function extractRecipeFromHtml(html) {
  const scriptPattern = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const recipe = findRecipeNode(data);
    if (recipe) return normalizeSchemaRecipe(recipe);
  }
  return null;
}

function findRecipeNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  const type = node['@type'];
  if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return node;
  return findRecipeNode(node['@graph']) || findRecipeNode(node.mainEntity);
}

function normalizeSchemaRecipe(schema) {
  return {
    title: cleanText(schema.name) || 'Recept',
    description: cleanText(schema.description),
    ingredients: asArray(schema.recipeIngredient).map(cleanText).filter(Boolean),
    instructions: flattenInstructions(schema.recipeInstructions),
    prepTime: firstText(schema.prepTime),
    cookTime: firstText(schema.cookTime),
    totalTime: firstText(schema.totalTime),
    servings: firstText(schema.recipeYield),
    category: asArray(schema.recipeCategory).map(cleanText).filter(Boolean).join(', '),
    cuisine: asArray(schema.recipeCuisine).map(cleanText).filter(Boolean).join(', '),
    image: firstText(asArray(schema.image).map((image) => image?.url || image)),
    author: firstText(asArray(schema.author).map((author) => author?.name || author)),
  };
}

function flattenInstructions(value) {
  const steps = [];
  for (const item of asArray(value)) {
    if (typeof item === 'string') {
      steps.push(...item.split(/\n+/));
    } else if (item && Array.isArray(item.itemListElement)) {
      // HowToSection with nested HowToSteps
      steps.push(...flattenInstructions(item.itemListElement));
    } else if (item) {
      steps.push(item.text || item.name || '');
    }
  }
  return steps.map(cleanText).filter(Boolean);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstText(value) {
  const first = asArray(value).find((item) => typeof item === 'string' || typeof item === 'number');
  return first === undefined ? '' : cleanText(String(first));
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (HTML_ENTITIES[code.toLowerCase()]) return HTML_ENTITIES[code.toLowerCase()];
      if (code[0] === '#') {
        const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
      }
      return entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
