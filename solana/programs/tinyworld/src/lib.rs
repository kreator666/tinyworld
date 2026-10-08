use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
use anchor_spl::token_2022::spl_token_2022::state::Mint as SplMint;
use anchor_spl::token_interface::{Mint, TokenInterface};
use std::io::Cursor;

declare_id!("AYPTCkaWoeEyQm4bzGqf4aLUm5JZYwFB8JGMLEwxyiBB");

pub const SLOT_COUNT: usize = 4;
pub const MAX_NAME_LEN: usize = 64;
pub const ARWEAVE_ID_LEN: usize = 43;
pub const PERMISSION_PERSONA: u8 = 1 << 0;
pub const PERMISSION_SOCIAL: u8 = 1 << 1;
pub const PERMISSION_MASK: u8 = PERMISSION_PERSONA | PERMISSION_SOCIAL;

pub const CONFIG_SPACE: usize = 8 + 32 + 1 + 1 + 1 + 64;
pub const NAME_RECORD_SPACE: usize = 8 + 32 + 32 + 8 + 1 + 64;
pub const PART_CONFIG_SPACE: usize = 8 + 8 + 32 + 1 + 1 + 8 + 1 + 8 + 1 + 64;
pub const MINTER_SPACE: usize = 8 + 32 + 1 + 1;
pub const AGENT_PERMISSION_SPACE: usize = 8 + 32 + 32 + 1 + 1;

