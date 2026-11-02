use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

fn setup() -> (VMContextBuilder, Contract) {
    let mut ctx = VMContextBuilder::new();
    ctx.predecessor_account_id(accounts(0));
    testing_env!(ctx.build());
    let contract = Contract::new(accounts(0));
    (ctx, contract)
}

fn attach(ctx: &mut VMContextBuilder, near_amount: u128) {
    ctx.attached_deposit(NearToken::from_yoctonear(near_amount));
    testing_env!(ctx.build());
}

fn persona_hash_hex(fill: u8) -> String {
    hex32(&[fill; 32])
}

fn acc(i: u32) -> AccountId {
    format!("user{i}.near").parse().unwrap()
}

fn valid_arweave() -> String {
    "a".repeat(43)
}

#[test]
fn mint_happy_path() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    assert_eq!(token_id.0, 1);
    assert_eq!(contract.get_mint_count().0, 1);
    let id = contract.get_identity_by_owner(accounts(0)).unwrap();
    assert_eq!(id.name, "Alice");
    assert_eq!(id.owner_id, accounts(0));
    assert_eq!(id.persona_hash, hex32(&[0u8; 32]));
    assert!(!id.unlocked);
    assert_eq!(contract.nft_total_supply().0, 1);
    assert_eq!(contract.nft_supply_for_owner(accounts(0)).0, 1);
}

#[test]
#[should_panic(expected = "AlreadyHasDID")]
fn mint_twice_per_account_fails() {
    let (_ctx, mut contract) = setup();
    contract.mint_identity("Alice".to_string());
    contract.mint_identity("Alice2".to_string());
}

#[test]
#[should_panic(expected = "NameTaken")]
fn name_unique_case_insensitive() {
    let (mut ctx, mut contract) = setup();
    contract.mint_identity("Alice".to_string());
    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    contract.mint_identity("aLiCe".to_string());
}

#[test]
#[should_panic(expected = "InvalidName")]
fn name_too_long_fails() {
    let (_ctx, mut contract) = setup();
    contract.mint_identity("a".repeat(65));
}

#[test]
#[should_panic(expected = "InvalidName")]
fn name_empty_fails() {
    let (_ctx, mut contract) = setup();
    contract.mint_identity(String::new());
}

#[test]
fn tiered_fees() {
    let (mut ctx, mut contract) = setup();
    // 默认前 10 个免费。
    assert_eq!(contract.get_current_fee().0, 0);
    for i in 0..10u32 {
        ctx.predecessor_account_id(acc(i));
        attach(&mut ctx, 0);
        contract.mint_identity(format!("user{i}"));
    }
    // 第 11 个进入 tier2：0.5 NEAR。
    assert_eq!(contract.get_current_fee().0, NearToken::from_near(1).as_yoctonear() / 2);

    // 未附费铸造失败。
    ctx.predecessor_account_id(acc(10));
    testing_env!(ctx.build());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.mint_identity("poor".to_string());
    }));
    assert!(res.is_err());

    // 附足额费用成功；多付部分自动退还，mint_count 只增不减。
    ctx.predecessor_account_id(acc(10));
    attach(&mut ctx, NearToken::from_near(1).as_yoctonear());
    contract.mint_identity("payer".to_string());
    assert_eq!(contract.get_mint_count().0, 11);
}

#[test]
fn mint_count_not_decremented_on_burn() {
    let (mut ctx, mut contract) = setup();
    contract.mint_identity("Alice".to_string());
    contract.burn();
    assert_eq!(contract.get_mint_count().0, 1);
    assert!(contract.get_identity_by_owner(accounts(0)).is_none());
}

#[test]
#[should_panic(expected = "NameTaken")]
fn name_permanently_reserved_after_burn() {
    let (_ctx, mut contract) = setup();
    contract.mint_identity("Alice".to_string());
    contract.burn();
    contract.mint_identity("alice".to_string());
}

