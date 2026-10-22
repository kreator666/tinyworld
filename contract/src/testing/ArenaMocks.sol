// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 测试用 6  decimals 稳定币 mock(模拟 USDC)。
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice 测试用 DeFi 协议 mock:提供 whitelist 目标(存入/取出),供 ArenaAccount.execute 白名单校验测试。
contract MockProtocol {
    mapping(address => uint256) public balanceOf;
    uint256 public constant CONVERSION = 2; // 1 USDC 存出 2 份额,便于断言头寸变化

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    function deposit(address token, uint256 amount) external returns (uint256 shares) {
        require(amount > 0, "zero amount");
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom failed");
        shares = amount * CONVERSION;
        balanceOf[msg.sender] += shares;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(address token, uint256 shares) external returns (uint256 amount) {
        require(balanceOf[msg.sender] >= shares, "insufficient shares");
        balanceOf[msg.sender] -= shares;
        amount = shares / CONVERSION;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", msg.sender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
}