#[program]
pub mod tinyworld {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.version = 1;
        config.bump = ctx.bumps.config;
        config.mint_auth_bump = ctx.bumps.mint_auth;
        config.reserved = [0u8; 64];
        // 阶梯铸造费率默认值:前 tier2_start(10) 个免费,之后 0.5 SOL,满 tier3_start(100) 个后 1 SOL
        config.set_tier(0, 500_000_000, 1_000_000_000, 10, 100);
        Ok(())
    }

    /// 设置阶梯铸造费率(authority;0 档费 = 免费)。档位按累计铸造数(count)划分:
    /// count < tier2_start 收 tier1_fee;tier2_start..tier3_start 收 tier2_fee;>= tier3_start 收 tier3_fee
    pub fn set_mint_tier(
        ctx: Context<SetMintTier>,
        tier1_fee: u64,
        tier2_fee: u64,
        tier3_fee: u64,
        tier2_start: u64,
        tier3_start: u64,
    ) -> Result<()> {
        require!(tier2_start < tier3_start, TinyWorldError::InvalidTier);
        let config = &mut ctx.accounts.config;
        config.set_tier(tier1_fee, tier2_fee, tier3_fee, tier2_start, tier3_start);
        emit!(MintTierSet {
            tier1_fee,
            tier2_fee,
            tier3_fee,
            tier2_start,
            tier3_start,
        });
        Ok(())
    }

    pub fn mint_identity(ctx: Context<MintIdentity>, name: String) -> Result<()> {
        let name_bytes = name.as_bytes();
        require!(
            !name_bytes.is_empty() && name_bytes.len() <= MAX_NAME_LEN,
            TinyWorldError::InvalidName
        );
        require!(
            ctx.accounts.identity.data_is_empty(),
            TinyWorldError::AlreadyHasDID
        );
        require!(
            ctx.accounts.name_record.data_is_empty(),
            TinyWorldError::NameTaken
        );

        let name_hash = keccak::hash(&to_lower(name_bytes)).to_bytes();
        let (expected_nr, nr_bump) =
            Pubkey::find_program_address(&[b"name-record", &name_hash], &crate::ID);
        require!(
            ctx.accounts.name_record.key() == expected_nr,
            TinyWorldError::NameTaken
        );

        // 铸造费:按累计铸造数所处阶梯收取(owner 付给 config authority,主网防批量抢注)。
        // fee_receiver 为 Option 且追加在账户列表末尾:当前阶梯费=0 时旧客户端传程序 ID 占位即可,前向兼容。
        let config = &mut ctx.accounts.config;
        let fee = config.tier_fee(config.mint_count());
        if fee > 0 {
            let receiver = ctx
                .accounts
                .fee_receiver
                .as_ref()
                .ok_or(TinyWorldError::MintFeeReceiverRequired)?;
            require!(
                receiver.key() == config.authority,
                TinyWorldError::InvalidFeeReceiver
            );
            transfer_lamports(
                &ctx.accounts.owner.to_account_info(),
                &receiver.to_account_info(),
                fee,
                &ctx.accounts.system_program.to_account_info(),
            )?;
        }

        // 1) 创建带 NonTransferable 扩展的 Token-2022 mint（decimals=0，mint_auth 为 mint authority）
        create_mint_account(
            &ctx.accounts.mint,
            &ctx.accounts.owner,
            &ctx.accounts.system_program,
            &[ExtensionType::NonTransferable],
            ctx.accounts.token_program.key(),
        )?;
        invoke_initialize_non_transferable(
            &ctx.accounts.mint,
            ctx.accounts.token_program.key(),
        )?;
        invoke_initialize_mint(
            &ctx.accounts.mint,
            &ctx.accounts.mint_auth,
            ctx.accounts.token_program.key(),
        )?;

        // 2) owner ATA + mint 1 枚（NonTransferable 扩展禁止任何转账 = Soulbound）
        create_ata_idempotent(
            &ctx.accounts.owner_ata,
            &ctx.accounts.owner,
            &ctx.accounts.mint,
            &ctx.accounts.owner,
            &ctx.accounts.system_program,
            &ctx.accounts.token_program,
        )?;
        invoke_mint_to(
            &ctx.accounts.mint,
            &ctx.accounts.owner_ata,
            &ctx.accounts.mint_auth,
            1,
            ctx.accounts.token_program.key(),
            &[&[b"mint-auth", &[ctx.accounts.config.mint_auth_bump]]],
        )?;

        // 3) 初始化 Identity PDA + NameRecord PDA
        let clock = Clock::get()?;
        init_program_account(
            &ctx.accounts.identity,
            &ctx.accounts.owner,
            &ctx.accounts.system_program,
            identity_space(name_bytes.len()),
            &[&[b"identity", ctx.accounts.owner.key().as_ref(), &[ctx.bumps.identity]]],
            &Identity {
                owner: ctx.accounts.owner.key(),
                mint: ctx.accounts.mint.key(),
                name: name.clone(),
                name_hash,
                persona_hash: [0u8; 32],
                persona_arweave_id: String::new(),
                equipped: [None; SLOT_COUNT],
                agent_count: 0,
                recipe_id: 0,
                mint_fee_lamports: 0,
                minted_at: clock.unix_timestamp,
                ready_at: 0,
                attributes: [0u8; 32],
                version: 1,
                bump: ctx.bumps.identity,
                reserved: [0u8; 128],
            },
        )?;
        init_program_account(
            &ctx.accounts.name_record,
            &ctx.accounts.owner,
            &ctx.accounts.system_program,
            NAME_RECORD_SPACE,
            &[&[b"name-record", &name_hash, &[nr_bump]]],
            &NameRecord {
                owner: ctx.accounts.owner.key(),
                identity: ctx.accounts.identity.key(),
                created_slot: clock.slot,
                bump: nr_bump,
                reserved: [0u8; 64],
            },
        )?;

        // 铸造计数 +1(累计口径,close_identity 不减——对齐 EVM totalMinted 语义)
        ctx.accounts.config.inc_mint_count();

        emit!(Minted {
            owner: ctx.accounts.owner.key(),
            mint: ctx.accounts.mint.key(),
            name,
        });
        Ok(())
    }

    pub fn update_persona(
        ctx: Context<UpdatePersona>,
        persona_hash: [u8; 32],
        arweave_id: String,
    ) -> Result<()> {
        validate_arweave_id(&arweave_id)?;
        let identity = &mut ctx.accounts.identity;
        let signer = ctx.accounts.signer.key();
        if signer != identity.owner {
            let authorized = ctx
                .accounts
                .agent_permission
                .as_ref()
                .map(|p| p.agent == signer && p.permissions & PERMISSION_PERSONA != 0)
                .unwrap_or(false);
            require!(authorized, TinyWorldError::NotAuthorized);
        }
        identity.persona_hash = persona_hash;
        identity.persona_arweave_id = arweave_id.clone();
        emit!(PersonaUpdated {
            identity: identity.key(),
            persona_hash,
        });
        Ok(())
    }

    pub fn set_agent(ctx: Context<SetAgent>, agent: Pubkey, permissions: u8) -> Result<()> {
        require!(agent != Pubkey::default(), TinyWorldError::InvalidAgent);
        require!(permissions != 0, TinyWorldError::InvalidAgent);
        require!(
            permissions & !PERMISSION_MASK == 0,
            TinyWorldError::InvalidAgentPermission
        );
        let identity_key = ctx.accounts.identity.key();
        let permission = &mut ctx.accounts.agent_permission;
        if permission.identity == Pubkey::default() {
            // init_if_needed 新建：补全字段并计数
            permission.identity = identity_key;
            permission.agent = agent;
            permission.bump = ctx.bumps.agent_permission;
            ctx.accounts.identity.agent_count += 1;
        }
        permission.permissions = permissions;
        emit!(AgentSet {
            identity: identity_key,
            agent,
            permissions,
        });
        Ok(())
    }

    pub fn revoke_agent(ctx: Context<RevokeAgent>, agent: Pubkey) -> Result<()> {
        let identity_key = ctx.accounts.identity.key();
        ctx.accounts.identity.agent_count -= 1;
        emit!(AgentRevoked {
            identity: identity_key,
            agent,
        });
        Ok(())
    }

    pub fn register_part(
        ctx: Context<RegisterPart>,
        part_id: u64,
        slot: u8,
        rarity: u8,
        max_supply: u64,
    ) -> Result<()> {
        require!(slot < SLOT_COUNT as u8, TinyWorldError::InvalidSlot);
        require!(max_supply > 0, TinyWorldError::InvalidMaxSupply);
        require!(
            ctx.accounts.part_config.data_is_empty(),
            TinyWorldError::PartAlreadyRegistered
        );

        create_mint_account(
            &ctx.accounts.part_mint,
            &ctx.accounts.authority,
            &ctx.accounts.system_program,
            &[],
            ctx.accounts.token_program.key(),
        )?;
        invoke_initialize_mint(
            &ctx.accounts.part_mint,
            &ctx.accounts.mint_auth,
            ctx.accounts.token_program.key(),
        )?;

        init_program_account(
            &ctx.accounts.part_config,
            &ctx.accounts.authority,
            &ctx.accounts.system_program,
            PART_CONFIG_SPACE,
            &[&[
                b"part",
                part_id.to_le_bytes().as_ref(),
                &[ctx.bumps.part_config],
            ]],
            &PartConfig {
                part_id,
                mint: ctx.accounts.part_mint.key(),
                slot,
                rarity,
                max_supply,
                mintable: true,
                registered_at: Clock::get()?.unix_timestamp,
                bump: ctx.bumps.part_config,
                reserved: [0u8; 64],
            },
        )?;

        emit!(PartRegistered {
            part_id,
            slot,
            rarity,
            max_supply,
        });
        Ok(())
    }

    pub fn set_part_mintable(
        ctx: Context<SetPartMintable>,
        part_id: u64,
        mintable: bool,
    ) -> Result<()> {
        let _ = part_id;
        let config = &mut ctx.accounts.part_config;
        config.mintable = mintable;
        emit!(PartMintableUpdated {
            part_id: config.part_id,
            mintable,
        });
        Ok(())
    }

    pub fn set_minter(ctx: Context<SetMinter>, enabled: bool) -> Result<()> {
        let minter = &mut ctx.accounts.minter;
        if minter.wallet == Pubkey::default() {
            minter.wallet = ctx.accounts.wallet.key();
            minter.bump = ctx.bumps.minter;
        }
        minter.enabled = enabled;
        emit!(MinterUpdated {
            wallet: ctx.accounts.wallet.key(),
            enabled,
        });
        Ok(())
    }

    pub fn remove_minter(ctx: Context<RemoveMinter>) -> Result<()> {
        emit!(MinterUpdated {
            wallet: ctx.accounts.minter.wallet,
            enabled: false,
        });
        Ok(())
    }

    pub fn mint_part(ctx: Context<MintPart>, part_id: u64, to: Pubkey, amount: u64) -> Result<()> {
        let _ = part_id;
        // 铸造权限：config authority 本人，或已启用的 Minter PDA
        let signer = ctx.accounts.signer.key();
        if signer != ctx.accounts.config.authority {
            let minter_info = &ctx.accounts.minter;
            require!(
                !minter_info.data_is_empty(),
                TinyWorldError::UnauthorizedMinter
            );
            let minter_data = minter_info.try_borrow_data()?;
            let minter = Minter::try_deserialize(&mut &minter_data[..])
                .map_err(|_| TinyWorldError::UnauthorizedMinter)?;
            require!(minter.enabled, TinyWorldError::UnauthorizedMinter);
        }

        let part = &ctx.accounts.part_config;
        require!(part.mintable, TinyWorldError::NotMintable);
        let supply = ctx.accounts.part_mint.supply;
        require!(
            supply
                .checked_add(amount)
                .ok_or(TinyWorldError::ExceedsMaxSupply)?
                <= part.max_supply,
            TinyWorldError::ExceedsMaxSupply
        );

        create_ata_idempotent(
            &ctx.accounts.to_ata,
            &ctx.accounts.to,
            &ctx.accounts.part_mint.to_account_info(),
            &ctx.accounts.signer,
            &ctx.accounts.system_program,
            &ctx.accounts.token_program,
        )?;
        invoke_mint_to(
            &ctx.accounts.part_mint.to_account_info(),
            &ctx.accounts.to_ata,
            &ctx.accounts.mint_auth,
            amount,
            ctx.accounts.token_program.key(),
            &[&[b"mint-auth", &[ctx.accounts.config.mint_auth_bump]]],
        )?;

        emit!(PartMinted {
            part_id: part.part_id,
            to,
            amount,
        });
        Ok(())
    }

    pub fn equip(ctx: Context<Equip>, part_id: u64, slot: u8) -> Result<()> {
        let _ = part_id;
        require!(slot < SLOT_COUNT as u8, TinyWorldError::InvalidSlot);
        let identity_key = ctx.accounts.identity.key();
        let identity = &mut ctx.accounts.identity;
        require!(
            ctx.accounts.signer.key() == identity.owner,
            TinyWorldError::NotTokenOwner
        );

        // PartConfig 存在且插槽匹配（对齐 EVM slotOf 校验）
        let part = &ctx.accounts.part_config;
        require!(part.slot == slot, TinyWorldError::SlotMismatch);

        let identity_info = identity.to_account_info();

        // escrow ATA（owner = Identity PDA）按需创建；用户 ATA → escrow 转 1 枚
        create_ata_idempotent(
            &ctx.accounts.escrow_ata,
            &identity_info,
            &ctx.accounts.part_mint.to_account_info(),
            &ctx.accounts.signer,
            &ctx.accounts.system_program,
            &ctx.accounts.token_program,
        )?;
        invoke_transfer(
            &ctx.accounts.part_mint.to_account_info(),
            &ctx.accounts.owner_ata,
            &ctx.accounts.escrow_ata,
            &ctx.accounts.signer,
            1,
            ctx.accounts.token_program.key(),
            &[],
        )?;

        // EVM 语义：插槽已占用时自动退回旧件再装新件（一笔交易完成换装）
        if let Some(old_mint) = identity.equipped[slot as usize] {
            let old_part_mint = ctx.accounts.old_part_mint.as_ref().unwrap();
            require!(
                old_part_mint.key() == old_mint,
                TinyWorldError::SlotOccupied
            );
            invoke_transfer(
                &old_part_mint.to_account_info(),
                ctx.accounts.old_escrow_ata.as_ref().unwrap(),
                ctx.accounts.old_owner_ata.as_ref().unwrap(),
                &identity_info,
                1,
                ctx.accounts.token_program.key(),
                &[&[b"identity", identity.owner.as_ref(), &[identity.bump]]],
            )?;
            emit!(Unequipped {
                identity: identity_key,
                slot,
                part: old_mint,
            });
        }
        identity.equipped[slot as usize] = Some(ctx.accounts.part_mint.key());
        emit!(Equipped {
            identity: identity_key,
            slot,
            part: ctx.accounts.part_mint.key(),
        });
        Ok(())
    }

    pub fn unequip(ctx: Context<Unequip>, slot: u8) -> Result<()> {
        require!(slot < SLOT_COUNT as u8, TinyWorldError::InvalidSlot);
        let identity = &mut ctx.accounts.identity;
        require!(
            ctx.accounts.signer.key() == identity.owner,
            TinyWorldError::NotTokenOwner
        );
        let mint = identity.equipped[slot as usize].ok_or(TinyWorldError::NothingEquipped)?;
        require!(
            ctx.accounts.part_mint.key() == mint,
            TinyWorldError::NothingEquipped
        );

        let identity_info = identity.to_account_info();
        invoke_transfer(
            &ctx.accounts.part_mint.to_account_info(),
            &ctx.accounts.escrow_ata,
            &ctx.accounts.owner_ata,
            &identity_info,
            1,
            ctx.accounts.token_program.key(),
            &[&[b"identity", identity.owner.as_ref(), &[identity.bump]]],
        )?;
        identity.equipped[slot as usize] = None;
        emit!(Unequipped {
            identity: identity.key(),
            slot,
            part: mint,
        });
        Ok(())
    }

    pub fn close_identity(ctx: Context<CloseIdentity>) -> Result<()> {
        let identity = &ctx.accounts.identity;
        require!(
            ctx.accounts.signer.key() == identity.owner,
            TinyWorldError::NotTokenOwner
        );
        require!(
            identity.equipped.iter().all(|s| s.is_none()),
            TinyWorldError::SlotsNotEmpty
        );
        // burn：代币持有者是 burn authority（对齐 EVM burn，由 owner 发起）
        invoke_burn(
            &ctx.accounts.identity_mint.to_account_info(),
            &ctx.accounts.owner_ata,
            &ctx.accounts.signer,
            1,
            ctx.accounts.token_program.key(),
        )?;
        invoke_close_account(
            &ctx.accounts.owner_ata,
            &ctx.accounts.signer,
            &ctx.accounts.signer,
            ctx.accounts.token_program.key(),
        )?;
        emit!(IdentityClosed {
            identity: identity.key(),
            owner: identity.owner,
        });
        Ok(())
    }
}

