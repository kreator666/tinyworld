//! TinyWorld NEAR: soulbound DID identity (NEP-171 style) + equipment parts.
//!
//! 语义对齐 EVM 版 `contract/src/DIDIdentity.sol` + `DIDParts.sol` 以及
//! Solana 版 `solana/programs/tinyworld`。与 Solana 的机制差异：
//! - 无 PDA/ATA：身份与部件都是合约内 `store` 集合中的记录，按 key 直接寻址；
//! - 无账户租金模型：存储成本由合约自身余额承担，铸币费通过 attached deposit 收取；
//! - Soulbound 不需要代币扩展：NEP-171 的转账入口由合约自己控制，默认直接拒绝；
//! - NFT token_id 是递增整数（对齐 EVM 的 `_nextTokenId`），而非 mint 地址派生。

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LazyOption, LookupMap};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    Promise,
};

pub const MAX_NAME_LENGTH: usize = 64;
pub const SLOT_COUNT: usize = 4;
const ARWEAVE_ID_LENGTH: usize = 43;

pub const PERMISSION_PERSONA: u8 = 1 << 0;
pub const PERMISSION_SOCIAL: u8 = 1 << 1;
pub const PERMISSION_SKILL: u8 = 1 << 2;
const VALID_PERMISSIONS: u8 = PERMISSION_PERSONA | PERMISSION_SOCIAL | PERMISSION_SKILL;

const NFT_METADATA_SPEC: &str = "nft-1.0.0";

#[derive(BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, near_sdk::serde::Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// AI 人格配置指针，语义对齐 Solana Identity.persona_hash / persona_arweave_id。
#[derive(BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, near_sdk::serde::Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Persona {
    /// keccak256(persona JSON)，全 0 = 未设置。
    pub hash: [u8; 32],
    /// 43 位 base64url txid 或空串。
    pub arweave_id: String,
}

impl Default for Persona {
    fn default() -> Self {
        Self { hash: [0u8; 32], arweave_id: String::new() }
    }
}

/// 装备部件定义（等价 EVM PartInfo / Solana PartConfig）。
#[derive(BorshDeserialize, BorshSerialize, near_sdk::serde::Serialize, near_sdk::serde::Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct PartInfo {
    /// 0 头 / 1 身 / 2 配饰 / 3 宠物。
    pub slot: u8,
    pub rarity: u8,
    pub max_supply: u64,
    pub total_supply: u64,
    pub mintable: bool,
    pub registered: bool,
}

#[derive(near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TokenView {
    pub token_id: U64,
    pub owner_id: AccountId,
    pub metadata: Option<String>,
}

#[derive(near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AgentView {
    pub account_id: AccountId,
    pub permissions: u8,
}

#[derive(near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct IdentityView {
    pub token_id: U64,
    pub owner_id: AccountId,
    pub name: String,
    /// hex 编码的 persona hash（全 0 表示未设置）。
    pub persona_hash: String,
    pub persona_arweave_id: String,
    pub equipped: [Option<U64>; SLOT_COUNT],
    pub unlocked: bool,
    pub agents: Vec<AgentView>,
    pub minted_at: U64,
}

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Metadata,
    TokenByOwner,
    OwnerByToken,
    NameByToken,
    OwnerByLowerName,
    PersonaByToken,
    AgentPermissions,
    AgentsByToken,
    Equipped,
    Unlocked,
    MintedAt,
    Parts,
    PartBalance,
    PartEscrow,
    Minters,
    StarterClaimed,
}

/// V1 状态布局(首次部署版本,字段顺序即链上既有字节序;追加新字段必须配 migrate,见 README)
#[derive(BorshDeserialize)]
pub struct ContractStateV1 {
    owner_id: AccountId,
    mint_count: u64,
    next_token_id: u64,
    tier1_fee: u128,
    tier1_end: u64,
    tier2_fee: u128,
    tier2_end: u64,
    tier3_fee: u128,
    metadata: LazyOption<NftContractMetadata>,
    token_by_owner: LookupMap<AccountId, u64>,
    owner_by_token: IterableMap<u64, AccountId>,
    name_by_token: LookupMap<u64, String>,
    owner_by_lower_name: LookupMap<String, AccountId>,
    persona_by_token: LookupMap<u64, Persona>,
    agent_permissions: LookupMap<(u64, AccountId), u8>,
    agents_by_token: LookupMap<u64, Vec<AccountId>>,
    equipped: LookupMap<u64, [Option<u64>; SLOT_COUNT]>,
    unlocked: LookupMap<u64, bool>,
    minted_at: LookupMap<u64, u64>,
    parts: LookupMap<u64, PartInfo>,
    part_balance: LookupMap<(AccountId, u64), u64>,
    part_escrow: LookupMap<(u64, u64), u64>,
    minters: LookupMap<AccountId, bool>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,    /// 累计铸造数，只增不减（burn 不回退），用于阶梯定价与 EVM/Solana 对齐。
    mint_count: u64,
    next_token_id: u64,

