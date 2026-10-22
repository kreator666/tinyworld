// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArenaSeason} from "./interfaces/IArenaSeason.sol";

/// @title ArenaAccount
/// @notice 竞技场 per-agent 智能账户:owner 自费出资的竞技资金托管账户。
/// 安全模型 = 资金出口收敛:executor(平台热钱包)只能向"赛季白名单协议的白名单方法"发交易,
/// 裸转账/白名单外目标在链上 revert;owner 不碰日常交易,但保留 freeze(紧急停止)与结算后 withdraw。
/// 头寸(Aave aToken、GMX 仓位等)挂在本合约地址下,净值按地址归因,排行榜天然清晰。
contract ArenaAccount is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    enum Phase {
        Active, // 赛季中,executor 可执行白名单交易
        Frozen, // owner 紧急停止,只等结算
        Settled // 已结算,owner 可提取剩余
    }

    IArenaSeason public season;
    address public executor;
    Phase public phase;
    /// @notice 结算净值(USDC 计价,6 decimals),由赛季合约结算时写入
    uint256 public settledNavUsd;

    error ZeroAddress();
    error NotAuthorized();
    error NotActive();
    error NotSettled();
    error AlreadySettled();
    error InvalidTarget();
    error TradingClosed();
    error CallNotAllowed(address target, bytes4 selector);
    error ExecutionFailed(bytes reason);

    event ExecutorUpdated(address indexed executor);
    event Frozen();
    event Settled(uint256 navUsd);
    error WithdrawFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address executor_, address season_) public initializer {
        if (owner_ == address(0) || executor_ == address(0) || season_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        executor = executor_;
        season = IArenaSeason(season_);
        phase = Phase.Active;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotAuthorized();
        _;
    }

    // ------------------------------------------------------------------
    // 执行:executor 经赛季白名单与赛季窗口约束调用外部协议
    // ------------------------------------------------------------------

    /// @notice 轮换执行地址。主路径是赛季管理员(平台轮换热钱包);owner 也可自救轮换。
    function setExecutor(address executor_) external {
        if (msg.sender != owner() && msg.sender != address(season)) revert NotAuthorized();
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
        emit ExecutorUpdated(executor_);
    }

    /// @notice 向白名单协议的白名单方法发起一笔调用(价值出口唯一路径之一)。
    /// @param target 协议合约地址,必须在赛季白名单内
    /// @param value 附带原生币(仅白名单方法可携带,如协议需 AVAX 抵押)
    function execute(address target, uint256 value, bytes calldata data) external onlyExecutor returns (bytes memory) {
        if (phase != Phase.Active) revert NotActive();
        if (target == address(0) || target == address(this)) revert InvalidTarget();
        bytes4 selector = bytes4(data);
        if (!season.isAllowedCall(target, selector)) revert CallNotAllowed(target, selector);
        if (!season.isTradingOpen()) revert TradingClosed();
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert ExecutionFailed(ret);
        return ret;
    }

    /// @notice 接收协议退回的原生币(如 DEX swapExactTokensForAVAX 输出)。
    receive() external payable {}

    // ------------------------------------------------------------------
    // owner 制衡:紧急停止 / 结算后取回
    // ------------------------------------------------------------------

    /// @notice owner 紧急停止:立即停止一切执行,进入等待结算。
    function freeze() external onlyOwner {
        if (phase != Phase.Active) revert AlreadySettled();
        phase = Phase.Frozen;
        emit Frozen();
    }

    /// @notice 由赛季合约在结算时调用,登记最终净值并解锁提取。
    function settle(uint256 navUsd) external {
        if (msg.sender != address(season)) revert NotAuthorized();
        if (phase == Phase.Settled) revert AlreadySettled();
        phase = Phase.Settled;
        settledNavUsd = navUsd;
        emit Settled(navUsd);
    }

    /// @notice 结算后取回指定 ERC-20 全部余额(只能流向 owner,堵死最后一道出口)。
    function withdraw(address token) external onlyOwner {
        if (phase != Phase.Settled) revert NotSettled();
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) {
            (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (owner(), amount)));
            if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert WithdrawFailed();
        }
    }

    /// @notice 结算后取回全部原生币余额。
    function withdrawNative() external onlyOwner {
        if (phase != Phase.Settled) revert NotSettled();
        uint256 amount = address(this).balance;
        if (amount > 0) {
            (bool ok, ) = owner().call{value: amount}("");
            if (!ok) revert WithdrawFailed();
        }
    }
}