// ==================================================================
// 账户
// ==================================================================

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub version: u8,
    pub bump: u8,
    pub mint_auth_bump: u8,
    pub reserved: [u8; 64],
}

impl Config {
    // reserved 字节布局(u64le,刻意不新增结构体字段——账户布局/大小零变化,已存在的 config 账户兼容):
    // [0..8]   mint_count    累计铸造身份数(收费档位与运营统计依据,只增不减)
    // [8..16]  tier1_fee     第 1 档费率(默认 0 = 免费)
    // [16..24] tier2_fee     第 2 档费率(默认 0.5 SOL)
    // [24..32] tier3_fee     第 3 档费率(默认 1 SOL)
    // [32..40] tier2_start   第 2 档起始序号(默认 10:前 10 人免费)
    // [40..48] tier3_start   第 3 档起始序号(默认 100)
    fn read_u64(&self, off: usize) -> u64 {
        u64::from_le_bytes(self.reserved[off..off + 8].try_into().unwrap())
    }
    fn write_u64(&mut self, off: usize, v: u64) {
        self.reserved[off..off + 8].copy_from_slice(&v.to_le_bytes());
    }
    pub fn mint_count(&self) -> u64 {
        self.read_u64(0)
    }
    pub fn inc_mint_count(&mut self) {
        let n = self.mint_count();
        self.write_u64(0, n + 1);
    }
    /// 按累计铸造数计算当前应收费率
    pub fn tier_fee(&self, count: u64) -> u64 {
        if count >= self.read_u64(40) {
            self.read_u64(24)
        } else if count >= self.read_u64(32) {
            self.read_u64(16)
        } else {
            self.read_u64(8)
        }
    }
    pub fn set_tier(&mut self, t1: u64, t2: u64, t3: u64, t2_from: u64, t3_from: u64) {
        self.write_u64(8, t1);
        self.write_u64(16, t2);
        self.write_u64(24, t3);
        self.write_u64(32, t2_from);
        self.write_u64(40, t3_from);
    }
}

