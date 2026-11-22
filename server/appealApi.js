// Property tax protest: Claude writes the letter (and a short reason for an online form) from the facts the
// page worked out (appealFacts in src/utils/propertyTax.js). Nothing is stored here: the page keeps the text.
import { ApiError, actionName, checkRequest, parseHostList, readJson, sendError, sendJson } from './http.js';
import { MODEL, anthropicClient, asApiError, notConfigured, parseWithClaude } from './anthropic.js';

const MAX_BODY_BYTES = 128 * 1024;

const SYSTEM = `You write a homeowner's property tax protest to the county assessor, from facts their finance app gathered.

- letter: a clear, polite, factual letter in plain text (no markdown), addressed "To the Assessor:". Say which value is
  protested and what value the evidence supports as of the appraisal date. Present each comparable sale with its address,
  sale date, price, size and price per square foot, and what it indicates for the home; then the range and median. Include
  the other evidence (an appraisal, the owner's own purchase) and say it falls inside the sales window. Ask for the
  requested value. End with "Sincerely," and the placeholders [Your name] and [Phone or email].
- reason: two to four sentences for an online protest form's reason box: the requested value and the strongest evidence.
- Use only the facts given, and only figures that appear in them; don't invent comparables, features or law. If a sale's
  notes say it is larger, smaller or older, you may say the comparison is adjusted by price per square foot, nothing more.
  Leave out facts that are null.`;

export async function createAppealWriter({ client }) {
  const { z } = await import('zod');
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const Protest = z.object({ letter: z.string(), reason: z.string() });
  return (facts) => parseWithClaude(client, {
    system: SYSTEM,
    content: `<facts>\n${JSON.stringify(facts, null, 1)}\n</facts>\n\nWrite the protest.`,
    format: betaZodOutputFormat(Protest),
    fallbackHint: 'Use the plain letter instead.',
  });
}

const NOT_WRITING = notConfigured('Writing the letter with Claude');

export function createAppealHandler({ write, allowedHosts = [] }) {
  const actions = {
    status: () => ({ writing: Boolean(write), model: write ? MODEL : null, problem: write ? null : NOT_WRITING }),
    async write({ facts }) {
      if (!facts || typeof facts !== 'object' || Array.isArray(facts) || typeof facts.address !== 'string') {
        throw new ApiError('BAD_REQUEST', 'facts (with the address) are required.');
      }
      if (!write) throw new ApiError('NOT_CONFIGURED', NOT_WRITING, 400);
      try {
        return await write(facts);
      } catch (err) {
        throw await asApiError(err);
      }
    },
  };

  return async function handler(req, res) {
    try {
      checkRequest(req, allowedHosts);
      const name = actionName(req);
      if (!Object.hasOwn(actions, name)) throw new ApiError('NOT_FOUND', `Unknown action "${name}".`, 404);
      const body = await readJson(req, MAX_BODY_BYTES);
      sendJson(req, res, 200, await actions[name](body));
    } catch (err) {
      sendError(req, res, err);
    }
  };
}

// Vite plugin: mounts the API at /api/appeal on `npm run dev` and `npm run preview`
export function appealApiPlugin(vars) {
  const allowedHosts = parseHostList(vars.MONEYLENS_ALLOWED_HOSTS);
  const attach = async (server) => {
    const client = await anthropicClient(vars);
    const write = client ? await createAppealWriter({ client }) : null;
    server.middlewares.use('/api/appeal', createAppealHandler({ write, allowedHosts }));
  };
  return { name: 'moneylens-appeal-api', configureServer: attach, configurePreviewServer: attach };
}
