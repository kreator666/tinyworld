// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArenaAccount} from "./interfaces/IArenaAccount.sol";

/// @title ArenaSeason
/// @notice 竞技场赛季注册与治理合约(每个赛季部署一个实例,实现共享 UUPS 实现)。
/// 职责:
///   1. 报名注册:owner 支付 principalUsd(进 per-agent ArenaAccount)+ fuelUsd(进平台燃料池),
///      为每个参赛 agent 克隆一个 ArenaAccount;
///   2. 白名单治理:allowedCalls[target][selector] 是资金出口的唯一链上裁决,ArenaAccount.execute 逐笔校验;
///   3. 结算登记:到期(或账户被 owner 冻结)后登记最终净值,驱动 ArenaAccount 解锁 owner 提取。
/// 排行榜数据链上可验证;排序由前端完成,链上只存原始结果。
contract ArenaSeason is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    struct Participant {
        address owner;
        address account;
        uint256 agentTokenId;
        uint256 principal; // 实际入账本金(6 decimals)
        uint256 navUsd; // 结算净值;0 = 未结算
        bool settled;
        bool exists;
    }

    IERC20 public usdc;
    /// @notice ArenaAccount 实现地址,报名时为每个参赛者克隆一个最小代理实例
    address public accountImplementation;
    /// @notice 平台执行地址(agent 热钱包),克隆账户时写入
    address public executor;
    /// @notice 平台燃料池地址,报名时的 fuelUsd 直接划入(燃料精确记账在链下,定期链上摘要)
    address public feeRecipient;

    uint256 public principalUsd; // 竞技本金(6 decimals)
    uint256 public fuelUsd; // token 燃料费(6 decimals)
    uint64 public startTime;
    uint64 public endTime;
    /// @notice 管理员熔断:净值快照完成后置 true,所有账户停止新开交易
    bool public tradingHalted;

    /// @notice 目标合约 => 方法选择器 => 是否允许(资金出口白名单,精确到方法级)
    mapping(address => mapping(bytes4 => bool)) public allowedCalls;

    Participant[] internal _participants;
    mapping(address account => uint256 indexPlusOne) internal _accountIndex;

    error ZeroAddress();
    error AlreadyRegistered(address account);
    error RegistrationClosed();
    error NotParticipant(address account);
    error TransferFailed();
    error AlreadySettled();
    error SettlementNotOpen();
    error NothingToSettle();
    error Halted();

    event Registered(
        address indexed owner, address indexed account, uint256 indexed agentTokenId, uint256 principal, uint256 fuel
    );
    event AllowedCallUpdated(address indexed target, bytes4 indexed selector, bool allowed);
    event ExecutorUpdated(address indexed executor);
    event FeeRecipientUpdated(address indexed feeRecipient);
    event TimesUpdated(uint64 startTime, uint64 endTime);
    event TradingHalted();
    event ResultRecorded(address indexed account, uint256 navUsd);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address usdc_,
        address accountImplementation_,
        address executor_,
        address feeRecipient_,
        uint256 principalUsd_,
        uint256 fuelUsd_,
        uint64 startTime_,
        uint64 endTime_
    ) public initializer {
        if (
            owner_ == address(0) || usdc_ == address(0) || accountImplementation_ == address(0)
                || executor_ == address(0) || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (endTime_ <= startTime_) revert RegistrationClosed();
        __Ownable_init(owner_);
        usdc = IERC20(usdc_);
        accountImplementation = accountImplementation_;
        executor = executor_;
        feeRecipient = feeRecipient_;
        principalUsd = principalUsd_;
        fuelUsd = fuelUsd_;
        startTime = startTime_;
        endTime = endTime_;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ------------------------------------------------------------------
    // 报名注册
    // ------------------------------------------------------------------

    /// @notice 报名参赛:支付 principal+fuel,为该 agent 克隆一个 ArenaAccount 并注入本金。
    /// 赛季未结束前随时可加入(中途加入者从本金起步,玩到赛季结束);
    /// 开始时间(startTime)只控制交易窗口,不再控制报名。
    /// @param agentTokenId 参赛 agent 的身份 tokenId(仅作元数据登记,合约不校验归属,归属校验在服务端)
    function register(uint256 agentTokenId) external returns (address account) {
        if (block.timestamp >= endTime) revert RegistrationClosed();
        account = Clones.clone(accountImplementation);
        IArenaAccount(account).initialize(msg.sender, executor, address(this));
        _participants.push(
            Participant({
                owner: msg.sender,
                account: account,
                agentTokenId: agentTokenId,
                principal: principalUsd,
                navUsd: 0,
                settled: false,
                exists: true
            })
        );
        _accountIndex[account] = _participants.length;
        // 本金直接注入账户;燃料划入平台燃料池。任一步失败整笔回滚,不存在半注册状态。
        usdc.transferFrom(msg.sender, account, principalUsd);
        if (fuelUsd > 0) usdc.transferFrom(msg.sender, feeRecipient, fuelUsd);
        emit Registered(msg.sender, account, agentTokenId, principalUsd, fuelUsd);
    }

    // ------------------------------------------------------------------
    // 白名单治理(资金出口的唯一链上裁决)
    // ------------------------------------------------------------------

    function setAllowedCall(address target, bytes4 selector, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedCalls[target][selector] = allowed;
        emit AllowedCallUpdated(target, selector, allowed);
    }

    function setAllowedCalls(address[] calldata targets, bytes4[] calldata selectors, bool[] calldata allowed)
        external
        onlyOwner
    {
        uint256 n = targets.length;
        if (n == 0 || selectors.length != n || allowed.length != n) revert ZeroAddress();
        for (uint256 i = 0; i < n; ++i) {
            if (targets[i] == address(0)) revert ZeroAddress();
            allowedCalls[targets[i]][selectors[i]] = allowed[i];
            emit AllowedCallUpdated(targets[i], selectors[i], allowed[i]);
        }
    }

    function isAllowedCall(address target, bytes4 selector) external view returns (bool) {
        return allowedCalls[target][selector];
    }

    /// @notice 赛季窗口:开始时间已到且未被管理员熔断。到期不自动关闭——
    /// 头寸需要平仓窗口,由管理员快照完净值后 haltTrading 统一熔断。
    function isTradingOpen() external view returns (bool) {
        return block.timestamp >= startTime && !tradingHalted;
    }

    // ------------------------------------------------------------------
    // 管理:参数调整(均在报名/开赛前的配置期使用)
    // ------------------------------------------------------------------

    function setExecutor(address executor_) external onlyOwner {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
        emit ExecutorUpdated(executor_);
    }

    function setFeeRecipient(address feeRecipient_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        emit FeeRecipientUpdated(feeRecipient_);
    }

    function setTimes(uint64 startTime_, uint64 endTime_) external onlyOwner {
        if (endTime_ <= startTime_) revert RegistrationClosed();
        startTime = startTime_;
        endTime = endTime_;
        emit TimesUpdated(startTime_, endTime_);
    }

    /// @notice 提取合约内滞留的 ERC-20(燃料在注册时直付 feeRecipient,正常不会滞留;
    /// 此方法用于救援误转入的代币或极端情况下的燃料结余)。onlyOwner。
    function withdrawFee(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @notice 管理员熔断:净值快照完成后调用,所有账户停止新开交易(平仓白名单调用不受限——
    /// 白名单粒度在 setAllowedCall 控制,如需只留平仓方法可提前调整白名单再熔断)。
    function haltTrading() external onlyOwner {
        if (tradingHalted) revert Halted();
        tradingHalted = true;
        emit TradingHalted();
    }

    // ------------------------------------------------------------------
    // 结算登记
    // ------------------------------------------------------------------

    function participantCount() external view returns (uint256) {
        return _participants.length;
    }

    function participants(uint256 index) external view returns (Participant memory) {
        return _participants[index];
    }

    function participantOf(address account) external view returns (Participant memory) {
        uint256 idx = _accountIndex[account];
        if (idx == 0) revert NotParticipant(account);
        return _participants[idx - 1];
    }

    /// @notice 登记某个账户的结算净值,并驱动该账户解锁 owner 提取。
    /// 触发条件:赛季已到期,或该账户已被 owner 紧急冻结(退赛)。
    /// @param navUsd 结算净值(USDC 计价,6 decimals),由平台预言机/快照服务计算
    function recordResult(address account, uint256 navUsd) external onlyOwner {
        uint256 idx = _accountIndex[account];
        if (idx == 0) revert NotParticipant(account);
        Participant storage p = _participants[idx - 1];
        if (p.settled) revert AlreadySettled();
        bool ownerFrozen = IArenaAccount(account).phase() == IArenaAccount.Phase.Frozen;
        if (!(block.timestamp >= endTime || ownerFrozen)) revert SettlementNotOpen();
        p.navUsd = navUsd;
        p.settled = true;
        IArenaAccount(account).settle(navUsd);
        emit ResultRecorded(account, navUsd);
    }
}
