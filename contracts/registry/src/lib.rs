#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceEntry {
    pub seller: Address,
    pub price: i128,
    pub capability: String,
    pub endpoint: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepEntry {
    pub tx_count: u32,
    pub success_count: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyEntry {
    pub per_tx_limit: i128,
    pub daily_limit: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Service(BytesN<32>),
    Reputation(Address),
    Policy(Address),
    ServiceList,
}

#[contract]
pub struct RegistryContract;

#[contractimpl]
impl RegistryContract {
    /// Register a new service in the registry.
    pub fn register_service(
        env: Env,
        service_id: BytesN<32>,
        seller: Address,
        price: i128,
        capability: String,
        endpoint: String,
    ) {
        seller.require_auth();

        let entry = ServiceEntry {
            seller: seller.clone(),
            price,
            capability,
            endpoint,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Service(service_id.clone()), &entry);

        // Maintain the list of all service IDs for discovery.
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::ServiceList)
            .unwrap_or(Vec::new(&env));

        // Avoid duplicates.
        let mut found = false;
        for i in 0..list.len() {
            if list.get(i).unwrap() == service_id {
                found = true;
                break;
            }
        }
        if !found {
            list.push_back(service_id.clone());
            env.storage()
                .persistent()
                .set(&DataKey::ServiceList, &list);
        }

        env.events()
            .publish((symbol_short!("SvcReg"),), service_id);
    }

    /// Retrieve a service entry by its ID.
    pub fn get_service(env: Env, service_id: BytesN<32>) -> ServiceEntry {
        env.storage()
            .persistent()
            .get(&DataKey::Service(service_id))
            .expect("service not found")
    }

    /// Discover services that match a given capability string.
    pub fn discover(env: Env, capability: String) -> Vec<BytesN<32>> {
        let list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::ServiceList)
            .unwrap_or(Vec::new(&env));

        let mut results: Vec<BytesN<32>> = Vec::new(&env);

        for i in 0..list.len() {
            let sid = list.get(i).unwrap();
            let entry: ServiceEntry = env
                .storage()
                .persistent()
                .get(&DataKey::Service(sid.clone()))
                .unwrap();
            if entry.capability == capability {
                results.push_back(sid);
            }
        }

        results
    }

    /// Update the reputation of an agent after a service interaction.
    pub fn update_reputation(env: Env, agent: Address, success: bool) {
        let key = DataKey::Reputation(agent.clone());
        let mut rep: RepEntry = env.storage().persistent().get(&key).unwrap_or(RepEntry {
            tx_count: 0,
            success_count: 0,
        });

        rep.tx_count += 1;
        if success {
            rep.success_count += 1;
        }

        env.storage().persistent().set(&key, &rep);

        env.events()
            .publish((symbol_short!("RepUpd"),), (agent, success));
    }

    /// Retrieve the reputation entry for an agent.
    pub fn get_reputation(env: Env, agent: Address) -> RepEntry {
        env.storage()
            .persistent()
            .get(&DataKey::Reputation(agent))
            .unwrap_or(RepEntry {
                tx_count: 0,
                success_count: 0,
            })
    }

    /// Set the spending policy for an agent. Requires the agent's authorization.
    pub fn set_spending_policy(env: Env, agent: Address, per_tx_limit: i128, daily_limit: i128) {
        agent.require_auth();

        let policy = PolicyEntry {
            per_tx_limit,
            daily_limit,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Policy(agent.clone()), &policy);
    }

    /// Check whether a spend amount is within the agent's policy limits.
    /// Emits a SpendingPolicyViolation event and returns false if the amount
    /// exceeds either the per-transaction limit or the daily limit.
    pub fn check_spend(env: Env, agent: Address, amount: i128) -> bool {
        let key = DataKey::Policy(agent.clone());
        let policy: Option<PolicyEntry> = env.storage().persistent().get(&key);

        match policy {
            None => true, // No policy set means no restrictions.
            Some(p) => {
                if amount > p.per_tx_limit || amount > p.daily_limit {
                    env.events().publish(
                        (symbol_short!("SpndVio"),),
                        (agent, amount),
                    );
                    false
                } else {
                    true
                }
            }
        }
    }

    /// Get the effective price for a service, applying a reputation-based discount.
    /// Discount formula: price * (100 - min(rep_percent, 20)) / 100
    /// where rep_percent = (success_count * 100) / tx_count (0 if tx_count == 0).
    pub fn get_effective_price(env: Env, service_id: BytesN<32>, buyer: Address) -> i128 {
        let entry: ServiceEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Service(service_id))
            .expect("service not found");

        let rep: RepEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Reputation(buyer))
            .unwrap_or(RepEntry {
                tx_count: 0,
                success_count: 0,
            });

        let rep_percent: i128 = if rep.tx_count == 0 {
            0
        } else {
            (rep.success_count as i128 * 100) / rep.tx_count as i128
        };

        let discount = if rep_percent > 20 { 20_i128 } else { rep_percent };

        let effective = entry.price * (100 - discount) / 100;

        env.events()
            .publish((symbol_short!("SvcDlvr"),), effective);

        effective
    }
}
