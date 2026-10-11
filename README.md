# Recipe Saver

A full-stack recipe management application with Chrome extension, React web app, and GraphQL API backend.

## Live Demo

**Web App:** https://hamiltoon.github.io/animated-winner/

## Architecture

- **Web App**: React + Vite + Radix UI (`web/`)
- **Chrome Extension**: Popup + Content Script (`plugin/`)
- **MCP Server**: Save and read recipes from Claude (`api/src/mcp.js`)
- **Backend**: Cloudflare Workers + GraphQL Yoga + D1 (`api/`)
- **Database**: Cloudflare D1 (SQLite-compatible, edge-deployed)
- **Auth**: GitHub OAuth

## Features

- GitHub OAuth authentication
- Extract recipes from web pages using schema.org markup
- Save recipes to cloud database
- Search recipes by title, ingredients, category, cuisine
- View recipe details with ingredients and instructions
- Export/Import recipes as JSON
- Modern React UI with black and white theme
- GraphQL API for all operations with type safety
- Chrome extension for easy recipe extraction
- MCP server so Claude can save, search and read recipes from a chat

## Project Structure

```
.
├── web/                     # React web application
│   ├── src/
│   │   ├── components/      # React components (Header, RecipeCard)
│   │   ├── lib/             # Auth & API utilities
│   │   ├── App.jsx          # Main application component
│   │   └── index.css        # Global styles & theme variables
│   ├── vite.config.js       # Vite configuration
│   └── package.json         # Dependencies
├── api/                     # Cloudflare Workers API
│   ├── src/
│   │   ├── index.js         # Worker entry point
│   │   ├── mcp.js           # MCP server for Claude
│   │   ├── resolvers.js     # GraphQL resolvers (D1)
│   │   ├── schema.js        # Schema builder
│   │   └── schema.graphql   # GraphQL schema
│   ├── schema.sql           # D1 database schema
│   ├── wrangler.toml        # Cloudflare configuration
│   ├── package.json         # Dependencies
│   ├── README.md            # Deployment guide
│   ├── MCP.md               # Connecting Claude via MCP
│   └── MIGRATION.md         # Migration notes
├── plugin/                  # Chrome extension
│   ├── manifest.json        # Extension manifest
│   ├── popup.html           # Extension popup UI
│   ├── popup.css            # Popup styles
│   ├── popup.js             # Popup logic
│   ├── content.js           # Content script for recipe extraction
│   ├── storage.js           # GraphQL client
│   └── README.md            # Extension guide
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Actions deployment
└── README.md                # This file
```

## Setup Instructions

### 1. Deploy the API to Cloudflare Workers

The API is deployed on Cloudflare's global edge network:

```bash
cd api
npm install
npx wrangler login
npx wrangler d1 create recipe-saver
# Update wrangler.toml with the database_id from the output
npx wrangler d1 execute recipe-saver --file=schema.sql --remote
npx wrangler deploy
```

See [api/README.md](api/README.md) for detailed deployment instructions.

**Deployed API:** https://recipe-saver-api.hamiltoon.workers.dev/graphql

### 2. Configure GitHub OAuth

1. Go to GitHub Settings > Developer settings > OAuth Apps
2. Create a new OAuth App:
   - Application name: Recipe Saver
   - Homepage URL: https://hamiltoon.github.io/animated-winner/
   - Authorization callback URL: https://hamiltoon.github.io/animated-winner/
3. Copy the Client ID and Client Secret
4. Update `web/src/lib/auth.js` with your Client ID
5. Add Client Secret to your Cloudflare Workers environment

### 3. Run the Web App Locally

```bash
cd web
npm install
npm run dev
```

The app will be available at http://localhost:5173

### 4. Deploy the Web App

The web app automatically deploys to GitHub Pages on push to main:

1. Push to the main branch
2. GitHub Actions builds and deploys
3. Visit https://hamiltoon.github.io/animated-winner/

### 5. Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `plugin` directory
5. The extension should now appear in your extensions list

### 6. Connect Claude (MCP)

Set an `MCP_TOKEN` secret on the Worker and add
`https://recipe-saver-api.hamiltoon.workers.dev/mcp/<MCP_TOKEN>` as a custom connector in Claude.
Then just ask Claude to "save this recipe" or "read my pancake recipe".
See [api/MCP.md](api/MCP.md) for details.

