/**
 * Federation — Human-readable agent addresses (SEP-0002)
 *
 * Maps agent names to Stellar addresses:
 *   atlas*mesh.agent → GABCDEF...
 *   sage*mesh.agent  → GHIJKL...
 *
 * In production, federation resolves via HTTPS (stellar.toml).
 * Here we maintain an in-memory federation server and resolver.
 */

export interface FederationRecord {
  stellar_address: string;
  account_id: string;
  memo_type?: string;
  memo?: string;
}

const FEDERATION_DOMAIN = 'mesh.agent';

class FederationServer {
  private nameToAddress: Map<string, string> = new Map();
  private addressToName: Map<string, string> = new Map();

  /**
   * Register a federation address: name*mesh.agent → G...
   */
  register(name: string, stellarAddress: string): void {
    const fedAddr = `${name.toLowerCase()}*${FEDERATION_DOMAIN}`;
    this.nameToAddress.set(fedAddr, stellarAddress);
    this.addressToName.set(stellarAddress, fedAddr);
  }

  /**
   * Resolve a federation address to a Stellar account
   */
  resolveByName(federationAddress: string): FederationRecord | null {
    const normalized = federationAddress.toLowerCase();
    const accountId = this.nameToAddress.get(normalized);
    if (!accountId) return null;
    return { stellar_address: normalized, account_id: accountId };
  }

  /**
   * Reverse resolve: Stellar address → federation name
   */
  resolveByAddress(stellarAddress: string): FederationRecord | null {
    const fedAddr = this.addressToName.get(stellarAddress);
    if (!fedAddr) return null;
    return { stellar_address: fedAddr, account_id: stellarAddress };
  }

  /**
   * Get all registered federation entries
   */
  list(): FederationRecord[] {
    return Array.from(this.nameToAddress.entries()).map(([addr, id]) => ({
      stellar_address: addr,
      account_id: id,
    }));
  }

  get domain(): string {
    return FEDERATION_DOMAIN;
  }

  get count(): number {
    return this.nameToAddress.size;
  }
}

const federation = new FederationServer();
export default federation;
export { FEDERATION_DOMAIN };
