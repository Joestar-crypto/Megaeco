import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, 'api');
const API_V1_DIR = path.join(API_DIR, 'v1');

const DATASETS = [
  {
    id: 'network.economics',
    title: 'Network economics',
    description: 'USDM supply, M0, M1, lending vault reserves, and demand-deposit components.',
    sourcePath: 'data/economics-dashboard-data.json',
    outputPath: 'economics.json',
  },
  {
    id: 'network.megaHoldersHistory',
    title: 'MEGA holders history',
    description: 'Historical MEGA holder counts and holder-size buckets.',
    sourcePath: 'data/mega-holders-history.json',
    outputPath: 'mega-holders-history.json',
  },
  {
    id: 'apps.brix',
    title: 'Brix dashboard',
    description: 'Brix app dashboard metrics, prices, market-cap series, and summaries.',
    sourcePath: 'data/brix-dashboard-data.json',
    outputPath: 'apps/brix.json',
  },
  {
    id: 'apps.brixTokens',
    title: 'Brix token snapshots',
    description: 'Brix-related token contracts, holders, supply, and transfer snapshots.',
    sourcePath: 'data/brix-tokens.json',
    outputPath: 'apps/brix-tokens.json',
  },
  {
    id: 'apps.worldMarkets',
    title: 'World Markets dashboard',
    description: 'World Markets spot TVL, exchange balances, lending, fees, and source metadata.',
    sourcePath: 'data/world-markets-dashboard-data.json',
    outputPath: 'apps/world-markets.json',
  },
  {
    id: 'apps.euphoria',
    title: 'Euphoria dashboard',
    description: 'Euphoria transaction, transfer, volume, user, fee, and PnL snapshots.',
    sourcePath: 'data/euphoria-dashboard-data.json',
    outputPath: 'apps/euphoria.json',
  },
  {
    id: 'apps.hitone',
    title: 'HitOne dashboard',
    description: 'HitOne transaction, transfer, volume, user, fee, and PnL snapshots.',
    sourcePath: 'data/hitone-dashboard-data.json',
    outputPath: 'apps/hitone.json',
  },
];

function apiPath(outputPath) {
  return `/api/v1/${outputPath.replace(/\\/g, '/')}`;
}

function splitId(id) {
  return id.split('.');
}

function setNested(target, id, value) {
  const parts = splitId(id);
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    cursor[part] ||= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function toIsoDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function collectTimestampCandidates(value, depth = 0, out = []) {
  if (!value || depth > 4) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) collectTimestampCandidates(item, depth + 1, out);
    return out;
  }
  if (typeof value !== 'object') return out;

  for (const [key, child] of Object.entries(value)) {
    if (/^(asOf|fetchedAt|updatedAt|generatedAt)$/.test(key) || /(?:AsOf|FetchedAt|UpdatedAt)$/.test(key)) {
      const iso = toIsoDate(child);
      if (iso) out.push(iso);
    }
    collectTimestampCandidates(child, depth + 1, out);
  }
  return out;
}

function latestIso(values) {
  let latest = null;
  for (const value of values) {
    const iso = toIsoDate(value);
    if (!iso) continue;
    if (!latest || Date.parse(iso) > Date.parse(latest)) latest = iso;
  }
  return latest;
}

async function readJson(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function buildManifest(generatedAt, endpoints) {
  return {
    apiVersion: '1.0',
    name: 'MegaFees Dashboard API',
    description: 'Static JSON snapshots behind the MegaFees dashboard. No auth is required.',
    generatedAt,
    documentation: '/api/',
    openapi: '/api/v1/openapi.json',
    baseUrl: 'https://megafees.com/api/v1',
    cache: 'Snapshots are refreshed by the dashboard data workflow. Use cache: no-store when freshness matters.',
    cors: 'The repository includes _headers rules for Access-Control-Allow-Origin: * on static hosts that support them.',
    endpoints,
    examples: {
      completeDashboard: "const dashboard = await fetch('https://megafees.com/api/v1/dashboard.json').then((res) => res.json());",
      singleDataset: "const economics = await fetch('https://megafees.com/api/v1/economics.json').then((res) => res.json());",
    },
  };
}

function jsonResponse(description) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  };
}

function operationId(id) {
  return `get${id.split(/[^a-z0-9]+/i).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`;
}

function buildOpenApi(endpoints) {
  const paths = {
    '/api/v1/index.json': {
      get: {
        operationId: 'getApiManifest',
        summary: 'API manifest',
        responses: {
          200: jsonResponse('Endpoint manifest and fetch examples.'),
        },
      },
    },
    '/api/v1/dashboard.json': {
      get: {
        operationId: 'getDashboardData',
        summary: 'Complete dashboard data',
        responses: {
          200: jsonResponse('Combined MegaFees dashboard datasets.'),
        },
      },
    },
  };

  for (const endpoint of endpoints.filter((item) => item.id !== 'dashboard')) {
    paths[endpoint.path] = {
      get: {
        operationId: operationId(endpoint.id),
        summary: endpoint.title,
        description: endpoint.description,
        responses: {
          200: jsonResponse(endpoint.description),
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'MegaFees Dashboard API',
      version: '1.0.0',
      description: 'Static JSON API for the public MegaFees dashboard data.',
    },
    servers: [
      { url: 'https://megafees.com' },
    ],
    paths,
  };
}

async function main() {
  const payloads = new Map();
  const datasetEndpoints = [];

  for (const dataset of DATASETS) {
    const payload = await readJson(dataset.sourcePath);
    payloads.set(dataset.id, payload);

    const updatedAt = latestIso(collectTimestampCandidates(payload));
    const endpoint = {
      id: dataset.id,
      method: 'GET',
      title: dataset.title,
      description: dataset.description,
      path: apiPath(dataset.outputPath),
      sourcePath: `/${dataset.sourcePath}`,
      updatedAt,
    };
    datasetEndpoints.push(endpoint);

    await writeJson(path.join(API_V1_DIR, dataset.outputPath), payload);
  }

  const generatedAt = latestIso(datasetEndpoints.map((endpoint) => endpoint.updatedAt)) || new Date().toISOString();
  const datasets = {};
  for (const [id, payload] of payloads) setNested(datasets, id, payload);

  const dashboardEndpoint = {
    id: 'dashboard',
    method: 'GET',
    title: 'Complete dashboard data',
    description: 'All public MegaFees dashboard datasets in one response.',
    path: '/api/v1/dashboard.json',
    updatedAt: generatedAt,
  };

  const endpoints = [dashboardEndpoint, ...datasetEndpoints];
  const dashboard = {
    apiVersion: '1.0',
    name: 'MegaFees Dashboard API',
    generatedAt,
    documentation: '/api/',
    manifest: '/api/v1/index.json',
    datasets,
  };

  await writeJson(path.join(API_V1_DIR, 'dashboard.json'), dashboard);
  await writeJson(path.join(API_V1_DIR, 'index.json'), buildManifest(generatedAt, endpoints));
  await writeJson(path.join(API_V1_DIR, 'openapi.json'), buildOpenApi(endpoints));

  console.log(`[api] Wrote ${endpoints.length + 2} API files under api/v1.`);
}

await main();