    // 阶梯铸币费：第 [0, tier1_end) 个收 tier1_fee，[tier1_end, tier2_end) 收 tier2_fee，
    // 之后收 tier3_fee。默认：前 10 个免费，第 10-99 个 0.5 NEAR，之后 1 NEAR。
    tier1_fee: u128,
    tier1_end: u64,
    tier2_fee: u128,
    tier2_end: u64,
    tier3_fee: u128,

    // ---- 身份（NEP-171，Soulbound） ----
    metadata: LazyOption<NftContractMetadata>,
    token_by_owner: LookupMap<AccountId, u64>,
    owner_by_token: IterableMap<u64, AccountId>,
    name_by_token: LookupMap<u64, String>,
    /// 小写名称 -> 首个占用者，burn 后仍保留（名称永久占用，对齐 EVM）。
    owner_by_lower_name: LookupMap<String, AccountId>,
    persona_by_token: LookupMap<u64, Persona>,
    agent_permissions: LookupMap<(u64, AccountId), u8>,
    agents_by_token: LookupMap<u64, Vec<AccountId>>,
    equipped: LookupMap<u64, [Option<u64>; SLOT_COUNT]>,
    /// 缺省 = 锁定（Soulbound）。owner 可显式解锁（治理解锁标记，对齐 EVM _unlocked）。
    unlocked: LookupMap<u64, bool>,
    minted_at: LookupMap<u64, u64>,

    // ---- 装备部件（等价 ERC-1155 的简化多代币） ----
    parts: LookupMap<u64, PartInfo>,
    /// (owner, part_id) -> 可用余额（未托管部分）。
    part_balance: LookupMap<(AccountId, u64), u64>,
    /// (token_id, part_id) -> 托管在身份下的数量（equip 时转入）。
    part_escrow: LookupMap<(u64, u64), u64>,
    minters: LookupMap<AccountId, bool>,
    /// 新手大礼包:每账户限领一次(与 EVM StarterPartClaim 的 claimed 映射一致,burn 不重置)
    starter_claimed: LookupMap<AccountId, bool>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        require!(!env::state_exists(), "already initialized");
        let metadata = NftContractMetadata {
            spec: NFT_METADATA_SPEC.into(),
            name: "TinyWorld Identity".into(),
            symbol: "TWDID".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        let metadata_opt = LazyOption::new(StorageKey::Metadata, Some(metadata));
        Self {
            owner_id,
            mint_count: 0,
            next_token_id: 1,
            tier1_fee: 0,
            tier1_end: 10,
            tier2_fee: NearToken::from_near(1).as_yoctonear() / 2, // 0.5 NEAR
            tier2_end: 100,
            tier3_fee: NearToken::from_near(1).as_yoctonear(),      // 1 NEAR
            metadata: metadata_opt,
            token_by_owner: LookupMap::new(StorageKey::TokenByOwner),
            owner_by_token: IterableMap::new(StorageKey::OwnerByToken),
            name_by_token: LookupMap::new(StorageKey::NameByToken),
            owner_by_lower_name: LookupMap::new(StorageKey::OwnerByLowerName),
            persona_by_token: LookupMap::new(StorageKey::PersonaByToken),
            agent_permissions: LookupMap::new(StorageKey::AgentPermissions),
            agents_by_token: LookupMap::new(StorageKey::AgentsByToken),
            equipped: LookupMap::new(StorageKey::Equipped),
            unlocked: LookupMap::new(StorageKey::Unlocked),
            minted_at: LookupMap::new(StorageKey::MintedAt),
            parts: LookupMap::new(StorageKey::Parts),
            part_balance: LookupMap::new(StorageKey::PartBalance),
            part_escrow: LookupMap::new(StorageKey::PartEscrow),
            minters: LookupMap::new(StorageKey::Minters),
            starter_claimed: LookupMap::new(StorageKey::StarterClaimed),
        }
    }

