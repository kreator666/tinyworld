// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDIDParts} from "./interfaces/IDIDParts.sol";

/// @title PartsMarket
/// @notice 装备铸造直售市场(P2C):平台铸新品卖给用户,原生币计价(chain-agnostic,不绑定任何链),
/// maxSupply 硬顶由 DIDParts.mintPart 内部保证(总量超限整笔回滚),天然防超卖。
/// 价格一律链上为准(listPriceOf);owner 上架/改价/下架/提款,买家精确等值支付(不找零,防误付)。
contract PartsMarket {
    IDIDParts public immutable parts;
    address public owner;

    /// @notice partId => 原生币 wei 单价;0 = 未上架
    mapping(uint256 id => uint256 price) public listPrice;

    error NotOwner(address account);
    error NotListed(uint256 id);
    error WrongValue(uint256 expect, uint256 got);
    error PartNotMintable(uint256 id);
    error InvalidQuantity();
    error InvalidPrice();
    error TransferFailed();

    event PriceUpdated(uint256 indexed id, uint256 price);
    event Sold(address indexed buyer, uint256 indexed id, uint256 quantity, uint256 price);

    constructor(address parts_) {
        parts = IDIDParts(parts_);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    // ------------------------------------------------------------------
    // 管理:上架/改价/下架
    // ------------------------------------------------------------------

    /// @notice 单件上架或改价;price = 0 表示下架
    function setPrice(uint256 id, uint256 price) external onlyOwner {
        listPrice[id] = price;
        emit PriceUpdated(id, price);
    }

    /// @notice 批量上架/改价(等长数组,整体原子)
    function setPrices(uint256[] calldata ids, uint256[] calldata prices) external onlyOwner {
        uint256 n = ids.length;
        if (n == 0 || prices.length != n) revert InvalidPrice();
        for (uint256 i = 0; i < n; ++i) {
            listPrice[ids[i]] = prices[i];
            emit PriceUpdated(ids[i], prices[i]);
        }
    }

    // ------------------------------------------------------------------
    // 购买与提款
    // ------------------------------------------------------------------

    /// @notice 直售购买:平台铸 quantity 份到买家钱包;须精确等值支付(price * quantity,不找零)
    function buy(uint256 id, uint256 quantity) external payable {
        if (quantity == 0) revert InvalidQuantity();
        uint256 price = listPrice[id];
        if (price == 0) revert NotListed(id);
        uint256 expect = price * quantity;
        if (msg.value != expect) revert WrongValue(expect, msg.value);
        // registered / mintable / maxSupply 硬顶都在 mintPart 内校验,超限整笔回滚
        parts.mintPart(msg.sender, id, quantity);
        emit Sold(msg.sender, id, quantity, price);
    }

    /// @notice 提取合约全部销售所得到 owner
    function withdraw() external onlyOwner {
        uint256 amount = address(this).balance;
        (bool ok,) = owner.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice 当前上架单价(0 = 未上架)
    function listPriceOf(uint256 id) external view returns (uint256) {
        return listPrice[id];
    }

    /// @notice 转让管理权(对齐 OZ Ownable 语义,当前环境用不到多签,保留口子)
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert NotOwner(newOwner);
        owner = newOwner;
    }
}