#[test]
fn update_persona_by_owner() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    let hash = persona_hash_hex(7);
    contract.update_persona(token_id, hash.clone(), valid_arweave());
    let id = contract.get_identity(token_id).unwrap();
    assert_eq!(id.persona_hash, hash);
    assert_eq!(id.persona_arweave_id, valid_arweave());
}

#[test]
#[should_panic(expected = "InvalidArweaveId")]
fn update_persona_bad_arweave_fails() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.update_persona(token_id, persona_hash_hex(7), "not*base64url".to_string());
}

#[test]
#[should_panic(expected = "InvalidPersonaHash")]
fn update_persona_bad_hash_fails() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.update_persona(token_id, "deadbeef".to_string(), String::new());
}

#[test]
fn agent_can_update_persona_with_permission() {
    let (mut ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    ctx.predecessor_account_id(accounts(0));
    testing_env!(ctx.build());
    contract.set_agent(token_id, accounts(1), PERMISSION_PERSONA);

    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    contract.update_persona(token_id, persona_hash_hex(9), String::new());
    assert_eq!(contract.get_identity(token_id).unwrap().persona_hash, persona_hash_hex(9));
}

#[test]
#[should_panic(expected = "no persona permission")]
fn agent_without_permission_cannot_update_persona() {
    let (mut ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    contract.update_persona(token_id, persona_hash_hex(9), String::new());
}

#[test]
fn revoke_agent_removes_permission() {
    let (mut ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.set_agent(token_id, accounts(1), PERMISSION_PERSONA | PERMISSION_SOCIAL);
    assert_eq!(contract.get_agent_permissions(token_id, accounts(1)), 3);
    contract.revoke_agent(token_id, accounts(1));
    assert_eq!(contract.get_agent_permissions(token_id, accounts(1)), 0);
    assert!(contract.get_identity(token_id).unwrap().agents.is_empty());
}

#[test]
#[should_panic(expected = "InvalidPermissions")]
fn invalid_permission_bits_fails() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.set_agent(token_id, accounts(1), 1 << 7);
}

#[test]
fn parts_register_and_mint() {
    let (mut ctx, mut contract) = setup();
    contract.register_part(1001.into(), 0, 1, 100.into());
    contract.set_minter(accounts(1), true);
    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    contract.mint_part(accounts(1), 1001.into(), 10.into());
    assert_eq!(contract.part_balance_of(accounts(1), 1001.into()).0, 10);
    let part = contract.get_part(1001.into()).unwrap();
    assert_eq!(part.total_supply, 10);
    assert!(part.mintable);
}

#[test]
#[should_panic(expected = "not minter")]
fn mint_part_requires_minter() {
    let (mut ctx, mut contract) = setup();
    contract.register_part(1001.into(), 0, 1, 100.into());
    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    contract.mint_part(accounts(1), 1001.into(), 1.into());
}

#[test]
#[should_panic(expected = "MaxSupplyExceeded")]
fn mint_part_max_supply_enforced() {
    let (_ctx, mut contract) = setup();
    contract.register_part(1001.into(), 0, 1, 5.into());
    contract.mint_part(accounts(0), 1001.into(), 5.into());
    contract.mint_part(accounts(0), 1001.into(), 1.into());
}

#[test]
#[should_panic(expected = "PartNotMintable")]
fn mint_part_after_disable_fails() {
    let (_ctx, mut contract) = setup();
    contract.register_part(1001.into(), 0, 1, 5.into());
    contract.set_part_mintable(1001.into(), false);
    contract.mint_part(accounts(0), 1001.into(), 1.into());
}

#[test]
#[should_panic(expected = "PartAlreadyRegistered")]
fn double_register_fails() {
    let (_ctx, mut contract) = setup();
    contract.register_part(1001.into(), 0, 1, 5.into());
    contract.register_part(1001.into(), 0, 1, 5.into());
}

#[test]
fn equip_swap_and_unequip() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.register_part(1002.into(), 0, 2, 10.into());
    contract.mint_part(accounts(0), 1001.into(), 1.into());
    contract.mint_part(accounts(0), 1002.into(), 1.into());

    contract.equip(token_id, 1001.into(), 0);
    assert_eq!(contract.get_equipped(token_id)[0], Some(1001.into()));
    assert_eq!(contract.part_balance_of(accounts(0), 1001.into()).0, 0);
    assert_eq!(contract.part_escrow_of(token_id, 1001.into()).0, 1);

    // 同槽位自动退旧装新。
    contract.equip(token_id, 1002.into(), 0);
    assert_eq!(contract.get_equipped(token_id)[0], Some(1002.into()));
    assert_eq!(contract.part_balance_of(accounts(0), 1001.into()).0, 1);
    assert_eq!(contract.part_escrow_of(token_id, 1001.into()).0, 0);

    contract.unequip(token_id, 0);
    assert_eq!(contract.get_equipped(token_id)[0], None);
    assert_eq!(contract.part_balance_of(accounts(0), 1002.into()).0, 1);
}

#[test]
#[should_panic(expected = "WrongSlot")]
fn equip_wrong_slot_fails() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.register_part(2001.into(), 1, 1, 10.into());
    contract.mint_part(accounts(0), 2001.into(), 1.into());
    contract.equip(token_id, 2001.into(), 0);
}

