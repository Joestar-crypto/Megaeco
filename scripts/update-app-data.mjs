import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const BRIX_FILE = path.join(DATA_DIR, 'brix-dashboard-data.json');
const BRIX_TOKENS_FILE = path.join(DATA_DIR, 'brix-tokens.json');
const EUPHORIA_FILE = path.join(DATA_DIR, 'euphoria-dashboard-data.json');
const HITONE_FILE = path.join(DATA_DIR, 'hitone-dashboard-data.json');
const WORLD_FILE = path.join(DATA_DIR, 'world-markets-dashboard-data.json');

const USER_AGENT = 'MegaFees App Data Refresh/1.0';
const DEFAULT_TIMEOUT_MS = 45000;
const RPC_TIMEOUT_MS = 90000;
const MEGAETH_RPC = 'https://mainnet.megaeth.com/rpc';

const EUPHORIA_CONTRACT = '0x12759afca690637b425ffba3265f0dc2f6242a8d';
const EUPHORIA_POOL = '0xdf8248fee58e791149e69f6c61129d471eafc11e';
const HITONE_CONTRACT = '0xdf248bafe6fe9a73f201a125641e5c8bb20472f7';
const USDM_TOKEN = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7';
const EUPHORIA_LAUNCH_DATE = '2026-05-14';
const HITONE_LAUNCH_DATE = '2026-02-13';
const HITONE_FEE_REPORT_START_DATE = '2026-05-01';

const WORLD_EXCHANGE = '0x5e3ae52eba0f9740364bd5dd39738e1336086a8b';

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const EUPHORIA_BAND_COLORS = {
  loss: '#2A0D1C',
  flat: '#FFF1F8',
  'gain-small': '#F9BADD',
  'gain-mid': '#FF8FCC',
  'gain-high': '#D94D96',
  'gain-whale': '#7C2A52',
};

const HITONE_BAND_COLORS = {
  loss: '#2A1110',
  flat: '#F7F2DE',
  'gain-small': '#FBBF24',
  'gain-mid': '#22C55E',
  'gain-high': '#20B2AA',
  'gain-whale': '#0B5EA8',
};

const TAP_TRADING_APPS = {
  euphoria: {
    name: 'Euphoria',
    file: EUPHORIA_FILE,
    contract: EUPHORIA_CONTRACT,
    launchDate: EUPHORIA_LAUNCH_DATE,
    initialBackfillDate: EUPHORIA_LAUNCH_DATE,
    excludedCounterparties: [EUPHORIA_POOL],
    bandColors: EUPHORIA_BAND_COLORS,
    sinceLaunchMode: 'points',
    userSnapshot: {
      type: 'miniblocks',
      dappId: 40,
      source: 'MiniBlocks unique callers',
      sourceUrl: 'https://miniblocks.io/dapps/euphoria',
      label: 'Unique transaction callers over the last 24h from MiniBlocks.',
    },
    methodology: 'Daily snapshots use MegaETH USDM Transfer logs involving the Euphoria contract. Player volume and PnL exclude the Euphoria pool, while raw transfer counts keep every USDM transfer touching the contract. Since-live totals start from the official 2026-05-14 UTC launch window.',
  },
  hitone: {
    name: 'HitOne',
    file: HITONE_FILE,
    contract: HITONE_CONTRACT,
    launchDate: HITONE_LAUNCH_DATE,
    initialBackfillDate: 'today',
    minimumBackfillDays: 14,
    excludedCounterparties: [],
    bandColors: HITONE_BAND_COLORS,
    sinceLaunchMode: 'counter',
    tradeFeePct: 0.01,
    profitFeePct: 0.05,
    userSnapshot: {
      type: 'blockscout-usdm-transfers',
      source: 'MegaETH Blockscout USDM token transfers',
      sourceUrl: `https://megaeth.blockscout.com/address/${HITONE_CONTRACT}`,
      label: 'Unique USDM transfer counterparties over the last 24h from Blockscout.',
    },
    feeWarmupStartDate: HITONE_LAUNCH_DATE,
    feeReportStartDate: HITONE_FEE_REPORT_START_DATE,
    methodology: 'Daily snapshots use MegaETH USDM Transfer logs involving the HitOne address. Player volume and PnL treat USDM sent to HitOne as stakes and USDM sent from HitOne as payouts. Since-live transfer totals use the all-time Blockscout counter because HitOne predates MegaFees daily snapshots.',
    feeMethodology: 'Project revenue assumes HitOne keeps 1% of each incoming trade amount immediately and 5% of realized profit. Because the HitOne address is an EOA with no on-chain trade id, payouts are matched against each wallet\'s running net principal balance first; any payout excess is treated as profit already net of the 5% fee, so project profit fee = net profit paid x 5 / 95.',
  },
};

const selectedApps = (() => {
  const onlyIndex = process.argv.indexOf('--only');
  const raw = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
  if (!raw) return null;
  return new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
})();

function shouldRefresh(appId) {
  return !selectedApps || selectedApps.has(appId);
}

const WORLD_COLOR_FALLBACKS = {
  USDM: '#6DD0A9',
  WITRY: '#F97357',
  WETH: '#7EAAD4',
  'BTC.B': '#F4D35E',
  BTCB: '#F4D35E',
  MEGA: '#FF8AA8',
  USDT0: '#9AA7C2',
  SOL: '#6DD0A9',
  HYPE: '#C586FF',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}, retries = 3) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      const text = await fetchText(url, options);
      return JSON.parse(text);
    } catch (error) {
      attempt += 1;
      if (attempt >= retries) throw error;
      await sleep(750 * attempt);
    }
  }
  throw new Error(`Failed to fetch JSON from ${url}`);
}

async function rpc(method, params = [], retries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(MEGAETH_RPC, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} for RPC ${method}`);
      }
      const payload = await response.json();
      if (payload.error) {
        throw new Error(`RPC ${method} failed: ${payload.error.message || JSON.stringify(payload.error)}`);
      }
      return payload.result;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(1200 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((safeNumber(value) + Number.EPSILON) * factor) / factor;
}

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function topicAddress(address) {
  return '0x' + normalizeAddress(address).replace(/^0x/, '').padStart(64, '0');
}

function topicToAddress(topic) {
  const clean = String(topic || '').replace(/^0x/, '');
  return '0x' + clean.slice(-40).toLowerCase();
}

function hexToBigInt(value) {
  return BigInt(value);
}

function unitsToNumber(rawValue, decimals = 18) {
  const raw = typeof rawValue === 'bigint' ? rawValue.toString() : String(rawValue || '0');
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, '0');
  const integerPart = padded.slice(0, -decimals) || '0';
  const fractionPart = padded.slice(-decimals).replace(/0+$/, '');
  const normalized = `${negative ? '-' : ''}${integerPart}${fractionPart ? '.' + fractionPart : ''}`;
  return Number(normalized);
}

function currentDateString() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoDateString(daysAgo) {
  const date = new Date(`${currentDateString()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - Math.max(0, daysAgo));
  return date.toISOString().slice(0, 10);
}

