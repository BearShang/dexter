import { DynamicStructuredTool } from '@langchain/core/tools';
import { ExaSearchResults } from '@langchain/exa';
import Exa from 'exa-js';
import { z } from 'zod';
import { formatToolResult, parseSearchResults } from '../types.js';
import { logger } from '@/utils';

type ExaSearchArgs = Record<string, unknown>;

const EXA_DEFAULT_NUM_RESULTS = 5;
const EXA_REALTIME_WINDOW_MS = 1000 * 60 * 60 * 72;
const A_SHARE_DOMAIN_HINT = '(site:cninfo.com.cn OR site:sse.com.cn OR site:szse.cn)';
const A_SHARE_RECENCY_HINT = '(latest OR today OR recent announcement OR exchange filing)';
const A_SHARE_QUERY_PATTERN =
  /(A[-\s]?shares?|China stocks|Chinese equities|SSE|SZSE|Shanghai Stock Exchange|Shenzhen Stock Exchange|A\u80A1|\u6CAA\u6DF1|\u4E0A\u4EA4\u6240|\u6DF1\u4EA4\u6240|\u79D1\u521B\u677F|\u521B\u4E1A\u677F)/i;

let exaClient: Exa | null = null;
let supportsRealtimeSearchArgs = true;

function getExaClient(): Exa {
  if (!exaClient) {
    exaClient = new Exa(process.env.EXASEARCH_API_KEY);
  }
  return exaClient;
}

function buildBaseSearchArgs(): ExaSearchArgs {
  return { numResults: EXA_DEFAULT_NUM_RESULTS, highlights: true };
}

function buildRealtimeSearchArgs(): ExaSearchArgs {
  return {
    ...buildBaseSearchArgs(),
    livecrawl: 'always',
    startPublishedDate: new Date(Date.now() - EXA_REALTIME_WINDOW_MS).toISOString(),
  };
}

function createExaTool(searchArgs: ExaSearchArgs): ExaSearchResults {
  // exa-js@2.x (root) vs exa-js@1.x (inside @langchain/exa) have
  // incompatible private fields but are compatible at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ExaSearchResults({ client: getExaClient() as any, searchArgs: searchArgs as any });
}

function shouldBiasToAShareRealtime(query: string): boolean {
  return A_SHARE_QUERY_PATTERN.test(query);
}

function buildSearchQuery(query: string): string {
  if (!shouldBiasToAShareRealtime(query)) {
    return query;
  }
  return `${query} ${A_SHARE_DOMAIN_HINT} ${A_SHARE_RECENCY_HINT}`;
}

function shouldFallbackToBaseArgs(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('livecrawl') ||
    normalized.includes('startpublisheddate') ||
    normalized.includes('start_published_date')
  );
}

async function invokeExa(query: string): Promise<unknown> {
  const args = supportsRealtimeSearchArgs ? buildRealtimeSearchArgs() : buildBaseSearchArgs();
  try {
    return await createExaTool(args).invoke(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (supportsRealtimeSearchArgs && shouldFallbackToBaseArgs(message)) {
      supportsRealtimeSearchArgs = false;
      logger.warn(
        '[Exa API] Realtime args unsupported by current backend; retrying with base search args.',
      );
      return createExaTool(buildBaseSearchArgs()).invoke(query);
    }
    throw error;
  }
}

export const exaSearch = new DynamicStructuredTool({
  name: 'web_search',
  description:
    'Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    try {
      const query = buildSearchQuery(input.query);
      const result = await invokeExa(query);
      const { parsed, urls } = parseSearchResults(result);
      return formatToolResult(parsed, urls);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Exa API] error: ${message}`);
      throw new Error(`[Exa API] ${message}`);
    }
  },
});
