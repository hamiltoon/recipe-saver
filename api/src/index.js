// Recipe Saver GraphQL API for Cloudflare Workers
import { createYoga } from 'graphql-yoga';
import { createSchema } from './schema.js';
import { createResolvers } from './resolvers.js';
import { createAuthResolvers } from './auth-resolvers.js';
import { isMcpPath, handleMcpRequest } from './mcp.js';

// Merge resolvers helper
function mergeResolvers(...resolverObjects) {
  const merged = {};
  for (const resolvers of resolverObjects) {
    for (const [type, fields] of Object.entries(resolvers)) {
      if (!merged[type]) {
        merged[type] = {};
      }
      Object.assign(merged[type], fields);
    }
  }
  return merged;
}

export default {
  async fetch(request, env, ctx) {
    // MCP endpoint for Claude (save/read recipes from a chat)
    if (isMcpPath(new URL(request.url).pathname)) {
      return handleMcpRequest(request, env);
    }

    // Merge recipe and auth resolvers
    const resolvers = mergeResolvers(
      createResolvers(env.DB, env),
      createAuthResolvers(env.DB, env)
    );

    // Create GraphQL Yoga instance
    const yoga = createYoga({
      schema: createSchema(resolvers),

      // Enable GraphiQL playground in development
      graphiql: env.ENVIRONMENT !== 'production',

      // CORS configuration for Chrome extension
      cors: {
        origin: '*',
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      },

      // Logging in development
      logging: env.ENVIRONMENT !== 'production',
    });

    // Handle the request
    return yoga.fetch(request, env, ctx);
  },
};