    /// 状态迁移:首次部署(V1,无 starter_claimed)→ 当前版本。
    /// near-sdk 的 state_read 用 try_from_slice(不容忍尾部字节),合约结构追加字段后
    /// 旧状态无法反序列化,必须经此方法把旧字节按 V1 布局读出、补齐新字段后写回。
    /// 仅合约账户自身可调用(#[private])。
    #[private]
    pub fn migrate() -> bool {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state"));
        let v1 = ContractStateV1::try_from_slice(&raw).unwrap_or_else(|_| env::panic_str("bad v1 state"));
        let new = Contract {
            owner_id: v1.owner_id,
            mint_count: v1.mint_count,
            next_token_id: v1.next_token_id,
            tier1_fee: v1.tier1_fee,
            tier1_end: v1.tier1_end,
            tier2_fee: v1.tier2_fee,
            tier2_end: v1.tier2_end,
            tier3_fee: v1.tier3_fee,
            metadata: v1.metadata,
            token_by_owner: v1.token_by_owner,
            owner_by_token: v1.owner_by_token,
            name_by_token: v1.name_by_token,
            owner_by_lower_name: v1.owner_by_lower_name,
            persona_by_token: v1.persona_by_token,
            agent_permissions: v1.agent_permissions,
            agents_by_token: v1.agents_by_token,
            equipped: v1.equipped,
            unlocked: v1.unlocked,
            minted_at: v1.minted_at,
            parts: v1.parts,
            part_balance: v1.part_balance,
            part_escrow: v1.part_escrow,
            minters: v1.minters,
            starter_claimed: LookupMap::new(StorageKey::StarterClaimed),
        };
        env::state_write(&new);
        true
    }

    // ------------------------------------------------------------------
    // 管理接口
    // ------------------------------------------------------------------

    pub fn set_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.owner_id = new_owner;
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    /// 调整三档阶梯铸币费。fee 单位为 yoctoNEAR。
    pub fn set_tier_fees(
        &mut self,
        tier1_fee: U128,
        tier1_end: U64,
        tier2_fee: U128,
        tier2_end: U64,
        tier3_fee: U128,
    ) {
        self.assert_owner();
        require!(tier1_end.0 <= tier2_end.0, "tiers must be ascending");
        self.tier1_fee = tier1_fee.0;
        self.tier1_end = tier1_end.0;
        self.tier2_fee = tier2_fee.0;
        self.tier2_end = tier2_end.0;
        self.tier3_fee = tier3_fee.0;
    }

    pub fn set_nft_metadata(&mut self, metadata: NftContractMetadata) {
        self.assert_owner();
        require!(metadata.spec == NFT_METADATA_SPEC, "invalid spec");
        self.metadata.set(Some(metadata));
    }

    pub fn get_current_fee(&self) -> U128 {
        self.current_fee().into()
    }

    pub fn get_mint_count(&self) -> U64 {
        self.mint_count.into()
    }

    // ------------------------------------------------------------------
    // 身份铸造与人格 / Agent 授权
    // ------------------------------------------------------------------

    /// 任何人可铸，约束：每账户 1 枚 + 名称唯一（大小写不敏感，burn 后仍保留）。
    /// 按当前 mint_count 所处阶梯收取 attached deposit，多付部分自动退还。
    #[payable]
    pub fn mint_identity(&mut self, name: String) -> U64 {
        let owner = env::predecessor_account_id();
        require!(self.token_by_owner.get(&owner).is_none(), "AlreadyHasDID");
        let name_len = name.len();
        require!(name_len >= 1 && name_len <= MAX_NAME_LENGTH, "InvalidName");

        let lower = to_lower_ascii(&name);
        require!(!self.owner_by_lower_name.contains_key(&lower), "NameTaken");

        let fee = self.current_fee();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= fee, "InsufficientFee");
        self.refund_excess(fee);

        let token_id = self.next_token_id;
        self.next_token_id += 1;
        self.mint_count += 1;

        self.token_by_owner.insert(owner.clone(), token_id);
        self.owner_by_token.insert(token_id, owner.clone());
        self.name_by_token.insert(token_id, name.clone());
        self.owner_by_lower_name.insert(lower, owner.clone());
        self.persona_by_token.insert(token_id, Persona::default());
        self.equipped.insert(token_id, [None; SLOT_COUNT]);
        self.minted_at.insert(token_id, env::block_timestamp());

