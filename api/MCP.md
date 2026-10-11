# MCP server: use your recipes from Claude

The API Worker exposes an [MCP](https://modelcontextprotocol.io) endpoint so Claude can save and read recipes
directly from a chat — "spara det här receptet", "läs mitt pannkaksrecept", "vad har jag för recept med kyckling?".

It uses the same D1 database as the web app and Chrome extension, so recipes saved from Claude show up there too.

## Tools

| Tool | What it does |
|------|--------------|
| `save_recipe` | Save a recipe (title, ingredients, instructions + optional servings, times, category, cuisine, source…) |
| `import_recipe_from_url` | Fetch a recipe page, extract its schema.org recipe and save it |
| `search_recipes` | Search title, description, ingredients, category and cuisine; empty query lists the latest recipes |
| `get_recipe` | Read a full recipe by id or title |
| `update_recipe` | Change selected fields of a recipe |
| `delete_recipe` | Delete a recipe |

## Setup

### 1. Create a secret token and deploy

```bash
cd api
openssl rand -hex 32            # copy the output, this is your MCP token
npx wrangler secret put MCP_TOKEN   # paste the token
npx wrangler deploy
```

Recipes saved through MCP are owned by the first user who signed in to the web app.
To pick another user, set `MCP_USER_ID` (`npx wrangler secret put MCP_USER_ID`) to their id from the `users` table.

### 2. Connect Claude

The server URL is:

```
https://recipe-saver-api.hamiltoon.workers.dev/mcp/<MCP_TOKEN>
```

The token in the path is the password — keep the URL private.

**Claude.ai / Claude desktop / mobile app:** Settings → Connectors → *Add custom connector*, paste the URL
above and leave the OAuth fields empty. Connectors added on claude.ai sync to the desktop and mobile apps.

**Claude Code:**

```bash
claude mcp add --transport http recipes https://recipe-saver-api.hamiltoon.workers.dev/mcp/<MCP_TOKEN>
```

Clients that support custom headers can use `https://…/mcp` with `Authorization: Bearer <MCP_TOKEN>` instead.

## Local development

```bash
cd api
echo "MCP_TOKEN=devtoken" >> .dev.vars
npx wrangler d1 execute recipe-saver --local --file=schema.sql
npx wrangler d1 execute recipe-saver --local --file=schema-migrations/002_add_users.sql
npx wrangler dev

# in another terminal
curl -s http://localhost:8787/mcp/devtoken \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Or point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:8787/mcp/devtoken`.

## Implementation notes

- `src/mcp.js` implements the Streamable HTTP transport statelessly: every `POST` carries a JSON-RPC
  request and gets a JSON response. `GET`/`DELETE` return 405 since the server never pushes messages.
- Rotating the token (`wrangler secret put MCP_TOKEN` again) disconnects every client using the old URL.