#[account]
pub struct Identity {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub name: String,
    pub name_hash: [u8; 32],
    pub persona_hash: [u8; 32],
    pub persona_arweave_id: String,
    pub equipped: [Option<Pubkey>; SLOT_COUNT],
    pub agent_count: u32,
    pub recipe_id: u64,
    pub mint_fee_lamports: u64,
    pub minted_at: i64,
    pub ready_at: i64,
    pub attributes: [u8; 32],
    pub version: u8,
    pub bump: u8,
    pub reserved: [u8; 128],
}

pub fn identity_space(name_len: usize) -> usize {
    8 // discriminator
        + 32 // owner
        + 32 // mint
        + 4 + name_len // name
        + 32 // name_hash
        + 32 // persona_hash
        + 4 + 64 // persona_arweave_id（容量 64，可 realloc 扩展）
        + SLOT_COUNT * 33 // equipped: Option<Pubkey> = 1 + 32
        + 4 // agent_count
        + 8 // recipe_id
        + 8 // mint_fee_lamports
        + 8 // minted_at
        + 8 // ready_at
        + 32 // attributes
        + 1 // version
        + 1 // bump
        + 128 // reserved
        + 256 // 冗余
}

#[account]
pub struct NameRecord {
    pub owner: Pubkey,
    pub identity: Pubkey,
    pub created_slot: u64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

#[account]
pub struct PartConfig {
    pub part_id: u64,
    pub mint: Pubkey,
    pub slot: u8,
    pub rarity: u8,
    pub max_supply: u64,
    pub mintable: bool,
    pub registered_at: i64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

#[account]
pub struct Minter {
    pub wallet: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

#[account]
pub struct AgentPermission {
    pub identity: Pubkey,
    pub agent: Pubkey,
    pub permissions: u8,
    pub bump: u8,
}

// ==================================================================
// 指令上下文
// ==================================================================

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = CONFIG_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// CHECK: PDA，仅作 mint authority 签名
    #[account(seeds = [b"mint-auth"], bump)]
    pub mint_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintIdentity<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: 手动初始化（需要 AlreadyHasDID 语义化错误）
    #[account(mut, seeds = [b"identity", owner.key().as_ref()], bump)]
    pub identity: UncheckedAccount<'info>,
    /// CHECK: 手动初始化（需要 NameTaken 语义化错误），地址在 ix 内按 name_hash 校验
    #[account(mut)]
    pub name_record: UncheckedAccount<'info>,
    /// CHECK: 新建的 token-2022 mint keypair
    #[account(mut)]
    pub mint: Signer<'info>,
    /// CHECK: owner ATA，程序内创建
    #[account(mut)]
    pub owner_ata: UncheckedAccount<'info>,
    /// CHECK: PDA mint authority
    #[account(seeds = [b"mint-auth"], bump = config.mint_auth_bump)]
    pub mint_auth: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// 可选:铸造费接收账户(仅当前阶梯费率>0 时必须传入,且必须等于 config.authority)。
    /// Option 占位约定:不需要时传程序 ID。追加在末尾保持与旧客户端前向兼容。
    #[account(mut)]
    pub fee_receiver: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct UpdatePersona<'info> {
    #[account(mut)]
    pub identity: Account<'info, Identity>,
    pub signer: Signer<'info>,
    /// 可选：agent 授权账户（agent 调用时传入）
    #[account(
        seeds = [b"agent-permission", identity.key().as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub agent_permission: Option<Account<'info, AgentPermission>>,
}

#[derive(Accounts)]
pub struct SetAgent<'info> {
    #[account(mut, seeds = [b"identity", identity.owner.as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: 被授权的 agent 钱包
    pub agent: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = AGENT_PERMISSION_SPACE,
        seeds = [b"agent-permission", identity.key().as_ref(), agent.key().as_ref()],
        bump,
    )]
    pub agent_permission: Account<'info, AgentPermission>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeAgent<'info> {
    #[account(mut, seeds = [b"identity", identity.owner.as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [b"agent-permission", identity.key().as_ref(), agent.key().as_ref()],
        bump = agent_permission.bump,
    )]
    pub agent_permission: Account<'info, AgentPermission>,
    /// CHECK: 用于 PDA 派生
    pub agent: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(part_id: u64, slot: u8, rarity: u8, max_supply: u64)]