#[test]
#[should_panic(expected = "InsufficientPartBalance")]
fn equip_requires_balance() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.equip(token_id, 1001.into(), 0);
}

#[test]
#[should_panic(expected = "SlotsNotEmpty")]
fn burn_requires_empty_slots() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.mint_part(accounts(0), 1001.into(), 1.into());
    contract.equip(token_id, 1001.into(), 0);
    contract.burn();
}

#[test]
fn part_transfer_moves_balance() {
    let (mut ctx, mut contract) = setup();
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.mint_part(accounts(0), 1001.into(), 2.into());
    contract.part_transfer(accounts(1), 1001.into(), 1.into(), None);
    assert_eq!(contract.part_balance_of(accounts(0), 1001.into()).0, 1);
    assert_eq!(contract.part_balance_of(accounts(1), 1001.into()).0, 1);
    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    let token2 = contract.mint_identity("Bob".to_string());
    contract.equip(token2, 1001.into(), 0);
    assert_eq!(contract.get_equipped(token2)[0], Some(1001.into()));
}

#[test]
#[should_panic(expected = "TokenLocked")]
fn soulbound_transfer_blocked() {
    let (mut ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    ctx.predecessor_account_id(accounts(0));
    attach(&mut ctx, 1); // 1 yocto for assert_one_yocto
    contract.nft_transfer(accounts(1), token_id, None, None);
}

#[test]
fn unlock_then_transfer_works() {
    let (mut ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.unlock(token_id);
    attach(&mut ctx, 1);
    contract.nft_transfer(accounts(1), token_id, None, None);
    assert!(contract.get_identity_by_owner(accounts(0)).is_none());
    let id = contract.get_identity_by_owner(accounts(1)).unwrap();
    assert_eq!(id.token_id, token_id);
    assert_eq!(contract.nft_token(token_id).unwrap().owner_id, accounts(1));
}

#[test]
#[should_panic(expected = "ReceiverAlreadyHasDID")]
fn transfer_to_existing_identity_fails() {
    let (mut ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    ctx.predecessor_account_id(accounts(1));
    attach(&mut ctx, 0);
    contract.mint_identity("Bob".to_string());
    ctx.predecessor_account_id(accounts(0));
    attach(&mut ctx, 1);
    contract.unlock(token_id);
    contract.nft_transfer(accounts(1), token_id, None, None);
}

#[test]
fn admin_functions_owner_only() {
    let (mut ctx, mut contract) = setup();
    contract.set_tier_fees(0.into(), 5.into(), 100.into(), 10.into(), 200.into());
    assert_eq!(contract.get_current_fee().0, 0);
    for i in 0..5u32 {
        ctx.predecessor_account_id(acc(i));
        attach(&mut ctx, 0);
        contract.mint_identity(format!("u{i}"));
    }
    assert_eq!(contract.get_current_fee().0, 100);

    ctx.predecessor_account_id(accounts(0));
    testing_env!(ctx.build());
    contract.set_owner(acc(10));
    assert_eq!(contract.get_owner(), acc(10));
    ctx.predecessor_account_id(acc(10));
    testing_env!(ctx.build());
    contract.register_part(3001.into(), 2, 3, 1.into());
    assert!(contract.get_part(3001.into()).is_some());
}

#[test]
#[should_panic(expected = "InvalidNonce")]
fn login_challenge_empty_nonce_fails() {
    let (_ctx, mut contract) = setup();
    contract.login_challenge(String::new());
}

#[test]
fn login_challenge_ok() {
    let (_ctx, mut contract) = setup();
    contract.login_challenge("nonce-123".to_string());
}

#[test]
#[should_panic(expected = "NoIdentity")]
fn starter_pack_requires_identity() {
    let (_ctx, mut contract) = setup();
    contract.claim_starter_pack();
}

#[test]
fn starter_pack_claims_and_equips_one_per_slot() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    // 每槽只注册 1 件 → 必然选中它并自动穿戴
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.register_part(2001.into(), 1, 1, 10.into());
    contract.register_part(3001.into(), 2, 1, 10.into());
    contract.register_part(4001.into(), 3, 1, 10.into());

    contract.claim_starter_pack();

    assert!(contract.is_starter_claimed(accounts(0)));
    let equipped = contract.get_equipped(token_id);
    assert_eq!(equipped, [Some(1001.into()), Some(2001.into()), Some(3001.into()), Some(4001.into())]);
    // 装备来自托管,可用余额为 0
    assert_eq!(contract.part_balance_of(accounts(0), 1001.into()).0, 0);
    assert_eq!(contract.part_escrow_of(token_id, 1001.into()).0, 1);
    // 铸造数计入 total_supply
    assert_eq!(contract.get_part(1001.into()).unwrap().total_supply, 1);
}

#[test]
fn starter_pack_skips_unregistered_slots() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    // 只注册头槽 2 件 → 只有 slot 0 被装配
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.register_part(1002.into(), 0, 2, 10.into());

    contract.claim_starter_pack();

    let equipped = contract.get_equipped(token_id);
    assert!(equipped[0].is_some());
    assert!(equipped[1].is_none() && equipped[2].is_none() && equipped[3].is_none());
}

#[test]
#[should_panic(expected = "AlreadyClaimed")]
fn starter_pack_once_per_account() {
    let (_ctx, mut contract) = setup();
    contract.mint_identity("Alice".to_string());
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.claim_starter_pack();
    contract.claim_starter_pack();
}

#[test]
fn starter_pack_respects_max_supply() {
    let (_ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    // slot0 唯一候选但已满额 → 跳过该槽,其余正常
    contract.register_part(1001.into(), 0, 1, 1.into());
    contract.register_part(2001.into(), 1, 1, 10.into());
    contract.mint_part(accounts(0), 1001.into(), 1.into()); // 占满 1001

    contract.claim_starter_pack();

    let equipped = contract.get_equipped(token_id);
    assert!(equipped[0].is_none(), "满额槽应跳过");
    assert_eq!(equipped[1], Some(2001.into()));
}

#[test]
fn nft_metadata_spec() {
    let (_ctx, contract) = setup();
    let md = contract.nft_metadata();
    assert_eq!(md.spec, "nft-1.0.0");
    assert_eq!(md.symbol, "TWDID");
}

#[test]
#[should_panic(expected = "not owner")]
fn non_owner_cannot_register_part() {
    let (mut ctx, mut contract) = setup();
    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    contract.register_part(1001.into(), 0, 1, 10.into());
}

#[test]
#[should_panic(expected = "not token owner")]
fn non_owner_cannot_equip() {
    let (mut ctx, mut contract) = setup();
    let token_id = contract.mint_identity("Alice".to_string());
    contract.register_part(1001.into(), 0, 1, 10.into());
    contract.mint_part(accounts(0), 1001.into(), 1.into());
    ctx.predecessor_account_id(accounts(1));
    testing_env!(ctx.build());
    contract.equip(token_id, 1001.into(), 0);
}