## GraphQL API

The API is deployed on Cloudflare Workers and uses GraphQL.

**API Endpoint:** https://recipe-saver-api.hamiltoon.workers.dev/graphql

See [api/GRAPHQL.md](api/GRAPHQL.md) for complete API documentation.

### Quick Examples

**Authentication:**
```graphql
mutation {
  authenticateGitHub(code: "oauth_code") {
    success
    token
    user {
      id
      username
      email
    }
  }
}
```

**Get current user:**
```graphql
query {
  me {
    id
    username
    email
    avatarUrl
  }
}
```

**Get all recipes:**
```graphql
query {
  recipes {
    id
    title
    ingredients
    category
    cuisine
  }
}
```

**Create a recipe:**
```graphql
mutation {
  createRecipe(input: {
    title: "Pasta Carbonara"
    ingredients: ["pasta", "eggs", "bacon", "parmesan"]
    instructions: ["boil pasta", "fry bacon", "mix with eggs", "combine"]
    category: "Main Course"
    cuisine: "Italian"
  }) {
    success
    id
    recipe {
      id
      title
    }
  }
}
```

**Search recipes:**
```graphql
query {
  searchRecipes(query: "pasta") {
    id
    title
    ingredients
  }
}
```

## How It Works

### Chrome Extension
1. **Recipe Detection**: Content script scans web pages for schema.org Recipe JSON-LD markup
2. **Data Extraction**: Extracts title, ingredients, instructions, times, category, cuisine, etc.
3. **Storage**: Sends data to GraphQL API which stores in Cloudflare D1
4. **Retrieval**: Fetches recipes via GraphQL queries

### Web App
1. **Authentication**: GitHub OAuth flow with token storage
2. **Recipe Display**: Fetches and displays all recipes with filtering
3. **Search & Filter**: Real-time search by title, ingredients, category, cuisine
4. **Modern UI**: Black and white theme with Radix UI components

### API
1. **Authentication**: Validates GitHub OAuth codes and issues JWT tokens
2. **Authorization**: Bearer token validation for protected endpoints
3. **GraphQL**: Type-safe API with schema validation
4. **Database**: Cloudflare D1 (SQLite) with proper indexes

## Development

### Testing the API

Interactive GraphQL playground available at the API URL:
https://recipe-saver-api.hamiltoon.workers.dev/graphql

Or test with curl:

```bash
# Health check
curl -X POST https://recipe-saver-api.hamiltoon.workers.dev/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ health }"}'

# Get recipes (requires auth)
curl -X POST https://recipe-saver-api.hamiltoon.workers.dev/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"query": "{ recipes { id title } }"}'
```

### Local Development

**API:**
```bash
cd api
npm install
npx wrangler dev
```

**Web App:**
```bash
cd web
npm install
npm run dev
```

### Debugging

- Check browser console for frontend errors
- Check Cloudflare Workers logs with `npx wrangler tail`
- Open Chrome DevTools on the extension popup
- Check `chrome://extensions/` for extension errors

## Tech Stack

- **Frontend**: React 18, Vite, Radix UI
- **Backend**: Cloudflare Workers, GraphQL Yoga
- **Database**: Cloudflare D1 (SQLite)
- **Auth**: GitHub OAuth + JWT
- **Deployment**: GitHub Actions, GitHub Pages, Cloudflare Workers
- **Extension**: Chrome Extension Manifest V3

## Theme

The app uses a clean black and white theme:
- Primary color: `#000000` (black)
- Background: `#ffffff` (white)
- Secondary background: `#f5f5f5` (light gray)
- Text: `#000000` (black primary), `#666666` (gray secondary)
- Borders: `#e0e0e0` (light gray)

## GraphQL Benefits

- **Type Safety**: Strong typing with schema validation
- **Flexible Queries**: Request exactly the fields you need
- **Single Endpoint**: All operations through `/graphql`
- **Self-Documenting**: Interactive GraphQL Playground
- **No Over-fetching**: Get only the data you request

## Future Enhancements

- Add delete recipe functionality
- Recipe tags and ratings
- Recipe images upload
- Meal planning features
- Shopping list generation
- Recipe sharing between users
- Import from other recipe formats