pub struct RegisterPart<'info> {
    #[account(seeds = [b"config"], bump = config.bump, constraint = config.authority == authority.key() @ TinyWorldError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: 手动初始化（需要 PartAlreadyRegistered 语义化错误）
    #[account(mut, seeds = [b"part", part_id.to_le_bytes().as_ref()], bump)]
    pub part_config: UncheckedAccount<'info>,
    /// CHECK: 新建的 token-2022 mint keypair
    #[account(mut)]
    pub part_mint: Signer<'info>,
    /// CHECK: PDA mint authority
    #[account(seeds = [b"mint-auth"], bump = config.mint_auth_bump)]
    pub mint_auth: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(part_id: u64, mintable: bool)]
pub struct SetPartMintable<'info> {
    #[account(seeds = [b"config"], bump = config.bump, constraint = config.authority == authority.key() @ TinyWorldError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"part", part_id.to_le_bytes().as_ref()], bump = part_config.bump)]
    pub part_config: Account<'info, PartConfig>,
}

#[derive(Accounts)]
pub struct SetMinter<'info> {
    #[account(seeds = [b"config"], bump = config.bump, constraint = config.authority == authority.key() @ TinyWorldError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: 目标钱包
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = MINTER_SPACE,
        seeds = [b"minter", wallet.key().as_ref()],
        bump,
    )]
    pub minter: Account<'info, Minter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveMinter<'info> {
    #[account(seeds = [b"config"], bump = config.bump, constraint = config.authority == authority.key() @ TinyWorldError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, close = authority, seeds = [b"minter", minter.wallet.as_ref()], bump = minter.bump)]
    pub minter: Account<'info, Minter>,
}