function nextDateString(dateString) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function laterDate(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function earlierDate(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    cursor = nextDateString(cursor);
  }
  return dates;
}

function dayStartUnix(dateString) {
  return Math.floor(Date.parse(`${dateString}T00:00:00.000Z`) / 1000);
}

function dayEndTimestamp(dateString) {
  return Date.parse(`${dateString}T23:59:59.999Z`);
}

function sum(values) {
  return values.reduce((total, value) => total + safeNumber(value), 0);
}

function upsertDatePoint(points, point) {
  const next = Array.isArray(points) ? points.filter((entry) => entry.date !== point.date) : [];
  next.push(point);
  next.sort((left, right) => String(left.date).localeCompare(String(right.date)));
  return next;
}

function upsertTimestampPoint(points, point) {
  const targetTimestamp = safeNumber(point.timestamp);
  const next = Array.isArray(points)
    ? points.filter((entry) => safeNumber(entry.timestamp) !== targetTimestamp)
    : [];
  next.push(point);
  next.sort((left, right) => safeNumber(left.timestamp) - safeNumber(right.timestamp));
  return next;
}

function keepLast(items, count) {
  return items.slice(Math.max(0, items.length - count));
}

function annualizeReturn(returnValue, days) {
  if (!Number.isFinite(returnValue)) return 0;
  if (returnValue <= -1) return -1;
  return Math.pow(1 + returnValue, 365 / Math.max(1, days)) - 1;
}

async function fetchBlockscoutJson(pathname, searchParams) {
  const url = new URL(pathname, 'https://megaeth.blockscout.com/api/v2/');
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return fetchJson(url.toString());
}

async function fetchAllBlockscoutPages(pathname, searchParams) {
  const items = [];
  let nextParams = { ...(searchParams || {}) };
  while (true) {
    const payload = await fetchBlockscoutJson(pathname, nextParams);
    items.push(...(payload.items || []));
    if (!payload.next_page_params) break;
    nextParams = { ...(searchParams || {}), ...payload.next_page_params };
  }
  return items;
}

async function fetchBlockscoutToken(address) {
  return fetchBlockscoutJson(`tokens/${address}`);
}

async function fetchBlockscoutAddressCounters(address) {
  return fetchBlockscoutJson(`addresses/${address}/counters`);
}

async function fetchBlockscoutAddressTokenBalances(address) {
  return fetchBlockscoutJson(`addresses/${address}/token-balances`);
}

function parseApiTimestampMs(value) {
  const normalized = String(value || '').replace(/\.\d+Z$/, 'Z');
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function fetchMiniblocksDappStats(dappId) {
  const stats = await fetchJson(`https://miniblocks.io/api/dapps/${dappId}/stats?timeframe=24h`);
  const users = Number(stats?.unique_callers);
  if (!Number.isFinite(users) || users < 0) return null;
  return {
    users: Math.round(users),
    txCount: safeNumber(stats?.tx_count),
    failedCount: safeNumber(stats?.failed_count),
    totalGasUsed: safeNumber(stats?.total_gas_used),
    avgGasPerTx: safeNumber(stats?.avg_gas_per_tx),
  };
}

async function fetchRecentUsdmTransferUsers(address, maxPages = 400) {
  const users = new Set();
  const contract = normalizeAddress(address);
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  let transferCount = 0;
  let nextParams = { type: 'ERC-20' };

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchBlockscoutJson(`addresses/${address}/token-transfers`, nextParams);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) break;

    for (const item of items) {
      const tokenAddress = normalizeAddress(item?.token?.address_hash);
      if (tokenAddress !== USDM_TOKEN) continue;
      const timestampMs = parseApiTimestampMs(item?.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs) continue;
      transferCount += 1;
      const from = normalizeAddress(item?.from?.hash);
      const to = normalizeAddress(item?.to?.hash);
      if (from && from !== contract) users.add(from);
      if (to && to !== contract) users.add(to);
    }

    const lastTimestampMs = parseApiTimestampMs(items.at(-1)?.timestamp);
    if (!payload?.next_page_params || (Number.isFinite(lastTimestampMs) && lastTimestampMs < cutoffMs)) break;
    nextParams = { type: 'ERC-20', ...payload.next_page_params };
    await sleep(120);
  }

  return {
    users: users.size,
    transferCount,
  };
}

async function fetchTapTradingUserSnapshot(config) {
  const snapshotConfig = config.userSnapshot;
  if (!snapshotConfig?.type) return null;
  const fetchedAt = new Date().toISOString();

  if (snapshotConfig.type === 'miniblocks') {
    const stats = await fetchMiniblocksDappStats(snapshotConfig.dappId);
    if (!stats) return null;
    return {
      ...stats,
      timeframe: '24h',
      source: snapshotConfig.source,
      sourceUrl: snapshotConfig.sourceUrl,
      label: snapshotConfig.label,
      fetchedAt,
    };
  }

  if (snapshotConfig.type === 'blockscout-usdm-transfers') {
    const stats = await fetchRecentUsdmTransferUsers(config.contract);
    return {
      ...stats,
      timeframe: '24h',
      source: snapshotConfig.source,
      sourceUrl: snapshotConfig.sourceUrl,
      label: snapshotConfig.label,
      fetchedAt,
    };
  }

  return null;
}

async function fetchAllTokenHolders(address) {
  return fetchAllBlockscoutPages(`tokens/${address}/holders`);
}

const blockTimestampCache = new Map();

async function latestBlockNumber() {
  const latestHex = await rpc('eth_blockNumber');
  return parseInt(latestHex, 16);
}