        log_nep297(
            "nep171",
            "1.0.0",
            "nft_mint",
            serde_json::json!([{
                "owner_id": owner,
                "token_ids": [token_id.to_string()],
            }]),
        );
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "minted",
            serde_json::json!({ "owner_id": env::predecessor_account_id(), "token_id": token_id.to_string(), "name": name }),
        );
        token_id.into()
    }

    /// 更新人格指针。caller 须为 token owner，或持有 PERMISSION_PERSONA 的 agent。
    /// persona_hash 为 64 位 hex（可带 0x 前缀）；arweave_id 为空串或 43 位 base64url。
    pub fn update_persona(&mut self, token_id: U64, persona_hash: String, arweave_id: String) {
        let token_id = token_id.0;
        self.assert_identity_exists(token_id);
        let caller = env::predecessor_account_id();
        self.assert_can_manage_persona(token_id, &caller);
        let hash = parse_hex32(&persona_hash).unwrap_or_else(|| env::panic_str("InvalidPersonaHash"));
        require!(arweave_id.is_empty() || is_base64url(&arweave_id), "InvalidArweaveId");
        let persona = Persona { hash, arweave_id: arweave_id.clone() };
        self.persona_by_token.insert(token_id, persona.clone());
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "persona_updated",
            serde_json::json!({
                "token_id": token_id.to_string(),
                "persona_hash": hex32(&persona.hash),
                "persona_arweave_id": arweave_id,
            }),
        );
    }

    /// owner 授权 AI 操作员钱包（对齐 EVM agentPermissions）。
    pub fn set_agent(&mut self, token_id: U64, agent: AccountId, permissions: u8) {
        let token_id = token_id.0;
        self.assert_identity_exists(token_id);
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(token_id), "not token owner");
        require!(permissions & !VALID_PERMISSIONS == 0, "InvalidPermissions");
        let key = (token_id, agent.clone());
        if !self.agent_permissions.contains_key(&key) {
            let mut agents = self.agents_by_token.get(&token_id).cloned().unwrap_or_default();
            agents.push(agent.clone());
            self.agents_by_token.insert(token_id, agents);
        }
        self.agent_permissions.insert(key, permissions);
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "agent_set",
            serde_json::json!({
                "token_id": token_id.to_string(),
                "agent_id": agent,
                "permissions": permissions,
            }),
        );
    }

    pub fn revoke_agent(&mut self, token_id: U64, agent: AccountId) {
        let token_id = token_id.0;
        self.assert_identity_exists(token_id);
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(token_id), "not token owner");
        self.agent_permissions.remove(&(token_id, agent.clone()));
        if let Some(mut agents) = self.agents_by_token.get(&token_id).cloned() {
            agents.retain(|a| a != &agent);
            self.agents_by_token.insert(token_id, agents);
        }
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "agent_revoked",
            serde_json::json!({ "token_id": token_id.to_string(), "agent_id": agent }),
        );
    }

    /// 仅 owner（账户级）：解锁后才能 nft_transfer。
    pub fn unlock(&mut self, token_id: U64) {
        self.assert_unlock_admin(token_id.0);
        self.unlocked.insert(token_id.0, true);
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "unlocked",
            serde_json::json!({ "token_id": token_id.0.to_string() }),
        );
    }

    pub fn lock(&mut self, token_id: U64) {
        self.assert_unlock_admin(token_id.0);
        self.unlocked.insert(token_id.0, false);
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "locked",
            serde_json::json!({ "token_id": token_id.0.to_string() }),
        );
    }

    /// 销毁自己的身份。要求 4 个装备插槽全空；名称永久保留不可复用。
    pub fn burn(&mut self) {
        let owner = env::predecessor_account_id();
        let token_id = self
            .token_by_owner
            .get(&owner)
            .copied()
            .unwrap_or_else(|| env::panic_str("NoIdentity"));
        let equipped = self.equipped.get(&token_id).copied().unwrap_or([None; SLOT_COUNT]);
        require!(equipped.iter().all(|s| s.is_none()), "SlotsNotEmpty");

        self.owner_by_token.remove(&token_id);
        self.name_by_token.remove(&token_id);
        self.persona_by_token.remove(&token_id);
        self.equipped.remove(&token_id);
        self.unlocked.remove(&token_id);
        self.minted_at.remove(&token_id);
        self.token_by_owner.remove(&owner);
        if let Some(agents) = self.agents_by_token.remove(&token_id) {
            for agent in agents {
                self.agent_permissions.remove(&(token_id, agent));
            }
        }

        log_nep297(
            "nep171",
            "1.0.0",
            "nft_burn",
            serde_json::json!([{
                "owner_id": owner,
                "token_ids": [token_id.to_string()],
            }]),
        );
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "burned",
            serde_json::json!({ "token_id": token_id.to_string() }),
        );
    }

    // ------------------------------------------------------------------
    // NEP-171 / NEP-177 / NEP-181（Soulbound：转账受 unlocked 控制，不支持 approve）
    // ------------------------------------------------------------------

    pub fn nft_metadata(&self) -> NftContractMetadata {
        self.metadata.get().clone().unwrap()
    }

    pub fn nft_token(&self, token_id: U64) -> Option<TokenView> {
        self.owner_by_token.get(&token_id.0).map(|owner| TokenView {
            token_id,
            owner_id: owner.clone(),
            metadata: None,
        })
    }

    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: U64,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval_id.is_none(), "approvals not supported");
        let token_id = token_id.0;
        let owner = self.owner_of(token_id);
        require!(self.unlocked.get(&token_id).copied().unwrap_or(false), "TokenLocked");
        require!(self.token_by_owner.get(&receiver_id).is_none(), "ReceiverAlreadyHasDID");
        let equipped = self.equipped.get(&token_id).copied().unwrap_or([None; SLOT_COUNT]);
        require!(equipped.iter().all(|s| s.is_none()), "SlotsNotEmpty");

        self.token_by_owner.remove(&owner);
        self.token_by_owner.insert(receiver_id.clone(), token_id);
        self.owner_by_token.insert(token_id, receiver_id.clone());

        log_nep297(
            "nep171",
            "1.0.0",
            "nft_transfer",
            serde_json::json!([{
                "old_owner_id": owner,
                "new_owner_id": receiver_id,
                "token_ids": [token_id.to_string()],
                "memo": memo,
            }]),
        );
    }

    /// Soulbound DID 不支持接收方回调转账。
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        _receiver_id: AccountId,
        _token_id: U64,
        _approval_id: Option<u64>,
        _memo: Option<String>,
        _msg: String,
    ) -> Promise {
        env::panic_str("nft_transfer_call not supported for soulbound DID")
    }

    pub fn nft_approve(&mut self, _token_id: U64, _account_id: AccountId, _msg: Option<String>) {
        env::panic_str("approvals not supported for soulbound DID")
    }

    pub fn nft_revoke(&mut self, _token_id: U64, _account_id: AccountId) {
        env::panic_str("approvals not supported for soulbound DID")
    }

    pub fn nft_revoke_all(&mut self, _token_id: U64) {
        env::panic_str("approvals not supported for soulbound DID")
    }

    pub fn nft_total_supply(&self) -> U64 {
        (self.owner_by_token.len() as u64).into()
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<TokenView> {
        let from = from_index.map(|v| v.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50) as usize;
        self.owner_by_token
            .iter()
            .skip(from)
            .take(limit)
            .map(|(token_id, owner)| TokenView {
                token_id: (*token_id).into(),
                owner_id: owner.clone(),
                metadata: None,
            })
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U64 {
        (if self.token_by_owner.contains_key(&account_id) { 1 } else { 0 }).into()
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        _from_index: Option<U128>,
        _limit: Option<u64>,
    ) -> Vec<TokenView> {
        match self.token_by_owner.get(&account_id) {
            Some(token_id) => vec![TokenView {
                token_id: (*token_id).into(),
                owner_id: account_id,
                metadata: None,
            }],
            None => vec![],
        }
    }

    // ------------------------------------------------------------------
    // 装备部件（register / mint / transfer）
    // ------------------------------------------------------------------

    /// 定义部件（仅 owner）。part_id 区间按槽位规划：头 1xxx / 身 2xxx / 配饰 3xxx / 宠物 4xxx。
    pub fn register_part(&mut self, part_id: U64, slot: u8, rarity: u8, max_supply: U64) {
        self.assert_owner();
        require!(slot < SLOT_COUNT as u8, "InvalidSlot");
        require!(max_supply.0 > 0, "InvalidMaxSupply");
        require!(!self.parts.contains_key(&part_id.0), "PartAlreadyRegistered");
        self.parts.insert(
            part_id.0,
            PartInfo {
                slot,
                rarity,
                max_supply: max_supply.0,
                total_supply: 0,
                mintable: true,
                registered: true,
            },
        );
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "part_registered",
            serde_json::json!({
                "part_id": part_id.0.to_string(),
                "slot": slot,
                "rarity": rarity,
                "max_supply": max_supply.0.to_string(),
            }),
        );
    }

    pub fn set_part_mintable(&mut self, part_id: U64, mintable: bool) {
        self.assert_owner();
        let part = self.part_mut(part_id.0);
        part.mintable = mintable;
    }

    pub fn set_minter(&mut self, account: AccountId, enabled: bool) {
        self.assert_owner();
        self.minters.insert(account.clone(), enabled);
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "minter_set",
            serde_json::json!({ "account_id": account, "enabled": enabled }),
        );
    }

    /// 登录挑战：无状态方法，仅校验并记录事件。NEP-413 signMessage 的钱包侧（MyNearWallet 等）
    /// 不返回签名负载（timestamp 由钱包生成、dApp 无法重建），NEAR 登录改用链上挑战：
    /// 用户钱包签名一笔指向本合约的 login_challenge(nonce) 交易，后端按交易哈希向 RPC
    /// 核对签名者/方法/nonce/执行状态，证明该账户的密钥控制权（等价 SIWE 的密码学强度）。
    pub fn login_challenge(&mut self, nonce: String) {
        let caller = env::predecessor_account_id();
        require!(!nonce.is_empty() && nonce.len() <= 128, "InvalidNonce");
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "login_challenge",
            serde_json::json!({ "account_id": caller, "nonce": nonce }),
        );
    }

    /// 铸造部件（owner 或已启用 minter），超额整笔回滚。
    pub fn mint_part(&mut self, to: AccountId, part_id: U64, amount: U64) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_id || self.minters.get(&caller).copied().unwrap_or(false), "not minter");
        let part = self.part_mut(part_id.0);
        require!(part.mintable, "PartNotMintable");
        require!(part.total_supply + amount.0 <= part.max_supply, "MaxSupplyExceeded");
        part.total_supply += amount.0;
        let key = (to.clone(), part_id.0);
        let balance = self.part_balance.get(&key).copied().unwrap_or(0);
        self.part_balance.insert(key, balance + amount.0);
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "part_minted",
            serde_json::json!({
                "to": to,
                "part_id": part_id.0.to_string(),
                "amount": amount.0.to_string(),
            }),
        );
    }

    /// 部件在用户之间转账（托管中的部分不可转，先 unequip）。
    pub fn part_transfer(&mut self, to: AccountId, part_id: U64, amount: U64, memo: Option<String>) {
        let from = env::predecessor_account_id();
        require!(amount.0 > 0, "InvalidAmount");
        let from_key = (from.clone(), part_id.0);
        let from_balance = self.part_balance.get(&from_key).copied().unwrap_or(0);
        require!(from_balance >= amount.0, "InsufficientPartBalance");
        self.part_balance.insert(from_key, from_balance - amount.0);
        let to_key = (to.clone(), part_id.0);
        let to_balance = self.part_balance.get(&to_key).copied().unwrap_or(0);
        self.part_balance.insert(to_key, to_balance + amount.0);
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "part_transferred",
            serde_json::json!({
                "old_owner_id": from,
                "new_owner_id": to,
                "part_id": part_id.0.to_string(),
                "amount": amount.0.to_string(),
                "memo": memo,
            }),
        );
    }

    // ------------------------------------------------------------------
    // 装备穿戴（4 插槽托管，占用时一笔交易自动退旧装新）
    // ------------------------------------------------------------------

    /// 穿上部件：从 owner 余额扣 1 件进托管；插槽已有其他部件时自动退回。
    pub fn equip(&mut self, token_id: U64, part_id: U64, slot: u8) {
        let token_id = token_id.0;
        self.assert_identity_exists(token_id);
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(token_id), "not token owner");
        let part = self.part(part_id.0);
        require!(part.registered, "PartNotRegistered");
        require!(part.slot == slot, "WrongSlot");
        require!(slot < SLOT_COUNT as u8, "InvalidSlot");

        let equipped_slot = self.equip_internal(token_id, &caller, part_id.0);

        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "equipped",
            serde_json::json!({
                "token_id": token_id.to_string(),
                "part_id": part_id.0.to_string(),
                "slot": slot,
            }),
        );
    }

    /// 装备核心逻辑(claim_starter_pack 与 equip 共用):
    /// 扣 caller 1 件余额进托管;插槽已有其他件时自动退旧装新。返回插槽号。
    fn equip_internal(&mut self, token_id: u64, caller: &AccountId, part_id: u64) -> u8 {
        let slot = self.part(part_id).slot;
        let balance_key = (caller.clone(), part_id);
        let balance = self.part_balance.get(&balance_key).copied().unwrap_or(0);
        require!(balance >= 1, "InsufficientPartBalance");
        self.part_balance.insert(balance_key, balance - 1);

        let mut slots = self.equipped.get(&token_id).copied().unwrap_or([None; SLOT_COUNT]);
        if let Some(old) = slots[slot as usize] {
            if old != part_id {
                // 退旧装新：旧件从托管退回 owner 可用余额。
                let escrow_key = (token_id, old);
                let escrowed = self.part_escrow.get(&escrow_key).copied().unwrap_or(0);
                self.part_escrow.insert(escrow_key, escrowed.saturating_sub(1));
                let old_key = (caller.clone(), old);
                let old_balance = self.part_balance.get(&old_key).copied().unwrap_or(0);
                self.part_balance.insert(old_key, old_balance + 1);
            }
        }
        let escrow_key = (token_id, part_id);
        let escrowed = self.part_escrow.get(&escrow_key).copied().unwrap_or(0);
        self.part_escrow.insert(escrow_key, escrowed + 1);
        slots[slot as usize] = Some(part_id);
        self.equipped.insert(token_id, slots);
        slot
    }

    /// 新手大礼包(等价 EVM StarterPartClaim):免费、每账户一次、须已铸主身份。
    /// 从每个插槽的已注册前 8 件(id 区间 1xxx/2xxx/3xxx/4xxx)中随机选 1 件铸造并自动穿戴;
    /// 某槽无已注册候选或已满额时跳过该槽(不影响其他槽发放)。
    /// 随机源:env::random_seed()(区块 VRF 种子,同 epoch 内恒定;仅用于低价值发放,见 README)。
    pub fn claim_starter_pack(&mut self) {
        let caller = env::predecessor_account_id();
        let token_id = self
            .token_by_owner
            .get(&caller)
            .copied()
            .unwrap_or_else(|| env::panic_str("NoIdentity"));
        require!(!self.starter_claimed.get(&caller).copied().unwrap_or(false), "AlreadyClaimed");

        let seed = env::random_seed();
        let mut claimed: Vec<String> = Vec::new();
        for slot in 0..SLOT_COUNT as u64 {
            let base = (slot + 1) * 1000;
            let candidates: Vec<u64> = (base + 1..=base + 8)
                .filter(|id| self.parts.get(id).map(|p| p.registered).unwrap_or(false))
                .collect();
            if candidates.is_empty() {
                continue;
            }
            // 随机挑选:sha256(random_seed || account_id || slot),取前 8 字节对候选数取模
            let mut data = seed.clone();
            data.extend_from_slice(caller.as_bytes());
            data.push(slot as u8);
            let hash = env::sha256(&data);
            let idx = u64::from_le_bytes(hash[0..8].try_into().unwrap()) % candidates.len() as u64;
            let part_id = candidates[idx as usize];

            // 内部铸造 1 件(满额跳过),再直接装备
            let part = self.part_mut(part_id);
            if part.total_supply + 1 > part.max_supply {
                continue;
            }
            part.total_supply += 1;
            let balance_key = (caller.clone(), part_id);
            let balance = self.part_balance.get(&balance_key).copied().unwrap_or(0);
            self.part_balance.insert(balance_key, balance + 1);

            let equipped_slot = self.equip_internal(token_id, &caller, part_id);
            log_nep297(
                "tinyworld-1.0.0",
                "1.0.0",
                "part_minted",
                serde_json::json!({
                    "to": caller,
                    "part_id": part_id.to_string(),
                    "amount": "1",
                }),
            );
            claimed.push(format!("{part_id}:{equipped_slot}"));
        }

        self.starter_claimed.insert(caller.clone(), true);
        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "starter_pack_claimed",
            serde_json::json!({
                "account_id": caller,
                "token_id": token_id.to_string(),
                "parts": claimed,
            }),
        );
    }

    /// 查询账户是否已领过新手大礼包
    pub fn is_starter_claimed(&self, account_id: AccountId) -> bool {
        self.starter_claimed.get(&account_id).copied().unwrap_or(false)
    }

    pub fn unequip(&mut self, token_id: U64, slot: u8) {
        let token_id = token_id.0;
        self.assert_identity_exists(token_id);
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(token_id), "not token owner");
        require!(slot < SLOT_COUNT as u8, "InvalidSlot");
        let mut slots = self.equipped.get(&token_id).copied().unwrap_or([None; SLOT_COUNT]);
        let part_id = slots[slot as usize].unwrap_or_else(|| env::panic_str("SlotEmpty"));
        slots[slot as usize] = None;
        self.equipped.insert(token_id, slots);
        let escrow_key = (token_id, part_id);
        let escrowed = self.part_escrow.get(&escrow_key).copied().unwrap_or(0);
        self.part_escrow.insert(escrow_key, escrowed - 1);
        let balance_key = (caller, part_id);
        let balance = self.part_balance.get(&balance_key).copied().unwrap_or(0);
        self.part_balance.insert(balance_key, balance + 1);

        log_nep297(
            "tinyworld-1.0.0",
            "1.0.0",
            "unequipped",
            serde_json::json!({
                "token_id": token_id.to_string(),
                "part_id": part_id.to_string(),
                "slot": slot,
            }),
        );
    }

    // ------------------------------------------------------------------
    // 查询接口
    // ------------------------------------------------------------------

    pub fn get_identity_by_owner(&self, account_id: AccountId) -> Option<IdentityView> {
        self.token_by_owner.get(&account_id).map(|t| self.identity_view(*t))
    }

    pub fn get_identity(&self, token_id: U64) -> Option<IdentityView> {
        if self.owner_by_token.contains_key(&token_id.0) {
            Some(self.identity_view(token_id.0))
        } else {
            None
        }
    }

    pub fn get_part(&self, part_id: U64) -> Option<PartInfo> {
        self.parts.get(&part_id.0).cloned()
    }

    pub fn part_balance_of(&self, account_id: AccountId, part_id: U64) -> U64 {
        self.part_balance.get(&(account_id, part_id.0)).copied().unwrap_or(0).into()
    }

    pub fn part_escrow_of(&self, token_id: U64, part_id: U64) -> U64 {
        self.part_escrow.get(&(token_id.0, part_id.0)).copied().unwrap_or(0).into()
    }

    pub fn get_equipped(&self, token_id: U64) -> [Option<U64>; SLOT_COUNT] {
        self.equipped
            .get(&token_id.0)
            .map(|s| map_slots(*s))
            .unwrap_or([None; SLOT_COUNT])
    }

    pub fn get_agent_permissions(&self, token_id: U64, agent: AccountId) -> u8 {
        self.agent_permissions.get(&(token_id.0, agent)).copied().unwrap_or(0)
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "not owner");
    }

    fn assert_identity_exists(&self, token_id: u64) {
        require!(self.owner_by_token.contains_key(&token_id), "IdentityNotFound");
    }

    fn owner_of(&self, token_id: u64) -> AccountId {
        self.owner_by_token
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("IdentityNotFound"))
    }

    fn assert_unlock_admin(&self, token_id: u64) {
        self.assert_identity_exists(token_id);
        require!(env::predecessor_account_id() == self.owner_of(token_id), "not token owner");
    }

    fn assert_can_manage_persona(&self, token_id: u64, caller: &AccountId) {
        if *caller == self.owner_of(token_id) {
            return;
        }
        let perms = self.agent_permissions.get(&(token_id, caller.clone())).copied().unwrap_or(0);
        require!(perms & PERMISSION_PERSONA != 0, "no persona permission");
    }

    fn current_fee(&self) -> u128 {
        if self.mint_count < self.tier1_end {
            self.tier1_fee
        } else if self.mint_count < self.tier2_end {
            self.tier2_fee
        } else {
            self.tier3_fee
        }
    }

    fn refund_excess(&self, fee: u128) {
        let attached = env::attached_deposit().as_yoctonear();
        if attached > fee {
            let _ = Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - fee));
        }
    }

    fn part(&self, part_id: u64) -> PartInfo {
        self.parts.get(&part_id).cloned().unwrap_or_else(|| env::panic_str("PartNotRegistered"))
    }

    fn part_mut(&mut self, part_id: u64) -> &mut PartInfo {
        self.parts.get_mut(&part_id).unwrap_or_else(|| env::panic_str("PartNotRegistered"))
    }

    fn identity_view(&self, token_id: u64) -> IdentityView {
        let owner = self.owner_of(token_id);
        let persona = self.persona_by_token.get(&token_id).cloned().unwrap_or_default();
        let agents = self
            .agents_by_token
            .get(&token_id)
            .map(|list| {
                list.iter()
                    .map(|a| AgentView {
                        account_id: a.clone(),
                        permissions: self
                            .agent_permissions
                            .get(&(token_id, a.clone()))
                            .copied()
                            .unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default();
        IdentityView {
            token_id: token_id.into(),
            owner_id: owner,
            name: self.name_by_token.get(&token_id).cloned().unwrap_or_default(),
            persona_hash: hex32(&persona.hash),
            persona_arweave_id: persona.arweave_id,
            equipped: self
                .equipped
                .get(&token_id)
                .map(|s| map_slots(*s))
                .unwrap_or([None; SLOT_COUNT]),
            unlocked: self.unlocked.get(&token_id).copied().unwrap_or(false),
            agents,
            minted_at: self.minted_at.get(&token_id).copied().unwrap_or(0).into(),
        }
    }
}

// ----------------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------------

fn map_slots(slots: [Option<u64>; SLOT_COUNT]) -> [Option<U64>; SLOT_COUNT] {
    slots.map(|p| p.map(U64))
}

fn log_nep297(standard: &str, version: &str, event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{standard}\",\"version\":\"{version}\",\"event\":\"{event}\",\"data\":{data}}}"
    ));
}

/// ASCII 小写化（名称唯一性比较用，跨链语义一致：仅大小写不敏感）。
fn to_lower_ascii(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_uppercase() { (b + 32) as char } else { b as char })
        .collect()
}

fn is_base64url(s: &str) -> bool {
    s.len() == ARWEAVE_ID_LENGTH
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    let bytes = s.as_bytes();
    for i in 0..32 {
        let hi = hex_val(bytes[i * 2])?;
        let lo = hex_val(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn hex32(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests;