#[derive(Accounts)]
#[instruction(part_id: u64, to: Pubkey, amount: u64)]
pub struct MintPart<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: 可选 Minter PDA，手动反序列化校验（authority 调用时可为任意地址）
    #[account(mut)]
    pub minter: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"part", part_id.to_le_bytes().as_ref()], bump = part_config.bump)]
    pub part_config: Account<'info, PartConfig>,
    #[account(mut, address = part_config.mint @ TinyWorldError::PartNotRegistered)]
    pub part_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: 接收方钱包
    pub to: UncheckedAccount<'info>,
    /// CHECK: to 的 ATA，程序内创建
    #[account(mut)]
    pub to_ata: UncheckedAccount<'info>,
    /// CHECK: PDA mint authority
    #[account(seeds = [b"mint-auth"], bump = config.mint_auth_bump)]
    pub mint_auth: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(part_id: u64, slot: u8)]
pub struct Equip<'info> {
    #[account(mut, seeds = [b"identity", identity.owner.as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [b"part", part_id.to_le_bytes().as_ref()], bump = part_config.bump)]
    pub part_config: Account<'info, PartConfig>,
    #[account(mut, address = part_config.mint @ TinyWorldError::PartNotRegistered)]
    pub part_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: signer 的装备 ATA（client 按 token-2022 派生）
    #[account(mut)]
    pub owner_ata: UncheckedAccount<'info>,
    /// CHECK: escrow ATA（owner = Identity PDA），程序内创建
    #[account(mut)]
    pub escrow_ata: UncheckedAccount<'info>,
    // 自动换装（EVM 语义）：插槽已占用时传入旧件退回所需账户
    #[account(mut)]
    pub old_part_mint: Option<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub old_escrow_ata: Option<UncheckedAccount<'info>>,
    #[account(mut)]
    pub old_owner_ata: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(slot: u8)]
pub struct Unequip<'info> {
    #[account(mut, seeds = [b"identity", identity.owner.as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,
    #[account(mut)]
    pub signer: Signer<'info>,
    /// 插槽持有的装备 mint（ix 内校验与 equipped[slot] 一致）
    #[account(mut)]
    pub part_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: escrow ATA（owner = Identity PDA）
    #[account(mut)]
    pub escrow_ata: UncheckedAccount<'info>,
    /// CHECK: owner ATA
    #[account(mut)]
    pub owner_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetMintTier<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.authority @ TinyWorldError::Unauthorized)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseIdentity<'info> {
    #[account(mut, close = signer, seeds = [b"identity", identity.owner.as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,
    /// 名字记录 PDA:与身份同寿。关闭身份必须同时释放名字(租金退回 owner),
    /// 否则名字被永久占用(主网上不可恢复)。seeds 校验确保就是该身份的名字记录。
    #[account(mut, close = signer, seeds = [b"name-record", identity.name_hash.as_ref()], bump = name_record.bump)]
    pub name_record: Account<'info, NameRecord>,
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, address = identity.mint)]
    pub identity_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: owner 身份 ATA
    #[account(mut)]
    pub owner_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ==================================================================