async function getBlockTimestamp(blockNumber) {
  if (blockTimestampCache.has(blockNumber)) return blockTimestampCache.get(blockNumber);
  const block = await rpc('eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false]);
  const timestamp = parseInt(block.timestamp, 16);
  blockTimestampCache.set(blockNumber, timestamp);
  return timestamp;
}

async function findFirstBlockAtOrAfter(targetTimestamp, latestKnownBlock) {
  let low = 0;
  let high = latestKnownBlock;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const timestamp = await getBlockTimestamp(mid);
    if (timestamp < targetTimestamp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

async function fetchLogsInChunks(filter, chunkSize = 120000) {
  const logs = [];
  const minimumChunkSize = 250;
  const absoluteMinimumChunkSize = 1;
  const targetChunkSize = Math.max(minimumChunkSize, chunkSize);
  let currentChunkSize = targetChunkSize;
  let start = filter.fromBlock;
  let smallestChunkRetries = 0;

  while (start <= filter.toBlock) {
    const end = Math.min(filter.toBlock, start + currentChunkSize - 1);
    try {
      const chunkLogs = await rpc('eth_getLogs', [{
        address: filter.address,
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + end.toString(16),
        topics: filter.topics,
      }]);
      logs.push(...chunkLogs);
      start = end + 1;
      smallestChunkRetries = 0;
      if (currentChunkSize < targetChunkSize) {
        currentChunkSize = Math.min(targetChunkSize, currentChunkSize * 2);
      }
      await sleep(180);
    } catch (error) {
      if (currentChunkSize > minimumChunkSize) {
        currentChunkSize = Math.max(minimumChunkSize, Math.floor(currentChunkSize / 2));
        continue;
      }
      if (currentChunkSize > absoluteMinimumChunkSize) {
        currentChunkSize = Math.max(absoluteMinimumChunkSize, Math.floor(currentChunkSize / 2));
        continue;
      }
      smallestChunkRetries += 1;
      if (smallestChunkRetries >= 3) {
        throw new Error(`RPC eth_getLogs failed for blocks ${start}-${end}: ${error?.message || error}`);
      }
      await sleep(1500 * smallestChunkRetries);
    }
  }
  return logs;
}

function decodeTransferLog(log) {
  return {
    blockNumber: parseInt(log.blockNumber, 16),
    logIndex: parseInt(log.logIndex, 16),
    transactionHash: normalizeAddress(log.transactionHash),
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    amount: unitsToNumber(hexToBigInt(log.data), 18),
  };
}

async function processTapTradingDay(config, dateString, latestKnownBlock) {
  const fromTimestamp = dayStartUnix(dateString);
  const nextDayTimestamp = dayStartUnix(nextDateString(dateString));
  const fromBlock = await findFirstBlockAtOrAfter(fromTimestamp, latestKnownBlock);
  let toBlock = latestKnownBlock;
  const latestTimestamp = await getBlockTimestamp(latestKnownBlock);
  if (nextDayTimestamp <= latestTimestamp) {
    toBlock = Math.max(fromBlock, (await findFirstBlockAtOrAfter(nextDayTimestamp, latestKnownBlock)) - 1);
  }

  const contract = normalizeAddress(config.contract);
  const excludedCounterparties = new Set((config.excludedCounterparties || []).map(normalizeAddress));
  const contractTopic = topicAddress(contract);
  const incomingLogs = await fetchLogsInChunks({
    address: USDM_TOKEN,
    fromBlock,
    toBlock,
    topics: [ERC20_TRANSFER_TOPIC, null, contractTopic],
  });
  const outgoingLogs = await fetchLogsInChunks({
    address: USDM_TOKEN,
    fromBlock,
    toBlock,
    topics: [ERC20_TRANSFER_TOPIC, contractTopic],
  });

  const seen = new Set();
  const merged = [...incomingLogs, ...outgoingLogs]
    .map(decodeTransferLog)
    .filter((entry) => {
      const key = `${entry.transactionHash}:${entry.logIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex || left.transactionHash.localeCompare(right.transactionHash));

  const txHashes = new Set();
  const users = new Set();
  const deltas = new Map();
  let volumeUsdm = 0;
  let excludedCollateralInUsdm = 0;
  let excludedPayoutOutUsdm = 0;

  for (const entry of merged) {
    txHashes.add(entry.transactionHash);
    if (entry.to === contract && !excludedCounterparties.has(entry.from)) {
      volumeUsdm += entry.amount;
      users.add(entry.from);
      const current = deltas.get(entry.from) || { stakedUsdm: 0, paidUsdm: 0 };
      current.stakedUsdm += entry.amount;
      deltas.set(entry.from, current);
    }
    if (entry.from === contract && !excludedCounterparties.has(entry.to)) {
      users.add(entry.to);
      const current = deltas.get(entry.to) || { stakedUsdm: 0, paidUsdm: 0 };
      current.paidUsdm += entry.amount;
      deltas.set(entry.to, current);
    }
    if (entry.to === contract && excludedCounterparties.has(entry.from)) {
      excludedCollateralInUsdm += entry.amount;
    }
    if (entry.from === contract && excludedCounterparties.has(entry.to)) {
      excludedPayoutOutUsdm += entry.amount;
    }
  }

  return {
    date: dateString,
    txCount: txHashes.size,
    transferCount: merged.length,
    volumeUsdm: round(volumeUsdm, 6),
    users: users.size,
    excludedCollateralInUsdm: round(excludedCollateralInUsdm, 6),
    excludedPayoutOutUsdm: round(excludedPayoutOutUsdm, 6),
    deltas: Array.from(deltas.entries()).map(([address, totals]) => ({
      address,
      stakedUsdm: round(totals.stakedUsdm, 6),
      paidUsdm: round(totals.paidUsdm, 6),
    })),
    entries: merged,
  };
}

function buildTapTradingFees(entries, feeLedger, config) {
  const contract = normalizeAddress(config.contract);
  const excludedCounterparties = new Set((config.excludedCounterparties || []).map(normalizeAddress));
  const tradeFeePct = safeNumber(config.tradeFeePct);
  const profitFeePct = safeNumber(config.profitFeePct);
  const principalPct = Math.max(0, 1 - tradeFeePct);
  const profitFeeFactor = profitFeePct > 0 && profitFeePct < 1 ? (profitFeePct / (1 - profitFeePct)) : 0;
  let tradeFeeUsdm = 0;
  let profitFeeUsdm = 0;
  let grossProfitUsdm = 0;
  let netProfitPaidUsdm = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.to === contract && !excludedCounterparties.has(entry.from)) {
      const address = normalizeAddress(entry.from);
      const nextPrincipal = safeNumber(feeLedger.get(address)) + (entry.amount * principalPct);
      tradeFeeUsdm += entry.amount * tradeFeePct;
      feeLedger.set(address, nextPrincipal);
      continue;
    }
    if (entry.from === contract && !excludedCounterparties.has(entry.to)) {
      const address = normalizeAddress(entry.to);
      const currentPrincipal = safeNumber(feeLedger.get(address));
      const principalReturned = Math.min(currentPrincipal, entry.amount);
      const netProfitPaid = Math.max(0, entry.amount - principalReturned);
      const nextPrincipal = Math.max(0, currentPrincipal - principalReturned);
      const profitFee = netProfitPaid * profitFeeFactor;
      netProfitPaidUsdm += netProfitPaid;
      profitFeeUsdm += profitFee;
      grossProfitUsdm += netProfitPaid + profitFee;
      if (nextPrincipal > 0.0000001) feeLedger.set(address, nextPrincipal);
      else feeLedger.delete(address);
    }
  }

  return {
    tradeFeeUsdm: round(tradeFeeUsdm, 6),
    profitFeeUsdm: round(profitFeeUsdm, 6),
    totalFeeUsdm: round(tradeFeeUsdm + profitFeeUsdm, 6),
    grossProfitUsdm: round(grossProfitUsdm, 6),
    netProfitPaidUsdm: round(netProfitPaidUsdm, 6),
  };
}

function buildTapTradingBands(ledgerRows, bandColors) {
  const definitions = [
    ['loss', 'Loss', (net) => net < 0],
    ['flat', 'Break-even', (net) => net === 0],
    ['gain-small', '0-1 USDM', (net) => net > 0 && net < 1],
    ['gain-mid', '1-5 USDM', (net) => net >= 1 && net < 5],
    ['gain-high', '5-25 USDM', (net) => net >= 5 && net < 25],
    ['gain-whale', '25+ USDM', (net) => net >= 25],
  ];

  return definitions.map(([key, label, predicate]) => {
    const rows = ledgerRows.filter((row) => predicate(round(row.netUsdm, 6)));
    return {
      key,
      label,
      count: rows.length,
      netUsdm: round(sum(rows.map((row) => row.netUsdm)), 6),
      color: bandColors[key],
    };
  });
}

async function updateTapTradingData(current = {}, config) {
  const today = currentDateString();
  const latestKnownBlock = await latestBlockNumber();
  const counters = await fetchBlockscoutAddressCounters(config.contract);

  const minimumBackfillStart = Number(config.minimumBackfillDays) > 0
    ? daysAgoDateString(Math.max(0, Number(config.minimumBackfillDays) - 1))
    : null;
  const currentPoints = Array.isArray(current.volume?.points) ? current.volume.points : [];
  const earliestTrackedDate = currentPoints[0]?.date || null;
  const needsMinimumBackfill = Boolean(
    minimumBackfillStart
    && (!currentPoints.length || currentPoints.length < Number(config.minimumBackfillDays) || String(earliestTrackedDate) > minimumBackfillStart)
  );
  const rebuildRecentWindow = needsMinimumBackfill;

  const hasIncrementalState = !rebuildRecentWindow && Array.isArray(current.playerLedger) && current.sync?.lastSyncedDate;
  const initialBackfillDate = config.initialBackfillDate === 'today' ? today : (config.initialBackfillDate || config.launchDate);
  const pointStartDate = rebuildRecentWindow
    ? laterDate(config.launchDate || initialBackfillDate, minimumBackfillStart)
    : hasIncrementalState
    ? current.sync.lastSyncedDate
    : initialBackfillDate;
  const currentFeePoints = Array.isArray(current.fees?.points) ? current.fees.points : [];
  const earliestTrackedFeeDate = currentFeePoints[0]?.date || null;
  const feeReportStartDate = config.feeReportStartDate ? laterDate(config.launchDate, config.feeReportStartDate) : null;
  const feeWarmupStartDate = feeReportStartDate ? laterDate(config.launchDate, config.feeWarmupStartDate || config.launchDate) : null;
  const hasIncrementalFeeState = Boolean(
    feeReportStartDate
    && Array.isArray(current.feeLedger)
    && current.fees?.syncLastProcessedDate
  );
  const needsFeeBackfill = Boolean(
    feeReportStartDate
    && (!hasIncrementalFeeState || !currentFeePoints.length || String(earliestTrackedFeeDate) > feeReportStartDate)
  );
  const feeStartDate = !feeReportStartDate
    ? null
    : needsFeeBackfill
    ? feeWarmupStartDate
    : current.fees.syncLastProcessedDate;
  const processingStartDate = earlierDate(pointStartDate, feeStartDate);
  const datesToProcess = processingStartDate > today ? [] : enumerateDates(processingStartDate, today);

  let points = hasIncrementalState ? [...(current.volume?.points || [])] : [];
  let userPoints = hasIncrementalState ? [...(current.users?.points || [])] : [];
  let ledger = hasIncrementalState
    ? new Map(current.playerLedger.map((row) => [normalizeAddress(row.address), { stakedUsdm: safeNumber(row.stakedUsdm), paidUsdm: safeNumber(row.paidUsdm) }]))
    : new Map();
  let feePoints = hasIncrementalFeeState && !needsFeeBackfill ? [...currentFeePoints] : [];
  let feeLedger = hasIncrementalFeeState && !needsFeeBackfill
    ? new Map(current.feeLedger.map((row) => [normalizeAddress(row.address), safeNumber(row.openPrincipalUsdm)]))
    : new Map();
  let excludedCollateralInUsdm = hasIncrementalState ? safeNumber(current.volume?.excludedCollateralInUsdm ?? current.volume?.poolCollateralInUsdm) : 0;
  let excludedPayoutOutUsdm = hasIncrementalState ? safeNumber(current.volume?.excludedPayoutOutUsdm ?? current.volume?.poolPayoutOutUsdm) : 0;

  if (rebuildRecentWindow) {
    points = [];
    userPoints = [];
    ledger = new Map();
    excludedCollateralInUsdm = 0;
    excludedPayoutOutUsdm = 0;
  }

  for (const dateString of datesToProcess) {
    const daily = await processTapTradingDay(config, dateString, latestKnownBlock);
    if (dateString >= pointStartDate) {
      points = upsertDatePoint(points, {
        date: daily.date,
        volumeUsdm: round(daily.volumeUsdm, 6),
        txCount: daily.txCount,
        transferCount: daily.transferCount,
      });
      userPoints = upsertDatePoint(userPoints, {
        date: daily.date,
        users: daily.users,
      });
      excludedCollateralInUsdm += daily.excludedCollateralInUsdm;
      excludedPayoutOutUsdm += daily.excludedPayoutOutUsdm;
      for (const delta of daily.deltas) {
        const address = normalizeAddress(delta.address);
        const currentTotals = ledger.get(address) || { stakedUsdm: 0, paidUsdm: 0 };
        currentTotals.stakedUsdm += delta.stakedUsdm;
        currentTotals.paidUsdm += delta.paidUsdm;
        ledger.set(address, currentTotals);
      }
    }
      if (feeReportStartDate && dateString >= feeWarmupStartDate) {
        const dailyFees = buildTapTradingFees(daily.entries, feeLedger, config);
        if (dateString >= feeReportStartDate) {
          feePoints = upsertDatePoint(feePoints, {
            date: daily.date,
            tradeFeeUsdm: dailyFees.tradeFeeUsdm,
            profitFeeUsdm: dailyFees.profitFeeUsdm,
            totalFeeUsdm: dailyFees.totalFeeUsdm,
            grossProfitUsdm: dailyFees.grossProfitUsdm,
            netProfitPaidUsdm: dailyFees.netProfitPaidUsdm,
            txCount: daily.txCount,
            transferCount: daily.transferCount,
          });
        }
    }
  }

  const sortedPoints = points.sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const sortedUserPoints = userPoints.sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const sortedFeePoints = feePoints.sort((left, right) => String(left.date).localeCompare(String(right.date)));
  let last24hUsers = null;
  try {
    last24hUsers = await fetchTapTradingUserSnapshot(config);
  } catch (error) {
    console.warn(`[refresh] ${config.name} 24h user snapshot failed:`, error.message);
    last24hUsers = current.users?.last24h || null;
  }
  const latestPoint = sortedPoints.at(-1) || { txCount: 0, transferCount: 0, volumeUsdm: 0 };
  const ledgerRows = Array.from(ledger.entries())
    .map(([address, totals]) => {
      const stakedUsdm = round(totals.stakedUsdm, 6);
      const paidUsdm = round(totals.paidUsdm, 6);
      return {
        address,
        stakedUsdm,
        paidUsdm,
        netUsdm: round(paidUsdm - stakedUsdm, 6),
      };
    })
    .sort((left, right) => right.netUsdm - left.netUsdm || left.address.localeCompare(right.address));

  const profitable = ledgerRows.filter((row) => row.netUsdm > 0).length;
  const playersTotal = ledgerRows.length;
  const profitablePct = playersTotal ? (profitable / playersTotal) * 100 : 0;
  const totalTokenTransfers = safeNumber(counters.token_transfers_count);
  const totalTransactions = safeNumber(counters.transactions_count);
  const sinceLaunchTokenTransfers = config.sinceLaunchMode === 'counter'
    ? totalTokenTransfers
    : sum(sortedPoints.map((point) => point.transferCount));
  const sinceLaunchTransactions = config.sinceLaunchMode === 'counter'
    ? totalTransactions
    : sum(sortedPoints.map((point) => point.txCount));
  const feeTotals = feeReportStartDate
    ? {
        tradeFeeUsdm: round(sum(sortedFeePoints.map((point) => point.tradeFeeUsdm)), 6),
        profitFeeUsdm: round(sum(sortedFeePoints.map((point) => point.profitFeeUsdm)), 6),
        totalFeeUsdm: round(sum(sortedFeePoints.map((point) => point.totalFeeUsdm)), 6),
        grossProfitUsdm: round(sum(sortedFeePoints.map((point) => point.grossProfitUsdm)), 6),
        netProfitPaidUsdm: round(sum(sortedFeePoints.map((point) => point.netProfitPaidUsdm)), 6),
      }
    : null;

  return {
    ...current,
    fetchedAt: new Date().toISOString(),
    contract: config.contract,
    contractUrl: `https://megaeth.blockscout.com/address/${config.contract}`,
    token: 'USDM',
    officialLaunchUtc: `${config.launchDate}T00:00:00Z`,
    dataWindowUtc: {
      from: `${today}T00:00:00Z`,
      to: new Date().toISOString(),
    },
    source: 'MegaETH Blockscout counters + MegaETH RPC ERC-20 Transfer logs',
    methodology: config.methodology,
    transactions: {
      total: totalTransactions,
      today: safeNumber(latestPoint.txCount),
      sinceLaunchTransactions: safeNumber(sinceLaunchTransactions),
      totalTokenTransfers,
      tokenTransfersToday: safeNumber(latestPoint.transferCount),
      sinceLaunchTokenTransfers: safeNumber(sinceLaunchTokenTransfers),
    },
    volume: {
      todayUsdm: round(latestPoint.volumeUsdm, 6),
      excludedCollateralInUsdm: round(excludedCollateralInUsdm, 6),
      excludedPayoutOutUsdm: round(excludedPayoutOutUsdm, 6),
      poolCollateralInUsdm: round(excludedCollateralInUsdm, 6),
      poolPayoutOutUsdm: round(excludedPayoutOutUsdm, 6),
      points: sortedPoints,
    },
    users: {
      ...(last24hUsers ? { last24h: last24hUsers } : {}),
      points: sortedUserPoints,
    },
    players: {
      total: playersTotal,
      profitable,
      notProfitable: Math.max(0, playersTotal - profitable),
      profitablePct: round(profitablePct, 2),
      notProfitablePct: round(100 - profitablePct, 2),
      bands: buildTapTradingBands(ledgerRows, config.bandColors),
      top: ledgerRows.filter((row) => row.netUsdm > 0).slice(0, 10),
    },
    ...(feeReportStartDate ? {
      fees: {
        reportStartDate: feeReportStartDate,
        methodology: config.feeMethodology,
        tradeFeePct: safeNumber(config.tradeFeePct),
        profitFeePct: safeNumber(config.profitFeePct),
        points: sortedFeePoints,
        totals: feeTotals,
        syncLastProcessedDate: today,
      },
      feeLedger: Array.from(feeLedger.entries())
        .map(([address, openPrincipalUsdm]) => ({
          address,
          openPrincipalUsdm: round(openPrincipalUsdm, 6),
        }))
        .filter((row) => row.openPrincipalUsdm > 0),
    } : {}),
    playerLedger: ledgerRows,
    sync: {
      lastSyncedDate: today,
      latestBlock: latestKnownBlock,
    },
  };
}

async function updateEuphoriaData(current) {
  return updateTapTradingData(current, TAP_TRADING_APPS.euphoria);
}

async function updateHitoneData(current) {
  return updateTapTradingData(current, TAP_TRADING_APPS.hitone);
}

function findBrixTokenAddress(tokensData, role, fallback) {
  return normalizeAddress(tokensData?.tokens?.find((token) => token.role === role)?.address || fallback);
}

async function fetchBrixDashboard() {
  const payload = await fetchJson('https://accountable.brix.money:8443/dashboard');
  return payload.data;
}

async function fetchSofrRate(existing) {
  try {
    const csv = await fetchText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=SOFR30DAYAVG', { timeoutMs: 90000 });
    const lines = csv.trim().split(/\r?\n/).filter(Boolean);
    const lastLine = [...lines].reverse().find((line) => !line.endsWith(',.') && !line.endsWith(',NaN'));
    if (!lastLine) return existing;
    const [date, value] = lastLine.split(',');
    const rate = safeNumber(value) / 100;
    if (!Number.isFinite(rate) || rate <= 0) return existing;
    return {
      rate,
      asOf: date,
      seriesId: 'SOFR30DAYAVG',
    };
  } catch {
    return existing;
  }
}

function buildBrixHolderTiers(holders, worldMarketsAddress, current) {
  const decimals = 18;
  const rows = holders.map((holder) => ({
    address: normalizeAddress(holder.address?.hash),
    isContract: Boolean(holder.address?.is_contract),
    balance: unitsToNumber(holder.value, decimals),
  })).filter((holder) => holder.balance > 0);

  const rawHolderCount = rows.length;
  const included = rows.filter((holder) => !holder.isContract || holder.address === worldMarketsAddress);
  const totalBalance = sum(included.map((holder) => holder.balance));
  const holderCount = included.length;
  const worldMarkets = included.find((holder) => holder.address === worldMarketsAddress);
  const tierColors = Object.fromEntries((current.holderTiers?.tiers || []).map((tier) => [tier.label, tier.color]));
  const nonWorld = included.filter((holder) => holder.address !== worldMarketsAddress);

  const makeTier = (label, min, max) => {
    const tierHolders = nonWorld.filter((holder) => holder.balance >= min && (max == null || holder.balance < max));
    const balance = sum(tierHolders.map((holder) => holder.balance));
    return {
      label,
      min,
      max,
      count: tierHolders.length,
      balance: round(balance, 6),
      countSharePct: holderCount ? (tierHolders.length / holderCount) * 100 : 0,
      balanceSharePct: totalBalance ? (balance / totalBalance) * 100 : 0,
      color: tierColors[label] || '#6b7280',
    };
  };

  const tiers = [];
  if (worldMarkets) {
    tiers.push({
      label: 'World Markets',
      min: null,
      max: null,
      count: 1,
      balance: round(worldMarkets.balance, 6),
      countSharePct: holderCount ? (1 / holderCount) * 100 : 0,
      balanceSharePct: totalBalance ? (worldMarkets.balance / totalBalance) * 100 : 0,
      color: tierColors['World Markets'] || '#f97357',
    });
  }

  tiers.push(makeTier('Whales', 10_000_000, null));
  tiers.push(makeTier('Dolphins', 1_000_000, 10_000_000));
  tiers.push(makeTier('Fish', 100_000, 1_000_000));
  tiers.push(makeTier('Crabs', 10_000, 100_000));
  tiers.push(makeTier('Shrimp', 0, 10_000));

  return {
    token: 'WITRY',
    tokenAddress: current.holderTiers?.tokenAddress,
    sourceUrl: current.holderTiers?.sourceUrl,
    rawHolderCount,
    holderCount,
    excludedContractCount: Math.max(0, rawHolderCount - holderCount),
    totalBalance: round(totalBalance, 6),
    worldMarkets: {
      address: worldMarketsAddress,
      balance: round(worldMarkets?.balance || 0, 6),
    },
    tiers,
  };
}

function buildBrixApySnapshot(stakingPoints, tryUsdPoints, currentPps) {
  const recent = keepLast(stakingPoints, 7);
  const coveredDays = recent.reduce((total, point) => total + safeNumber(point.periodDays, 1), 0) || 1;
  const compoundedReturn = recent.reduce((product, point) => product * (1 + safeNumber(point.periodReturn, 0)), 1) - 1;
  const stakingApy = annualizeReturn(compoundedReturn, coveredDays);
  const stakingApr = (compoundedReturn / coveredDays) * 365;
  const sortedFx = [...tryUsdPoints].sort((left, right) => safeNumber(left.timestamp) - safeNumber(right.timestamp));
  const fxStart = recent.length ? sortedFx.find((point) => point.timestamp === dayEndTimestamp(recent[0].periodStartDate))?.value ?? sortedFx.at(-Math.max(recent.length + 1, 2))?.value : 0;
  const fxEnd = sortedFx.at(-1)?.value || 0;
  const tryUsdApy = fxStart > 0 && fxEnd > 0 ? annualizeReturn((fxEnd / fxStart) - 1, coveredDays) : 0;
  return {
    stakingApy,
    stakingApr,
    coveredDays,
    distributionsUsed: recent.length,
    periodStartDate: recent[0]?.periodStartDate || currentDateString(),
    periodEndDate: recent.at(-1)?.distributionDate || currentDateString(),
    lastDistributionDate: recent.at(-1)?.distributionDate || currentDateString(),
    tryUsdApy,
    realYield: stakingApy - Math.abs(tryUsdApy),
    currentPps,
  };
}

async function updateBrixData(current, tokensData) {
  const today = currentDateString();
  const nowIso = new Date().toISOString();
  const currentWitryAddress = findBrixTokenAddress(tokensData, 'current_witry_candidate', current.holderTiers?.tokenAddress);
  const dashboard = await fetchBrixDashboard();
  const witryToken = await fetchBlockscoutToken(currentWitryAddress);
  const holders = await fetchAllTokenHolders(currentWitryAddress);
  const sofrRate = await fetchSofrRate(current.sofrRate);
  const pps = safeNumber(dashboard.pps, safeNumber(current.price?.ratio));
  const witryUsd = safeNumber(witryToken.exchange_rate, safeNumber(current.price?.usd));
  const tryUsd = pps > 0 && witryUsd > 0 ? witryUsd / pps : safeNumber(current.price?.tryUsd);
  const supply = safeNumber(dashboard.reserves?.total_supply?.value, safeNumber(dashboard.reserves?.timeline?.at(-1)?.supply, safeNumber(current.itryMarketCap?.supply)));
  const marketCapUsd = supply * tryUsd;
  const currentDayTimestamp = dayEndTimestamp(today);

  let tryUsdSeries = upsertTimestampPoint(current.tryUsdSeries?.points || [], {
    timestamp: currentDayTimestamp,
    value: round(tryUsd, 12),
  });
  tryUsdSeries = keepLast(tryUsdSeries, 60);

  let witryRateSeries = upsertTimestampPoint(current.witryRateSeries?.points || [], {
    timestamp: currentDayTimestamp,
    value: round(pps, 12),
  });
  witryRateSeries = keepLast(witryRateSeries, 60);

  const previousPpsPoint = [...witryRateSeries].filter((point) => safeNumber(point.timestamp) < currentDayTimestamp).at(-1);
  const periodReturn = previousPpsPoint?.value > 0 ? (pps / previousPpsPoint.value) - 1 : 0;

  let stakingYieldPoints = upsertDatePoint(current.stakingYield?.points || [], {
    distributionId: `fundamental-${today}`,
    distributionDate: today,
    periodStartDate: nextDateString(today) === today ? today : new Date(Date.parse(`${today}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10),
    periodEndDate: today,
    periodDays: 1,
    stakingYieldItry: 0,
    netYieldItry: 0,
    additionalYieldItry: 0,
    averageStakedItry: null,
    periodReturn: round(periodReturn, 12),
    apy: round(annualizeReturn(periodReturn, 1), 12),
  });
  stakingYieldPoints = keepLast(stakingYieldPoints, 30);

  const apySnapshot = buildBrixApySnapshot(stakingYieldPoints, tryUsdSeries, pps);
  const worldMarketsAddress = normalizeAddress(current.holderTiers?.worldMarkets?.address || WORLD_EXCHANGE);
  const holderTiers = buildBrixHolderTiers(holders, worldMarketsAddress, current);
  const locked = safeNumber(dashboard.reserves?.tokens_split?.wiTRY_value, safeNumber(current.stakeRatio?.locked));
  const totalStakedItry = locked;
  const totalStakingYieldItry = Math.max(0, locked - safeNumber(dashboard.reserves?.tokens_split?.wiTRY));

  return {
    ...current,
    itryMarketCap: {
      usd: round(marketCapUsd, 6),
      supply: round(supply, 6),
      tryUsd: round(tryUsd, 12),
      asOf: nowIso,
    },
    price: {
      usd: round(witryUsd, 12),
      ratio: round(pps, 12),
      tryUsd: round(tryUsd, 12),
      asOf: nowIso,
    },
    tryUsdSeries: {
      points: tryUsdSeries,
      asOf: new Date(currentDayTimestamp).toISOString(),
      windowDays: tryUsdSeries.length,
    },
    stakingYield: {
      ...current.stakingYield,
      points: stakingYieldPoints,
      totalItry: round(totalStakingYieldItry, 6),
      windowStart: stakingYieldPoints[0]?.distributionDate || today,
      windowEnd: stakingYieldPoints.at(-1)?.distributionDate || today,
      windowDays: stakingYieldPoints.length,
    },
    apySnapshot: {
      stakingApy: round(apySnapshot.stakingApy, 12),
      stakingApr: round(apySnapshot.stakingApr, 12),
      totalStakedItry: round(totalStakedItry, 6),
      totalStakingYieldItry: round(totalStakingYieldItry, 6),
      distributionsUsed: apySnapshot.distributionsUsed,
      coveredDays: apySnapshot.coveredDays,
      periodStartDate: apySnapshot.periodStartDate,
      periodEndDate: apySnapshot.periodEndDate,
      lastDistributionDate: apySnapshot.lastDistributionDate,
    },
    sofrRate,
    stakeRatio: {
      ratio: supply > 0 ? round(locked / supply, 12) : 0,
      locked: round(locked, 6),
      supply: round(supply, 6),
      asOf: nowIso,
    },
    witryRateSeries: {
      points: witryRateSeries,
      windowDays: witryRateSeries.length,
    },
    holderTiers,
    asOf: nowIso,
  };
}

function normalizeDefiLlamaChart(chart) {
  return (Array.isArray(chart) ? chart : [])
    .map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        return { timestamp: safeNumber(entry[0]) * 1000, value: safeNumber(entry[1]) };
      }
      if (entry && typeof entry === 'object') {
        return { timestamp: safeNumber(entry.date || entry.timestamp) * (String(entry.date || entry.timestamp).length <= 10 ? 1000 : 1), value: safeNumber(entry.value || entry.totalLiquidityUSD || entry.totalLiquidityUsd) };
      }
      return null;
    })
    .filter((entry) => entry && entry.timestamp > 0);
}

function buildWorldTokenColorMap(current) {
  const map = new Map();
  for (const row of current.spotTvl?.tokens || []) map.set(row.symbol, row.color);
  for (const row of current.lending?.tokens || []) map.set(row.symbol, row.color);
  for (const row of current.perps?.volume?.markets || []) map.set(row.symbol, row.color);
  return map;
}

function buildWorldTokenRows(balanceRows, colorMap) {
  return (Array.isArray(balanceRows) ? balanceRows : [])
    .map((row) => {
      const symbol = row.token?.symbol;
      const decimals = safeNumber(row.token?.decimals, 18);
      const amount = unitsToNumber(row.value, decimals);
      const priceUsd = safeNumber(row.token?.exchange_rate);
      const usd = amount * priceUsd;
      return {
        symbol,
        amount: round(amount, 12),
        priceUsd: round(priceUsd, 12),
        usd: round(usd, 12),
        address: row.token?.address_hash,
        color: colorMap.get(symbol) || WORLD_COLOR_FALLBACKS[symbol] || '#9AA7C2',
      };
    })
    .filter((row) => row.symbol && row.usd > 1)
    .sort((left, right) => right.usd - left.usd);
}

function scaleWorldVolumeShape(currentVolume, nextFees24h, latestBlock) {
  const previousNotional = safeNumber(currentVolume?.notional24hUsd);
  const previousFees = safeNumber(currentVolume?.feesUsdFromLogs);
  if (previousNotional <= 0 || previousFees <= 0 || nextFees24h <= 0) {
    return currentVolume;
  }
  const feeRate = previousFees / previousNotional;
  const nextNotional = nextFees24h / feeRate;
  const scale = previousNotional > 0 ? nextNotional / previousNotional : 1;
  return {
    ...currentVolume,
    source: 'Daily 24h notional is refreshed from DefiLlama perps fees using the last observed on-chain fee-rate; hourly and market distributions keep the last full on-chain shape.',
    latestBlock,
    fromBlock: Math.max(0, latestBlock - 86400),
    notional24hUsd: round(nextNotional, 6),
    feesUsdFromLogs: round(nextFees24h, 6),
    estimatedFromFees: true,
    markets: (currentVolume.markets || []).map((market) => ({
      ...market,
      notionalUsd: round(safeNumber(market.notionalUsd) * scale, 6),
      rawVolume: round(safeNumber(market.rawVolume) * scale, 6),
    })),
    hourlyNotional: (currentVolume.hourlyNotional || []).map((point) => ({
      ...point,
      value: round(safeNumber(point.value) * scale, 6),
    })),
  };
}

async function updateWorldMarketsData(current) {
  const nowIso = new Date().toISOString();
  const today = currentDateString();
  const colorMap = buildWorldTokenColorMap(current);

  const [protocolSpot, exchangeBalances, spotVolumeSummary, spotFeesSummary, perpsFeesSummary] = await Promise.all([
    fetchJson('https://api.llama.fi/protocol/world-markets-spot'),
    fetchBlockscoutAddressTokenBalances(WORLD_EXCHANGE),
    fetchJson('https://api.llama.fi/summary/dexs/world-markets-spot?dataType=dailyVolume'),
    fetchJson('https://api.llama.fi/summary/fees/world-markets-spot?dataType=dailyFees'),
    fetchJson('https://api.llama.fi/summary/fees/world-markets-perps?dataType=dailyFees'),
  ]);

  const latestBlock = await latestBlockNumber();
  const spotTokens = buildWorldTokenRows(exchangeBalances, colorMap).slice(0, 8);
  const blockscoutLiveUsd = round(sum(spotTokens.map((row) => row.usd)), 6);
  const defillamaCurrentUsd = safeNumber(protocolSpot.currentChainTvls?.MegaETH, safeNumber(current.spotTvl?.defillamaCurrentUsd));
  const spotHistory = keepLast(upsertTimestampPoint(current.spotTvl?.history || [], {
    timestamp: dayEndTimestamp(today),
    value: round(defillamaCurrentUsd, 6),
  }), 30);

  const spotVolumeDaily = normalizeDefiLlamaChart(spotVolumeSummary.totalDataChart);
  const spotFeesDaily = normalizeDefiLlamaChart(spotFeesSummary.totalDataChart);
  const perpsFeesDaily = normalizeDefiLlamaChart(perpsFeesSummary.totalDataChart);
  const refreshedPerpsVolume = scaleWorldVolumeShape(current.perps?.volume || {}, safeNumber(perpsFeesSummary.total24h), latestBlock);

  const updated = {
    ...current,
    spotTvl: {
      ...current.spotTvl,
      asOf: nowIso,
      defillamaCurrentUsd: round(defillamaCurrentUsd, 6),
      blockscoutLiveUsd,
      history: spotHistory,
      tokens: spotTokens,
    },
    spotVolume: {
      ...current.spotVolume,
      total24hUsd: round(safeNumber(spotVolumeSummary.total24h), 6),
      total48hto24hUsd: round(safeNumber(spotVolumeSummary.total48hto24h), 6),
      total7dUsd: round(safeNumber(spotVolumeSummary.total7d), 6),
      total30dUsd: round(safeNumber(spotVolumeSummary.total30d), 6),
      totalAllTimeUsd: round(safeNumber(spotVolumeSummary.totalAllTime), 6),
      daily: spotVolumeDaily,
    },
    perps: {
      ...current.perps,
      volume: refreshedPerpsVolume,
      fees: {
        ...current.perps?.fees,
        total24hUsd: round(safeNumber(perpsFeesSummary.total24h), 6),
        total48hto24hUsd: round(safeNumber(perpsFeesSummary.total48hto24h), 6),
        total7dUsd: round(safeNumber(perpsFeesSummary.total7d), 6),
        total30dUsd: round(safeNumber(perpsFeesSummary.total30d), 6),
        totalAllTimeUsd: round(safeNumber(perpsFeesSummary.totalAllTime), 6),
        daily: perpsFeesDaily,
      },
    },
    spotFees: {
      ...current.spotFees,
      total24hUsd: round(safeNumber(spotFeesSummary.total24h), 6),
      total48hto24hUsd: round(safeNumber(spotFeesSummary.total48hto24h), 6),
      total7dUsd: round(safeNumber(spotFeesSummary.total7d), 6),
      total30dUsd: round(safeNumber(spotFeesSummary.total30d), 6),
      totalAllTimeUsd: round(safeNumber(spotFeesSummary.totalAllTime), 6),
      daily: spotFeesDaily,
    },
    tokenPrices: {
      ...(current.tokenPrices || {}),
      ...Object.fromEntries(spotTokens.map((row) => [row.symbol, row.priceUsd])),
    },
    asOf: nowIso,
  };

  const lendingRows = [];
  for (const orderbook of current.lending?.lendOrderbooks || []) {
    try {
      const balances = await fetchBlockscoutAddressTokenBalances(orderbook.address);
      for (const row of buildWorldTokenRows(balances, colorMap)) {
        lendingRows.push(row);
      }
    } catch {
      // Keep the last good lending snapshot if the orderbook balance lookup is empty or unavailable.
    }
  }

  if (lendingRows.length) {
    const grouped = new Map();
    for (const row of lendingRows) {
      const currentRow = grouped.get(row.symbol) || { ...row, amount: 0, usd: 0 };
      currentRow.amount += row.amount;
      currentRow.usd += row.usd;
      currentRow.priceUsd = row.priceUsd;
      grouped.set(row.symbol, currentRow);
    }
    const tokens = Array.from(grouped.values()).sort((left, right) => right.usd - left.usd).map((row) => ({
      symbol: row.symbol,
      amount: round(row.amount, 12),
      priceUsd: row.priceUsd,
      usd: round(row.usd, 12),
      color: row.color,
    }));
    updated.lending = {
      ...current.lending,
      tvlUsd: round(sum(tokens.map((row) => row.usd)), 6),
      tokens,
      source: 'Token balances from World lending orderbooks when available; counters stay anchored to the last full on-chain lending scan.',
    };
  }

  return updated;
}

async function main() {
  const writes = [];
  const updates = [];

  if (shouldRefresh('brix')) {
    updates.push((async () => {
      const [brixCurrent, brixTokens] = await Promise.all([
        readJson(BRIX_FILE),
        readJson(BRIX_TOKENS_FILE),
      ]);
      const nextBrix = await updateBrixData(brixCurrent, brixTokens).catch((error) => {
        console.warn('[refresh] Brix update failed, keeping previous snapshot:', error.message);
        return brixCurrent;
      });
      writes.push([BRIX_FILE, nextBrix]);
    })());
  }

  if (shouldRefresh('euphoria')) {
    updates.push((async () => {
      const euphoriaCurrent = await readJson(EUPHORIA_FILE);
      const nextEuphoria = await updateEuphoriaData(euphoriaCurrent).catch((error) => {
        console.warn('[refresh] Euphoria update failed, keeping previous snapshot:', error.message);
        return euphoriaCurrent;
      });
      writes.push([EUPHORIA_FILE, nextEuphoria]);
    })());
  }

  if (shouldRefresh('hitone')) {
    updates.push((async () => {
      const hitoneCurrent = await readJson(HITONE_FILE);
      const nextHitone = await updateHitoneData(hitoneCurrent).catch((error) => {
        console.warn('[refresh] HitOne update failed, keeping previous snapshot:', error?.stack || error?.message || error);
        return hitoneCurrent;
      });
      writes.push([HITONE_FILE, nextHitone]);
    })());
  }

  if (shouldRefresh('world-markets')) {
    updates.push((async () => {
      const worldCurrent = await readJson(WORLD_FILE);
      const nextWorld = await updateWorldMarketsData(worldCurrent).catch((error) => {
        console.warn('[refresh] World Markets update failed, keeping previous snapshot:', error.message);
        return worldCurrent;
      });
      writes.push([WORLD_FILE, nextWorld]);
    })());
  }

  await Promise.all(updates);

  await Promise.all(writes.map(([filePath, data]) => writeJson(filePath, data)));

  console.log('[refresh] Updated app dashboard snapshots.');
}

await main();
