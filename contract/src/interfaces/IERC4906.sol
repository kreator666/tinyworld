// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IERC4906 — ERC-721 Metadata Update Extension (EIP-4906 final)
interface IERC4906 is IERC165 {
    /// @dev Emitted when the metadata of a token is changed (e.g. 换装后刷新市场展示)
    event MetadataUpdate(uint256 _tokenId);

    /// @dev Emitted when the metadata of a range of tokens is changed
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
}