// 事件
// ==================================================================

#[event]
pub struct Minted {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub name: String,
}

#[event]
pub struct MintTierSet {
    pub tier1_fee: u64,
    pub tier2_fee: u64,
    pub tier3_fee: u64,
    pub tier2_start: u64,
    pub tier3_start: u64,
}

#[event]
pub struct PersonaUpdated {
    pub identity: Pubkey,
    pub persona_hash: [u8; 32],
}

#[event]
pub struct AgentSet {
    pub identity: Pubkey,
    pub agent: Pubkey,
    pub permissions: u8,
}

#[event]
pub struct AgentRevoked {
    pub identity: Pubkey,
    pub agent: Pubkey,
}

#[event]
pub struct PartRegistered {
    pub part_id: u64,
    pub slot: u8,
    pub rarity: u8,
    pub max_supply: u64,
}

#[event]
pub struct PartMintableUpdated {
    pub part_id: u64,
    pub mintable: bool,
}

#[event]
pub struct MinterUpdated {
    pub wallet: Pubkey,
    pub enabled: bool,
}

#[event]
pub struct PartMinted {
    pub part_id: u64,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Equipped {
    pub identity: Pubkey,
    pub slot: u8,
    pub part: Pubkey,
}

#[event]
pub struct Unequipped {
    pub identity: Pubkey,
    pub slot: u8,
    pub part: Pubkey,
}

#[event]
pub struct IdentityClosed {
    pub identity: Pubkey,
    pub owner: Pubkey,
}

// ==================================================================
// 错误
// ==================================================================

#[error_code]
pub enum TinyWorldError {
    #[msg("Name already taken")]
    NameTaken,
    #[msg("Account already has a DID")]
    AlreadyHasDID,
    #[msg("Invalid name length (1-64 bytes)")]
    InvalidName,
    #[msg("Invalid slot (0-3)")]
    InvalidSlot,
    #[msg("Provided old-part accounts do not match the equipped part")]
    SlotOccupied,
    #[msg("Slot mismatch between part and requested slot")]
    SlotMismatch,
    #[msg("Nothing equipped in this slot")]
    NothingEquipped,
    #[msg("Slots must be empty before closing identity")]
    SlotsNotEmpty,
    #[msg("Caller is not the token owner")]
    NotTokenOwner,
    #[msg("Part not registered")]
    PartNotRegistered,
    #[msg("Part already registered")]
    PartAlreadyRegistered,
    #[msg("Part is not mintable")]
    NotMintable,
    #[msg("Exceeds max supply")]
    ExceedsMaxSupply,
    #[msg("Max supply must be > 0")]
    InvalidMaxSupply,
    #[msg("Caller is not an authorized minter")]
    UnauthorizedMinter,
    #[msg("Invalid agent (zero address or zero permissions)")]
    InvalidAgent,
    #[msg("Invalid agent permission bits (only bit 0/1 allowed)")]
    InvalidAgentPermission,
    #[msg("Caller not authorized for this identity")]
    NotAuthorized,
    #[msg("Caller is not the program authority")]
    Unauthorized,
    #[msg("Invalid arweave id (empty or 43 chars of [A-Za-z0-9_-])")]
    InvalidArweaveId,
    #[msg("Provided ATA address does not match derived ATA")]
    InvalidAta,
    #[msg("init: account serialize failed")]
    InitSerializeFailed,
    #[msg("Mint fee receiver account is required when mint fee is enabled")]
    MintFeeReceiverRequired,
    #[msg("Fee receiver must equal config authority")]
    InvalidFeeReceiver,
    #[msg("Invalid mint tier config (require tier2_start < tier3_start)")]
    InvalidTier,
}

// ==================================================================
// 内部辅助
// ==================================================================

fn to_lower(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .map(|&c| if c.is_ascii_uppercase() { c + 32 } else { c })
        .collect()
}

fn validate_arweave_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Ok(());
    }
    require!(id.len() == ARWEAVE_ID_LEN, TinyWorldError::InvalidArweaveId);
    require!(
        id.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        TinyWorldError::InvalidArweaveId
    );
    Ok(())
}

/// 计算带扩展的 mint 账户空间
fn mint_space_with_extensions(extensions: &[ExtensionType]) -> Result<usize> {
    ExtensionType::try_calculate_account_len::<SplMint>(extensions)
        .map_err(|_| Error::from(ProgramError::InvalidAccountData))
}

/// system_program 创建 mint 账户（空间含扩展，owner = token-2022 程序）
fn create_mint_account<'info>(
    mint: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    extensions: &[ExtensionType],
    token_program: Pubkey,
) -> Result<()> {
    let space = mint_space_with_extensions(extensions)?;
    let lamports = Rent::get()?.minimum_balance(space);
    let ix = anchor_lang::solana_program::system_instruction::create_account(
        &payer.key(),
        &mint.key(),
        lamports,
        space as u64,
        &token_program,
    );
    invoke(&ix, &[payer.clone(), mint.clone(), system_program.clone()])?;
    Ok(())
}

