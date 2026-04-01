/**
 * SEP-24 Interactive Deposit/Withdrawal Client
 * 
 * Integrates with Stellar Anchors for fiat on/off-ramp.
 * Susan pays with credit card → USDC lands in her agent's wallet.
 * 
 * Flow:
 * 1. Fetch anchor's stellar.toml → get SEP-24 transfer server URL
 * 2. GET /info → confirm deposit is supported
 * 3. POST /transactions/deposit/interactive → get redirect URL
 * 4. Human completes deposit on anchor's site
 * 5. GET /transaction?id=... → poll for completion
 */

interface AnchorInfo {
  domain: string;
  transferServer: string;
  webAuthEndpoint?: string;
  signingKey?: string;
  assets: string[];
}

interface DepositResult {
  id: string;
  type: 'interactive';
  url: string;
  message: string;
}

interface TransactionStatus {
  id: string;
  status: 'pending_user_transfer_start' | 'pending_anchor' | 'pending_stellar' | 'completed' | 'error';
  amount_in?: string;
  amount_out?: string;
  stellar_transaction_id?: string;
  message?: string;
}

// Known mainnet anchors that support SEP-24
const KNOWN_ANCHORS: Record<string, string> = {
  'circle': 'circle.anchor.mykobo.co',
  'mykobo': 'mykobo.co',
  'anclap': 'api.anclap.com',
  'beans': 'beans.app',
  'ntokens': 'ntokens.com',
};

/**
 * Fetch and parse a Stellar anchor's TOML file
 */
async function fetchAnchorInfo(domain: string): Promise<AnchorInfo> {
  const url = `https://${domain}/.well-known/stellar.toml`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch stellar.toml from ${domain}: ${resp.status}`);
  
  const toml = await resp.text();
  
  // Simple TOML parsing for the fields we need
  const transferServer = extractTomlValue(toml, 'TRANSFER_SERVER_SEP0024') 
    || extractTomlValue(toml, 'TRANSFER_SERVER');
  const webAuth = extractTomlValue(toml, 'WEB_AUTH_ENDPOINT');
  const signingKey = extractTomlValue(toml, 'SIGNING_KEY');

  if (!transferServer) {
    throw new Error(`Anchor ${domain} does not publish a SEP-24 transfer server`);
  }

  // Extract supported assets
  const assetMatches = toml.match(/code\s*=\s*"([^"]+)"/g) || [];
  const assets = assetMatches.map(m => m.replace(/code\s*=\s*"/, '').replace('"', ''));

  return {
    domain,
    transferServer,
    webAuthEndpoint: webAuth ?? undefined,
    signingKey: signingKey ?? undefined,
    assets: [...new Set(assets)],
  };
}

/**
 * Get anchor's supported assets and deposit/withdraw info
 */
async function getAnchorAssets(transferServer: string): Promise<any> {
  const resp = await fetch(`${transferServer}/info`);
  if (!resp.ok) throw new Error(`Failed to get anchor info: ${resp.status}`);
  return resp.json();
}

/**
 * Initiate an interactive deposit — returns a URL for the human to complete
 */
async function initiateDeposit(
  transferServer: string,
  assetCode: string,
  account: string,  // Stellar address to receive funds
  amount?: string,
  authToken?: string,
): Promise<DepositResult> {
  const params = new URLSearchParams({
    asset_code: assetCode,
    account,
  });
  if (amount) params.set('amount', amount);

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const resp = await fetch(`${transferServer}/transactions/deposit/interactive`, {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Deposit initiation failed: ${resp.status} — ${err}`);
  }

  const data = await resp.json() as any;
  return {
    id: data.id,
    type: 'interactive',
    url: data.url,
    message: `Complete your deposit at: ${data.url}`,
  };
}

/**
 * Check the status of a deposit transaction
 */
async function checkTransaction(
  transferServer: string,
  txId: string,
  authToken?: string,
): Promise<TransactionStatus> {
  const headers: Record<string, string> = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const resp = await fetch(`${transferServer}/transaction?id=${txId}`, { headers });
  if (!resp.ok) throw new Error(`Transaction check failed: ${resp.status}`);
  
  const data = await resp.json() as any;
  return {
    id: data.transaction?.id ?? txId,
    status: data.transaction?.status ?? 'error',
    amount_in: data.transaction?.amount_in,
    amount_out: data.transaction?.amount_out,
    stellar_transaction_id: data.transaction?.stellar_transaction_id,
    message: data.transaction?.message,
  };
}

function extractTomlValue(toml: string, key: string): string | null {
  const regex = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm');
  const match = toml.match(regex);
  return match ? match[1] : null;
}

export {
  AnchorInfo,
  DepositResult,
  TransactionStatus,
  KNOWN_ANCHORS,
  fetchAnchorInfo,
  getAnchorAssets,
  initiateDeposit,
  checkTransaction,
};