fn invoke_initialize_non_transferable<'info>(mint: &AccountInfo<'info>, token_program: Pubkey) -> Result<()> {
    let ix = spl_token_2022::instruction::initialize_non_transferable_mint(
        &token_program,
        mint.key,
    )?;
    invoke(&ix, &[mint.clone()])?;
    Ok(())
}

fn invoke_initialize_mint<'info>(
    mint: &AccountInfo<'info>,
    mint_authority: &AccountInfo<'info>,
    token_program: Pubkey,
) -> Result<()> {
    // initialize_mint2：无需 Rent sysvar 账户（老版 initialize_mint 需要传入）
    let ix = spl_token_2022::instruction::initialize_mint2(
        &token_program,
        mint.key,
        mint_authority.key,
        None,
        0,
    )?;
    invoke(&ix, &[mint.clone()])?;
    Ok(())
}

fn invoke_mint_to<'info>(
    mint: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    token_program: Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::mint_to(
        &token_program,
        mint.key,
        ata.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke_signed(
        &ix,
        &[mint.clone(), ata.clone(), authority.clone()],
        signer_seeds,
    )?;
    Ok(())
}

fn invoke_transfer<'info>(
    mint: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    token_program: Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::transfer_checked(
        &token_program,
        from.key,
        mint.key,
        to.key,
        authority.key,
        &[],
        amount,
        0,
    )?;
    invoke_signed(
        &ix,
        &[
            from.clone(),
            mint.clone(),
            to.clone(),
            authority.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

/// SOL 转账(铸造费):from 必须签名;to 可为链上未初始化账户(系统自动创建)
fn transfer_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    let ix =
        anchor_lang::solana_program::system_instruction::transfer(from.key, to.key, lamports);
    invoke(&ix, &[from.clone(), to.clone(), system_program.clone()])?;
    Ok(())
}

fn invoke_burn<'info>(    mint: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    token_program: Pubkey,
) -> Result<()> {
    let ix = spl_token_2022::instruction::burn_checked(
        &token_program,
        ata.key,
        mint.key,
        authority.key,
        &[],
        amount,
        0,
    )?;
    invoke(&ix, &[ata.clone(), mint.clone(), authority.clone()])?;
    Ok(())
}

fn invoke_close_account<'info>(
    ata: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: Pubkey,
) -> Result<()> {
    let ix = spl_token_2022::instruction::close_account(
        &token_program,
        ata.key,
        destination.key,
        authority.key,
        &[],
    )?;
    invoke(&ix, &[ata.clone(), destination.clone(), authority.clone()])?;
    Ok(())
}

/// 幂等创建 ATA（token-2022，地址由 client 派生传入并在此校验）
fn create_ata_idempotent<'info>(
    ata: &AccountInfo<'info>,
    wallet: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    if !ata.data_is_empty() {
        return Ok(());
    }
    let (expected, _) = Pubkey::find_program_address(
        &[
            wallet.key.as_ref(),
            token_program.key.as_ref(),
            mint.key.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    );
    require!(ata.key() == expected, TinyWorldError::InvalidAta);
    // associated token program 的 create 指令：data 为空，按序传账户
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: anchor_spl::associated_token::ID,
        accounts: vec![
            AccountMeta::new(payer.key(), true),
            AccountMeta::new(ata.key(), false),
            AccountMeta::new_readonly(wallet.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new_readonly(system_program.key(), false),
            AccountMeta::new_readonly(token_program.key(), false),
        ],
        data: vec![],
    };
    invoke(
        &ix,
        &[
            payer.clone(),
            ata.clone(),
            wallet.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
    )?;
    Ok(())
}

/// 手动初始化程序账户：create_account（PDA 经 invoke_signed 签名）+ 写 discriminator + 序列化
fn init_program_account<'info, T: AccountSerialize + AccountDeserialize + Discriminator>(
    target: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    signer_seeds: &[&[&[u8]]],
    data: &T,
) -> Result<()> {
    let lamports = Rent::get()?.minimum_balance(space);
    let ix = anchor_lang::solana_program::system_instruction::create_account(
        &payer.key(),
        &target.key(),
        lamports,
        space as u64,
        &crate::ID,
    );
    invoke_signed(
        &ix,
        &[payer.clone(), target.clone(), system_program.clone()],
        signer_seeds,
    )?;
    let mut target_data = target.try_borrow_mut_data()?;
    let mut cursor = Cursor::new(&mut target_data[..]);
    // try_serialize 内部已包含 discriminator 写入（anchor 0.31），此处不再重复写
    data.try_serialize(&mut cursor)
        .map_err(|_| TinyWorldError::InitSerializeFailed)?;
    Ok(())
}

